use allowit_solana_service_upstreams::{
    Environment, Invocation, Upstream, upstream_from_env, validate_service_input,
};
use serde_json::json;
use std::collections::BTreeMap;

fn configuration(values: &[(&str, &str)]) -> Environment {
    Environment(
        values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>(),
    )
}

#[test]
fn configured_testnet_vendor_rejects_mismatched_context_before_network() {
    let env = configuration(&[
        ("ALLOWIT_PAYSH_UPSTREAM", "open-meteo"),
        ("VERCEL_ENV", "preview"),
    ]);
    for (network, native, service) in [
        (
            "solana:mainnet",
            "solana:mainnet",
            "testnet-open-meteo-air-quality",
        ),
        (
            "solana:testnet",
            "solana:mainnet",
            "testnet-open-meteo-air-quality",
        ),
        ("solana:testnet", "solana:testnet", "other"),
    ] {
        assert!(upstream_from_env(&env, network, native, service).is_err());
    }
    let upstream = upstream_from_env(
        &env,
        "solana:testnet",
        "solana:testnet",
        "testnet-open-meteo-air-quality",
    )
    .unwrap()
    .unwrap();
    let input = json!({"location":{"latitude":1,"longitude":2}});
    assert!(
        upstream
            .invoke(&Invocation {
                service_id: "other",
                network: "solana:testnet",
                operation_id: "bound-operation",
                input: &input
            })
            .is_err()
    );
    assert!(
        upstream
            .invoke(&Invocation {
                service_id: "testnet-open-meteo-air-quality",
                network: "solana:mainnet",
                operation_id: "bound-operation",
                input: &input
            })
            .is_err()
    );
}

#[test]
fn deployment_production_guard_and_missing_credential_are_preserved() {
    let production = configuration(&[
        ("ALLOWIT_PAYSH_UPSTREAM", "open-meteo"),
        ("VERCEL_ENV", "production"),
    ]);
    assert!(
        upstream_from_env(
            &production,
            "solana:testnet",
            "solana:testnet",
            "testnet-open-meteo-air-quality"
        )
        .is_err()
    );
    assert!(
        upstream_from_env(
            &Environment::default(),
            "solana:mainnet",
            "solana:mainnet",
            "google-airquality-current"
        )
        .unwrap()
        .is_none()
    );
    let unknown = configuration(&[("ALLOWIT_PAYSH_UPSTREAM", "unrecognized")]);
    assert!(
        upstream_from_env(
            &unknown,
            "solana:testnet",
            "solana:testnet",
            "testnet-open-meteo-air-quality"
        )
        .is_err()
    );
}

#[test]
fn native_fixture_cannot_purchase_real_service_delivery() {
    let env = configuration(&[("GOOGLE_AIR_QUALITY_API_KEY", "non-network-test-key")]);
    let upstream = upstream_from_env(
        &env,
        "solana:testnet",
        "solana:testnet",
        "native-paysh-testnet-compatibility",
    )
    .unwrap()
    .unwrap();
    assert!(
        upstream
            .invoke(&Invocation {
                service_id: "native-paysh-testnet-compatibility",
                network: "solana:testnet",
                operation_id: "bound-operation",
                input: &json!({})
            })
            .is_err()
    );
}

#[test]
fn service_input_validation_is_catalog_bound_and_vendor_equivalent() {
    for input in [
        json!({"location":{"latitude":-90,"longitude":180},"universalAqi":false}),
        json!({"location":{"latitude":91,"longitude":0}}),
        json!({"location":{"latitude":0,"longitude":0,"extra":1}}),
        json!({"location":{"latitude":0,"longitude":0},"credential":"caller-value"}),
        json!({"location":{"latitude":0,"longitude":0},"universalAqi":"true"}),
    ] {
        assert_eq!(
            validate_service_input("google-airquality-current", &input),
            validate_service_input("testnet-open-meteo-air-quality", &input)
        );
    }
    assert!(
        validate_service_input(
            "caller-selected-unknown-function",
            &json!({"location":{"latitude":1,"longitude":2}})
        )
        .is_err()
    );
}

struct NoRecovery;
impl Upstream for NoRecovery {
    fn validate_input(
        &self,
        _: &serde_json::Value,
    ) -> allowit_solana_service_upstreams::Result<()> {
        Ok(())
    }
    fn invoke(
        &self,
        _: &Invocation<'_>,
    ) -> allowit_solana_service_upstreams::Result<serde_json::Value> {
        panic!("Recovery must not invoke or resubmit a provider request")
    }
}

#[test]
fn default_recovery_never_resubmits_an_operation() {
    let input = json!({});
    let invocation = Invocation {
        service_id: "service",
        network: "network",
        operation_id: "retained-operation",
        input: &input,
    };
    assert_eq!(NoRecovery.cached(&invocation).unwrap(), None);
    assert_eq!(NoRecovery.resume(&invocation).unwrap(), None);
}
