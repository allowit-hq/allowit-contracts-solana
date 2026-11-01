//! Typed library facade for service vendors. It does not invoke a CLI or backend.
pub use allowit_sdk::service::*;
use serde_json::Value;
use std::sync::Arc;

pub mod catalog {
    pub use allowit_vendor_paysh_catalog::operator_catalog;
}

/// Select only deployment-configured service vendors.
pub fn upstream_from_env(
    env: &Environment,
    network: &str,
    native_network: &str,
    service_id: &str,
) -> Result<Option<Arc<dyn Upstream>>> {
    match env.get("ALLOWIT_PAYSH_UPSTREAM") {
        "open-meteo" => Ok(Some(Arc::new(
            allowit_vendor_open_meteo::OpenMeteoAirQuality::for_gateway(
                env,
                network,
                native_network,
                service_id,
            )?,
        ))),
        "" | "google-air-quality" => Ok(
            allowit_vendor_google_air_quality::GoogleAirQuality::from_env(env)?
                .map(|value| Arc::new(value) as Arc<dyn Upstream>),
        ),
        _ => Err(bad("Configure a supported service upstream.")),
    }
}

/// Validate an SDK-owned function catalog entry before payment preparation.
pub fn validate_service_input(service_id: &str, input: &Value) -> Result<()> {
    match service_id {
        "google-airquality-current" | "google-air-quality" => {
            allowit_vendor_google_air_quality::validate_air_quality_input(input)
        }
        "testnet-open-meteo-air-quality" => {
            allowit_vendor_open_meteo::validate_air_quality_input(input)
        }
        _ => Err(bad("The configured service has no SDK input validator.")),
    }
}
