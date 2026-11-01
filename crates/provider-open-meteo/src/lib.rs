//! External air-quality service adapter. Wallet and purchase state stay in the coordinator.
use allowit_sdk::service::*;
use reqwest::{blocking::Client, redirect::Policy as RedirectPolicy};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};
fn air_quality_client() -> Result<Client> {
    Client::builder()
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(20))
        .redirect(RedirectPolicy::none())
        .build()
        .map_err(|_| fault(503, "Air quality transport unavailable."))
}

pub fn decode_air_quality_response(status: reqwest::StatusCode, body: impl Read) -> Result<Value> {
    if !status.is_success() {
        return Err(fault(
            503,
            "Air quality provider could not complete this lookup.",
        ));
    }
    let mut bytes = vec![];
    body.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| fault(503, "Air quality response is unknown."))?;
    if bytes.len() > 65536 {
        return Err(fault(503, "Air quality response exceeds supported size."));
    }
    serde_json::from_slice(&bytes).map_err(|_| fault(503, "Air quality response is invalid."))
}

/// Bounded Open-Meteo air-quality transport.
pub struct OpenMeteoAirQuality {
    client: Client,
}
impl OpenMeteoAirQuality {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: air_quality_client()?,
        })
    }
}
impl OpenMeteoAirQuality {
    pub fn validate_input(&self, input: &Value) -> Result<()> {
        validate_air_quality_input(input)
    }
    pub fn lookup(&self, input: &Value) -> Result<Value> {
        let response = self
            .request(input)?
            .send()
            .map_err(|_| fault(503, "Air quality response is unknown."))?;
        let data = decode_air_quality_response(response.status(), response)?;
        let current = &data["current"];
        if !current["time"].is_string()
            || ["us_aqi", "pm2_5", "pm10"].iter().any(|field| {
                !current[field]
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v >= 0.0)
            })
        {
            return Err(fault(
                503,
                "Air quality response has no current conditions.",
            ));
        }
        let data = json!({"current":{"time":current["time"],"us_aqi":current["us_aqi"],"pm2_5":current["pm2_5"],"pm10":current["pm10"]},"current_units":{"us_aqi":"USA AQI","pm2_5":"μg/m³","pm10":"μg/m³"}});
        Ok(
            json!({"provider":"Open-Meteo","attribution":"Air quality data: Open-Meteo and CAMS, CC BY 4.0","source":"https://open-meteo.com/en/docs/air-quality-api","data":data}),
        )
    }
    fn request(&self, input: &Value) -> Result<reqwest::blocking::RequestBuilder> {
        self.validate_input(input)?;
        Ok(self
            .client
            .get("https://air-quality-api.open-meteo.com/v1/air-quality")
            .query(&[
                ("latitude", input["location"]["latitude"].to_string()),
                ("longitude", input["location"]["longitude"].to_string()),
                ("current", "us_aqi,pm2_5,pm10".into()),
            ]))
    }
}

pub fn validate_air_quality_input(input: &Value) -> Result<()> {
    let object = input
        .as_object()
        .ok_or_else(|| bad("Air quality input must be an object."))?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "location" | "universalAqi"))
        || input.get("universalAqi").is_some_and(|v| !v.is_boolean())
    {
        return Err(bad("Unsupported air quality parameters."));
    }
    let location = input["location"]
        .as_object()
        .ok_or_else(|| bad("Provide latitude and longitude."))?;
    let latitude = input["location"]["latitude"].as_f64();
    let longitude = input["location"]["longitude"].as_f64();
    if location.len() != 2
        || !latitude.is_some_and(|v| v.is_finite() && (-90.0..=90.0).contains(&v))
        || !longitude.is_some_and(|v| v.is_finite() && (-180.0..=180.0).contains(&v))
    {
        return Err(bad("Provide valid latitude and longitude."));
    }
    Ok(())
}

impl OpenMeteoAirQuality {
    pub fn for_gateway(
        env: &Environment,
        network: &str,
        native_network: &str,
        service_id: &str,
    ) -> Result<Self> {
        if env.get("VERCEL_ENV") == "production"
            || network != native_network
            || service_id != "testnet-open-meteo-air-quality"
        {
            return Err(bad("Open-Meteo demo requires a matching Testnet Preview."));
        }
        Self::for_testnet(network)
    }
    pub fn for_testnet(network: &str) -> Result<Self> {
        if network != "solana:testnet" {
            return Err(bad("Open-Meteo demo delivery requires Solana Testnet."));
        }
        Self::new()
    }
}
impl Upstream for OpenMeteoAirQuality {
    fn validate_input(&self, input: &Value) -> Result<()> {
        self.validate_input(input)
    }
    fn invoke(&self, context: &Invocation<'_>) -> Result<Value> {
        if context.network != "solana:testnet"
            || context.service_id != "testnet-open-meteo-air-quality"
        {
            return Err(bad("Use the configured Testnet air-quality service."));
        }
        self.lookup(context.input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_preserves_fixed_endpoint_coordinates_and_measurements() {
        let provider = OpenMeteoAirQuality::for_testnet("solana:testnet").unwrap();
        let request = provider
            .request(&json!({"location":{"latitude":1,"longitude":2}}))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(
            request.url().host_str(),
            Some("air-quality-api.open-meteo.com")
        );
        assert_eq!(request.url().path(), "/v1/air-quality");
        assert_eq!(
            request
                .url()
                .query_pairs()
                .collect::<std::collections::BTreeMap<_, _>>(),
            [
                ("latitude".into(), "1".into()),
                ("longitude".into(), "2".into()),
                ("current".into(), "us_aqi,pm2_5,pm10".into())
            ]
            .into()
        );
        assert!(request.body().is_none());
    }
    #[test]
    fn decoder_enforces_status_json_and_exact_response_size_boundaries() {
        let mut body = br#"{"current":{"us_aqi":42}}"#.to_vec();
        body.resize(65536, b' ');
        assert_eq!(
            decode_air_quality_response(reqwest::StatusCode::OK, body.as_slice()).unwrap()["current"]
                ["us_aqi"],
            42
        );
        body.push(b' ');
        assert!(
            decode_air_quality_response(reqwest::StatusCode::OK, body.as_slice())
                .unwrap_err()
                .message
                .contains("exceeds")
        );
        assert!(
            decode_air_quality_response(reqwest::StatusCode::OK, b"invalid".as_slice()).is_err()
        );
        assert!(
            decode_air_quality_response(reqwest::StatusCode::TOO_MANY_REQUESTS, b"{}".as_slice())
                .is_err()
        );
    }
}
