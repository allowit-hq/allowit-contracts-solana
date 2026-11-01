use super::*;
use allowit_native::crypto::LocalSigner;

fn signer(seed: &str, public: &str) -> LocalSigner {
    let bytes = format!("{seed}{public}");
    let secret: Vec<u8> = bytes
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    LocalSigner::from_secret(&secret).unwrap()
}
fn sponsor() -> LocalSigner {
    signer(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    )
}
fn delegate() -> LocalSigner {
    signer(
        "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    )
}
fn owner() -> LocalSigner {
    signer(
        "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    )
}
fn fixture() -> (
    DelegatedX402,
    X402Endpoint,
    X402Request,
    DelegatedSource,
    Value,
) {
    let transport = DelegatedX402::for_private_validator(
        "solana:privateGenesisForSourceTests",
        &Key([10; 32]).to_string(),
    )
    .unwrap();
    let endpoint = X402Endpoint {
        id: "private-merchant".into(),
        url: "http://127.0.0.1:18403/paid".into(),
        resource_url: None,
        method: X402Method::Post,
        pay_to: Key([8; 32]).to_string(),
        mint: Key([10; 32]).to_string(),
        fee_payer: sponsor().public_key().to_string(),
        fee_payer_from_challenge: false,
        choose_lowest_amount: false,
        max_amount_units: 1_000_000,
    };
    let request = X402Request {
        body: Some(json!({"query":"business dataset"})),
    };
    let source = DelegatedSource {
        owner: owner().public_key().to_string(),
        delegate: delegate().public_key().to_string(),
        source_token_account: Key([9; 32]).to_string(),
    };
    let challenge = json!({"x402Version":2,"resource":{"url":endpoint.url,"description":"read-only dataset"},
        "accepts":[{"scheme":"exact","network":transport.network(),"asset":endpoint.mint,
            "amount":"600000","payTo":endpoint.pay_to,"maxTimeoutSeconds":60,
            "extra":{"feePayer":endpoint.fee_payer}}],
        "extensions":{"bazaar":{"info":{"input":{"type":"http","method":"POST"}}}}
    });
    (transport, endpoint, request, source, challenge)
}
fn plan() -> (DelegatedX402, UnsignedDelegatedPayment) {
    let (transport, endpoint, request, source, challenge) = fixture();
    let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
    let plan = transport
        .build_payment(
            &endpoint,
            &request,
            &selected,
            &source,
            &Key([11; 32]).to_string(),
            1234,
            "durable-operation-001",
        )
        .unwrap();
    (transport, plan)
}
fn finalized(plan: &UnsignedDelegatedPayment) -> (Value, String) {
    let message = STANDARD.decode(&plan.message_base64).unwrap();
    let fee_signature = sponsor().sign(&message);
    let delegate_signature = delegate().sign(&message);
    let mut raw = vec![2];
    raw.extend(fee_signature);
    raw.extend(delegate_signature);
    raw.extend(&message);
    let accounts = message_accounts(&message).unwrap();
    let source = accounts
        .iter()
        .position(|v| v.to_string() == plan.source.source_token_account)
        .unwrap();
    let destination = accounts
        .iter()
        .position(|v| v.to_string() == plan.destination_token_account)
        .unwrap();
    let balance = |account_index, owner: &str, amount: &str| {
        json!({
            "accountIndex":account_index,"mint":plan.endpoint.mint,"owner":owner,
            "programId":TOKEN_PROGRAM,"uiTokenAmount":{"amount":amount,"decimals":6}
        })
    };
    let tx = json!({"slot":55,"transaction":[STANDARD.encode(raw),"base64"],"meta":{
        "err":null,
        "preTokenBalances":[balance(source,&plan.source.owner,"50000000"),balance(destination,&plan.endpoint.pay_to,"0")],
        "postTokenBalances":[balance(source,&plan.source.owner,"49400000"),balance(destination,&plan.endpoint.pay_to,"600000")]
    }});
    (tx, bs58::encode(fee_signature).into_string())
}

#[test]
fn production_pins_canonical_mainnet_and_https() {
    let transport = DelegatedX402::production().unwrap();
    let (_, mut endpoint, _, _, _) = fixture();
    endpoint.url = "https://example.com/paid".into();
    endpoint.mint = SOLANA_USDC_MINT.into();
    assert!(transport.validate_endpoint(&endpoint).is_ok());
    for url in [
        "http://example.com/paid",
        "https://127.0.0.1/paid",
        "https://localhost/paid",
        "https://user:password@example.com/paid",
        "https://example.com/paid#fragment",
    ] {
        endpoint.url = url.into();
        assert!(transport.validate_endpoint(&endpoint).is_err(), "{url}");
    }
    endpoint.url = "https://example.com/paid".into();
    endpoint.mint = Key([10; 32]).to_string();
    assert!(transport.validate_endpoint(&endpoint).is_err());
    assert!(DelegatedX402::for_private_validator(SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT).is_err());
}

#[test]
fn canonical_devnet_uses_the_same_standard_protocol_with_isolated_chain_and_mint() {
    assert_eq!(
        SOLANA_DEVNET_CAIP2,
        format!("solana:{}", &SOLANA_DEVNET_GENESIS[..32])
    );
    let transport = DelegatedX402::for_public_network(SOLANA_DEVNET_CAIP2).unwrap();
    let (_, mut endpoint, request, source, mut challenge) = fixture();
    endpoint.url = "https://devnet-merchant.example/paid".into();
    endpoint.mint = SOLANA_DEVNET_USDC_MINT.into();
    challenge["resource"]["url"] = json!(endpoint.url);
    challenge["accepts"][0]["network"] = json!(SOLANA_DEVNET_CAIP2);
    challenge["accepts"][0]["asset"] = json!(SOLANA_DEVNET_USDC_MINT);
    let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
    let plan = transport
        .build_payment(
            &endpoint,
            &request,
            &selected,
            &source,
            &Key([11; 32]).to_string(),
            1234,
            "devnet-operation",
        )
        .unwrap();
    let signature = delegate().sign(&STANDARD.decode(&plan.message_base64).unwrap());
    let credential = transport.attach_signature(&plan, &signature).unwrap();
    assert_eq!(credential["accepted"]["network"], SOLANA_DEVNET_CAIP2);
    assert_eq!(credential["accepted"]["asset"], SOLANA_DEVNET_USDC_MINT);
    assert!(
        DelegatedX402::production()
            .unwrap()
            .validate_plan(&plan)
            .is_err()
    );
    for (field, value) in [
        ("network", SOLANA_MAINNET_CAIP2),
        ("asset", SOLANA_USDC_MINT),
    ] {
        let mut wrong = challenge.clone();
        wrong["accepts"][0][field] = json!(value);
        assert!(transport.select_challenge(&endpoint, &wrong).is_err());
    }
    endpoint.url = "http://127.0.0.1/paid".into();
    assert!(transport.validate_endpoint(&endpoint).is_err());
    assert!(
        DelegatedX402::for_private_validator(SOLANA_DEVNET_CAIP2, SOLANA_DEVNET_USDC_MINT).is_err()
    );
    assert!(DelegatedX402::for_public_network("solana:devnet").is_err());
}

#[test]
fn challenge_rejects_unpinned_terms_and_v1() {
    let (transport, endpoint, _, _, challenge) = fixture();
    assert_eq!(
        transport
            .select_challenge(&endpoint, &challenge)
            .unwrap()
            .amount_units,
        600_000
    );
    for (field, value) in [
        ("scheme", json!("upto")),
        ("network", json!(SOLANA_MAINNET_CAIP2)),
        ("asset", json!(SOLANA_USDC_MINT)),
        ("payTo", json!(Key([19; 32]).to_string())),
        ("amount", json!("0600000")),
        ("amount", json!("0")),
        ("amount", json!("1000001")),
        ("amount", json!(600000)),
        ("maxTimeoutSeconds", json!(301)),
    ] {
        let mut changed = challenge.clone();
        changed["accepts"][0][field] = value;
        assert!(
            transport.select_challenge(&endpoint, &changed).is_err(),
            "{field}"
        );
    }
    let mut changed = challenge.clone();
    changed["x402Version"] = json!(1);
    assert!(transport.select_challenge(&endpoint, &changed).is_err());
    let mut changed = challenge.clone();
    changed["resource"]["url"] = json!("https://other.example/paid");
    assert!(transport.select_challenge(&endpoint, &changed).is_err());
    let mut changed = challenge.clone();
    changed["accepts"][0]["extra"]["feePayer"] = json!(Key([20; 32]).to_string());
    assert!(transport.select_challenge(&endpoint, &changed).is_err());
    let mut changed = challenge.clone();
    changed["accepts"]
        .as_array_mut()
        .unwrap()
        .push(challenge["accepts"][0].clone());
    assert!(transport.select_challenge(&endpoint, &changed).is_err());
}

#[test]
fn source_account_is_explicit_and_owner_is_not_a_required_signer() {
    let (transport, plan) = plan();
    assert_ne!(
        associated_token_account(&plan.source.owner, &plan.endpoint.mint)
            .unwrap()
            .to_string(),
        plan.source.source_token_account
    );
    let message = STANDARD.decode(&plan.message_base64).unwrap();
    assert_eq!(&message[..3], &[0x80, 2, 1]);
    let accounts = message_accounts(&message).unwrap();
    assert_eq!(accounts[0].to_string(), plan.endpoint.fee_payer);
    assert_eq!(accounts[1].to_string(), plan.source.delegate);
    assert!(!accounts.iter().any(|v| v.to_string() == plan.source.owner));
    assert!(
        accounts
            .iter()
            .any(|v| v.to_string() == plan.source.source_token_account)
    );
    let tx = transport.transaction(&plan).unwrap();
    assert_eq!(tx.instructions[2].program.to_string(), TOKEN_PROGRAM);
    assert_eq!(
        tx.instructions[2].accounts[0].key.to_string(),
        plan.source.source_token_account
    );
    assert_eq!(
        tx.instructions[2].accounts[3].key.to_string(),
        plan.source.delegate
    );
    assert_eq!(
        tx.instructions[2].data,
        [vec![12], 600_000u64.to_le_bytes().to_vec(), vec![6]].concat()
    );
}

#[test]
fn signature_must_bind_exact_message_and_outer_envelope() {
    let (transport, plan) = plan();
    let message = STANDARD.decode(&plan.message_base64).unwrap();
    let credential = transport
        .attach_signature(&plan, &delegate().sign(&message))
        .unwrap();
    assert_eq!(credential["accepted"], plan.selected.accepted);
    assert_eq!(credential["resource"], plan.selected.resource);
    assert_eq!(credential["extensions"], plan.selected.extensions);
    assert!(transport.validate_credential(&plan, &credential).is_ok());
    assert!(
        transport
            .attach_signature(&plan, &sponsor().sign(&message))
            .is_err()
    );
    let mut changed = credential.clone();
    changed["accepted"]["amount"] = json!("1");
    assert!(transport.validate_credential(&plan, &changed).is_err());
    let mut changed = plan.clone();
    changed.message_base64 = STANDARD.encode(b"other");
    assert!(transport.validate_plan(&changed).is_err());
    let original_hash = transport.action_hash(&plan).unwrap();
    let mut changed = plan.clone();
    changed.request.body = Some(json!({"query":"different action"}));
    assert_ne!(original_hash, transport.action_hash(&changed).unwrap());
}

#[test]
fn finalized_receipt_requires_exact_message_signatures_and_token_deltas() {
    let (transport, plan) = plan();
    let (tx, signature) = finalized(&plan);
    let result = transport
        .verify_finalized_receipt(&tx, &plan, &signature)
        .unwrap();
    assert_eq!(result.finalized_slot, 55);
    assert_eq!(result.amount_units, 600_000);
    for changed in [
        {
            let mut v = tx.clone();
            v["meta"]["err"] = json!({"InstructionError":[2,"Custom"]});
            v
        },
        {
            let mut v = tx.clone();
            v["meta"].as_object_mut().unwrap().remove("err");
            v
        },
        {
            let mut v = tx.clone();
            v["meta"]["postTokenBalances"][0]["uiTokenAmount"]["amount"] = json!("49400001");
            v
        },
        {
            let mut v = tx.clone();
            v["meta"]["postTokenBalances"][1]["owner"] = json!(plan.source.owner);
            v
        },
        {
            let mut v = tx.clone();
            v["meta"]["postTokenBalances"][1]["mint"] = json!(SOLANA_USDC_MINT);
            v
        },
        {
            let mut v = tx.clone();
            v["slot"] = json!(0);
            v
        },
        {
            let mut v = tx.clone();
            v["transaction"][1] = json!("json");
            v
        },
    ] {
        assert!(
            transport
                .verify_finalized_receipt(&changed, &plan, &signature)
                .is_err()
        );
    }
    let mut changed = tx.clone();
    let mut raw = STANDARD
        .decode(changed["transaction"][0].as_str().unwrap())
        .unwrap();
    raw[1] ^= 1;
    changed["transaction"][0] = json!(STANDARD.encode(raw));
    assert!(
        transport
            .verify_finalized_receipt(&changed, &plan, &signature)
            .is_err()
    );
}

#[test]
fn get_body_and_oversize_inputs_fail_before_network() {
    let (transport, mut endpoint, request, source, challenge) = fixture();
    endpoint.method = X402Method::Get;
    assert!(transport.request_body(&endpoint, &request).is_err());
    endpoint.method = X402Method::Post;
    let large = X402Request {
        body: Some(json!({"query":"x".repeat(MAX_REQUEST_BYTES)})),
    };
    assert!(transport.request_body(&endpoint, &large).is_err());
    let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
    let mut bad = source;
    bad.delegate = bad.owner.clone();
    assert!(
        transport
            .build_payment(
                &endpoint,
                &request,
                &selected,
                &bad,
                &Key([11; 32]).to_string(),
                1234,
                "n"
            )
            .is_err()
    );
}

#[test]
fn registered_methods_and_bodies_are_bound_without_network_or_worker_headers() {
    let (transport, mut endpoint, request, source, mut challenge) = fixture();
    for method in [X402Method::Put, X402Method::Patch, X402Method::Delete] {
        endpoint.method = method;
        let http = transport
            .request(&endpoint, &request)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            http.method().as_str(),
            serde_json::to_value(method).unwrap().as_str().unwrap()
        );
        assert!(http.headers().get("Authorization").is_none());
        assert!(http.headers().get("PAYMENT-SIGNATURE").is_none());
        challenge["resource"]["url"] = json!(endpoint.url);
        let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
        let plan = transport
            .build_payment(
                &endpoint,
                &request,
                &selected,
                &source,
                &Key([11; 32]).to_string(),
                1234,
                "method-binding",
            )
            .unwrap();
        let mut changed = plan.clone();
        changed.endpoint.method = X402Method::Post;
        assert_ne!(
            transport.action_hash(&plan).unwrap(),
            transport.action_hash(&changed).unwrap()
        );
    }
}

#[test]
fn separate_resource_pin_is_explicit_exact_and_retained_in_the_action_hash() {
    let (transport, mut endpoint, request, source, mut challenge) = fixture();
    endpoint.url.push_str("?topic=solana");
    // A query-less challenge remains incompatible without the explicit pin.
    assert!(transport.select_challenge(&endpoint, &challenge).is_err());
    endpoint.resource_url = Some("http://127.0.0.1:18403/paid".into());
    let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
    let plan = transport
        .build_payment(
            &endpoint,
            &request,
            &selected,
            &source,
            &Key([11; 32]).to_string(),
            1234,
            "resource-binding",
        )
        .unwrap();
    transport.validate_plan(&plan).unwrap();
    let mut changed = plan.clone();
    changed.endpoint.url = "http://127.0.0.1:18403/paid?topic=other".into();
    assert_ne!(
        transport.action_hash(&plan).unwrap(),
        transport.action_hash(&changed).unwrap()
    );
    challenge["resource"]["url"] = json!("http://127.0.0.1:18403/unregistered");
    assert!(transport.select_challenge(&endpoint, &challenge).is_err());
    endpoint.resource_url = Some("http://127.0.0.1:18404/paid".into());
    assert!(transport.validate_endpoint(&endpoint).is_err());
}

#[test]
fn lowest_offer_mode_is_opt_in_and_rejects_ties_or_invalid_terms() {
    let (transport, mut endpoint, _, _, mut challenge) = fixture();
    let original = challenge["accepts"][0].clone();
    let mut inexpensive = original.clone();
    inexpensive["amount"] = json!("1000");
    challenge["accepts"] = json!([original, inexpensive]);
    assert!(transport.select_challenge(&endpoint, &challenge).is_err());
    endpoint.choose_lowest_amount = true;
    assert_eq!(
        transport
            .select_challenge(&endpoint, &challenge)
            .unwrap()
            .amount_units,
        1000
    );
    endpoint.max_amount_units = 1000;
    assert_eq!(
        transport
            .select_challenge(&endpoint, &challenge)
            .unwrap()
            .amount_units,
        1000
    );
    let cheap = challenge["accepts"][1].clone();
    challenge["accepts"].as_array_mut().unwrap().push(cheap);
    assert!(transport.select_challenge(&endpoint, &challenge).is_err());
    challenge["accepts"].as_array_mut().unwrap().pop();
    for (field, value) in [
        ("amount", json!("0")),
        ("amount", json!("01000")),
        ("maxTimeoutSeconds", json!(3600)),
        ("payTo", json!(Key([20; 32]).to_string())),
    ] {
        let mut invalid = challenge.clone();
        invalid["accepts"][1][field] = value;
        assert!(
            transport.select_challenge(&endpoint, &invalid).is_err(),
            "{field}"
        );
    }
    let legacy = fixture().1;
    let serialized = serde_json::to_value(&legacy).unwrap();
    assert!(serialized.get("resourceUrl").is_none());
    assert!(serialized.get("chooseLowestAmount").is_none());
}

fn alternate_sponsor() -> Key {
    // Canonical compressed Ed25519 base point: a deterministic on-curve test
    // public key. No wallet key or network state is needed to build a plan.
    let mut bytes = [0x66; 32];
    bytes[0] = 0x58;
    Key(bytes)
}

#[test]
fn old_fixed_endpoint_serialization_and_action_hash_are_unchanged() {
    let (transport, original) = plan();
    let legacy_endpoint = format!(
        r#"{{"id":"private-merchant","url":"http://127.0.0.1:18403/paid","method":"POST","payTo":"{}","mint":"{}","feePayer":"{}","maxAmountUnits":1000000}}"#,
        original.endpoint.pay_to, original.endpoint.mint, original.endpoint.fee_payer
    );
    assert_eq!(
        serde_json::to_string(&original.endpoint).unwrap(),
        legacy_endpoint
    );
    let legacy_bytes = serde_json::to_vec(&original).unwrap();
    assert!(!String::from_utf8_lossy(&legacy_bytes).contains("feePayerFromChallenge"));
    let restored: UnsignedDelegatedPayment = serde_json::from_slice(&legacy_bytes).unwrap();
    assert!(!restored.endpoint.fee_payer_from_challenge);
    assert_eq!(serde_json::to_vec(&restored).unwrap(), legacy_bytes);
    assert_eq!(
        transport.action_hash(&restored).unwrap(),
        allowit_sdk::service::hash(&legacy_bytes)
    );
    let mut explicit_false = serde_json::to_value(&original).unwrap();
    explicit_false["endpoint"]["feePayerFromChallenge"] = json!(false);
    let restored: UnsignedDelegatedPayment = serde_json::from_value(explicit_false).unwrap();
    assert_eq!(
        transport.action_hash(&restored).unwrap(),
        transport.action_hash(&original).unwrap()
    );
}

#[test]
fn dynamic_sponsors_are_explicit_opt_in_and_each_plan_freezes_its_selected_payer() {
    let (transport, mut endpoint, request, source, mut challenge) = fixture();
    let fixed = endpoint.clone();
    endpoint.fee_payer_from_challenge = true;
    assert!(transport.validate_endpoint(&endpoint).is_err());
    endpoint.fee_payer.clear();
    assert!(transport.validate_endpoint(&endpoint).is_ok());
    let mut plans = Vec::new();
    for payer in [sponsor().public_key(), alternate_sponsor()] {
        challenge["accepts"][0]["extra"]["feePayer"] = json!(payer.to_string());
        let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
        let frozen = transport
            .build_payment(
                &endpoint,
                &request,
                &selected,
                &source,
                &Key([11; 32]).to_string(),
                1234,
                "same-operation",
            )
            .unwrap();
        assert_eq!(transport.transaction(&frozen).unwrap().signers[0], payer);
        assert_eq!(
            frozen.selected.accepted["extra"]["feePayer"],
            payer.to_string()
        );
        let restored: UnsignedDelegatedPayment =
            serde_json::from_slice(&serde_json::to_vec(&frozen).unwrap()).unwrap();
        assert!(transport.validate_plan(&restored).is_ok());
        plans.push(frozen);
    }
    assert_ne!(plans[0].message_base64, plans[1].message_base64);
    assert_ne!(
        transport.action_hash(&plans[0]).unwrap(),
        transport.action_hash(&plans[1]).unwrap()
    );
    assert!(transport.select_challenge(&fixed, &challenge).is_err());
    // Another quote does not change the original journal/signature/receipt.
    assert!(transport.validate_plan(&plans[0]).is_ok());
    let message = STANDARD.decode(&plans[0].message_base64).unwrap();
    let credential = transport
        .attach_signature(&plans[0], &delegate().sign(&message))
        .unwrap();
    assert!(
        transport
            .validate_credential(&plans[0], &credential)
            .is_ok()
    );
    assert!(
        transport
            .validate_credential(&plans[1], &credential)
            .is_err()
    );
    let (receipt, signature) = finalized(&plans[0]);
    assert!(
        transport
            .verify_finalized_receipt(&receipt, &plans[0], &signature)
            .is_ok()
    );
    assert!(
        transport
            .verify_finalized_receipt(&receipt, &plans[1], &signature)
            .is_err()
    );
    let mut changed = plans[0].clone();
    changed.selected.accepted["extra"]["feePayer"] = json!(alternate_sponsor().to_string());
    assert!(transport.validate_plan(&changed).is_err());
    let mut changed = credential;
    changed["accepted"]["extra"]["feePayer"] = json!(alternate_sponsor().to_string());
    assert!(transport.validate_credential(&plans[0], &changed).is_err());
}

#[test]
fn dynamic_payers_cannot_be_invalid_or_charge_owner_delegate_or_source() {
    let (transport, mut endpoint, request, source, mut challenge) = fixture();
    endpoint.fee_payer_from_challenge = true;
    endpoint.fee_payer.clear();
    let off_curve = associated_token_account(&source.owner, &endpoint.mint).unwrap();
    for payer in [
        String::new(),
        "not-a-public-key".into(),
        off_curve.to_string(),
    ] {
        challenge["accepts"][0]["extra"]["feePayer"] = json!(payer);
        assert!(transport.select_challenge(&endpoint, &challenge).is_err());
    }
    for payer in [&source.owner, &source.delegate] {
        challenge["accepts"][0]["extra"]["feePayer"] = json!(payer);
        let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
        assert!(
            transport
                .build_payment(
                    &endpoint,
                    &request,
                    &selected,
                    &source,
                    &Key([11; 32]).to_string(),
                    1234,
                    "n"
                )
                .is_err()
        );
    }
    let mut source = source;
    source.source_token_account = alternate_sponsor().to_string();
    challenge["accepts"][0]["extra"]["feePayer"] = json!(source.source_token_account);
    let selected = transport.select_challenge(&endpoint, &challenge).unwrap();
    assert!(
        transport
            .build_payment(
                &endpoint,
                &request,
                &selected,
                &source,
                &Key([11; 32]).to_string(),
                1234,
                "n"
            )
            .is_err()
    );
}
