//! External air-quality service adapter. Wallet and purchase state stay in the coordinator.
use allowit_sdk::service::*;
use reqwest::{blocking::Client, redirect::Policy as RedirectPolicy};
use serde_json::Value;
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

pub struct GoogleAirQuality {
    pub key: String,
    pub client: Client,
}
impl GoogleAirQuality {
    pub fn from_env(env: &Environment) -> Result<Option<Self>> {
        if !env.present("GOOGLE_AIR_QUALITY_API_KEY") {
            return Ok(None);
        }
        Ok(Some(Self {
            key: env.get("GOOGLE_AIR_QUALITY_API_KEY").into(),
            client: air_quality_client()?,
        }))
    }
}
impl GoogleAirQuality {
    pub fn validate_input(&self, input: &Value) -> Result<()> {
        validate_air_quality_input(input)
    }
    pub fn lookup(&self, input: &Value) -> Result<Value> {
        let response = self
            .request(input)?
            .send()
            .map_err(|_| fault(503, "Air quality response is unknown."))?;
        decode_air_quality_response(response.status(), response)
    }
    fn request(&self, input: &Value) -> Result<reqwest::blocking::RequestBuilder> {
        self.validate_input(input)?;
        Ok(self
            .client
            .post("https://airquality.googleapis.com/v1/currentConditions:lookup")
            .header("X-Goog-Api-Key", &self.key)
            .json(input))
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

impl Upstream for GoogleAirQuality {
    fn validate_input(&self, input: &Value) -> Result<()> {
        self.validate_input(input)
    }
    fn invoke(&self, context: &Invocation<'_>) -> Result<Value> {
        if context.service_id == "native-paysh-testnet-compatibility" {
            return Err(fault(
                503,
                "Native validation fixtures do not purchase Google delivery.",
            ));
        }
        self.lookup(context.input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn request_preserves_fixed_endpoint_key_header_and_exact_validated_body() {
        let provider = GoogleAirQuality {
            key: "non-network-test-key".into(),
            client: air_quality_client().unwrap(),
        };
        let input = json!({"location":{"latitude":1,"longitude":2},"universalAqi":false});
        let request = provider.request(&input).unwrap().build().unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://airquality.googleapis.com/v1/currentConditions:lookup"
        );
        assert_eq!(request.headers()["X-Goog-Api-Key"], "non-network-test-key");
        assert_eq!(
            serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(),
            input
        );
        assert!(
            provider
                .request(
                    &json!({"location":{"latitude":1,"longitude":2},"url":"https://caller.example"})
                )
                .is_err()
        );
    }
    #[test]
    fn response_status_json_and_size_bounds_are_preserved() {
        let mut body = br#"{"current":{"us_aqi":42}}"#.to_vec();
        body.resize(65536, b' ');
        assert_eq!(
            decode_air_quality_response(reqwest::StatusCode::OK, body.as_slice()).unwrap()["current"]
                ["us_aqi"],
            42
        );
        body.push(b' ');
        assert!(decode_air_quality_response(reqwest::StatusCode::OK, body.as_slice()).is_err());
        assert!(
            decode_air_quality_response(reqwest::StatusCode::OK, b"invalid".as_slice()).is_err()
        );
        assert!(
            decode_air_quality_response(reqwest::StatusCode::TOO_MANY_REQUESTS, b"{}".as_slice())
                .is_err()
        );
    }
}
