use allowit_sdk::service::rpc::Operation;
use allowit_solana_service_rpc::{Commitment, Encoding, Request};
use serde_json::json;
#[test]
fn typed_requests_own_wire_parameters_and_forbid_implicit_submission_retries() {
    let send = Request::send_transaction("exact-signed-packet", Commitment::Confirmed);
    assert_eq!(send.method(), "sendTransaction");
    assert_eq!(
        send.params(),
        json!(["exact-signed-packet",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":0}])
    );
    assert_eq!(
        Request::account_info("account", Encoding::Base64, Commitment::Finalized, Some(42))
            .params(),
        json!(["account",{"encoding":"base64","commitment":"finalized","minContextSlot":42}])
    );
    assert_eq!(
        Request::transaction(
            "signature",
            Encoding::JsonParsed,
            Commitment::Finalized,
            Some(0)
        )
        .params(),
        json!(["signature",{"encoding":"jsonParsed","commitment":"finalized","maxSupportedTransactionVersion":0}])
    );
}

#[test]
fn native_retry_classification_requires_exact_scoped_packet_and_options() {
    use allowit_solana_service_rpc::{diagnostic_method, is_identical_submission, is_read_method};
    assert!(is_read_method("getGenesisHash"));
    assert!(!is_read_method("sendTransaction"));
    assert!(!is_read_method("getBalance"));
    assert_eq!(diagnostic_method("caller-controlled-secret"), "unknown");
    let request = Request::send_transaction("retained-wire", Commitment::Finalized);
    assert!(is_identical_submission(
        request.method(),
        &request.params(),
        Some("retained-wire")
    ));
    assert!(!is_identical_submission(
        request.method(),
        &request.params(),
        Some("other-wire")
    ));
    assert!(!is_identical_submission(
        request.method(),
        &request.params(),
        None
    ));
    assert!(!is_identical_submission(
        "sendTransaction",
        &Request::send_transaction("retained-wire", Commitment::Confirmed).params(),
        Some("retained-wire")
    ));
    let mut changed = request.params();
    changed[1]["maxRetries"] = json!(1);
    assert!(!is_identical_submission(
        request.method(),
        &changed,
        Some("retained-wire")
    ));
}
