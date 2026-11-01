use allowit_native::{crypto::Key, native::ExecutionRequestIdentity, policy::Policy};

#[test]
fn execution_context_retains_legacy_digest_across_object_order() {
    let mut policy =
        Policy::generate("solana:testnet", "Spend up to 5 test tokens per day").unwrap();
    policy.id = "a".repeat(64);
    let recipient = Key::parse("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB").unwrap();
    let contexts = [
        r#"{"z":{"b":2,"a":1},"a":[{"y":true,"x":"ok"}]}"#,
        r#"{"a":[{"x":"ok","y":true}],"z":{"a":1,"b":2}}"#,
    ];
    for context in contexts {
        let identity = ExecutionRequestIdentity::new(
            &policy,
            "legacy-context",
            "1.000000",
            recipient,
            "lookup",
            "vendor",
            &serde_json::from_str(context).unwrap(),
        )
        .unwrap();
        assert_eq!(
            identity.context_hash,
            "6d401ab0b38433c92ef68708caf642fd55272004c178d339919ce457d7586f2e"
        );
        assert_eq!(
            identity.digest().unwrap(),
            "9278dfc7b1dbaff3bcc6e60ed83d8a5bd6e9e0086216dc8f823d55cc9e3f179f"
        );
    }
}
