# Solana vendor

`allowit-solana-vendor` provides Solana host adapters to the Allowit SDK client facade.
It depends on the `client` feature of `allowit-sdk` ([Allowit core](https://github.com/allowit-hq/allowit-core)) for errors, origin validation and safe output.
It does not depend on the SDK client facade or CLI.

`paysh::run(args, stdout, stderr)` reconciles retained PaySH operations with their
original backend and scoped capability. It reads no signing key. Preserve the
original operation ID and input after an uncertain result.

Callers must redact accumulated output with `redact` before displaying it.
Recovery instructions are flushed through the same redaction before a request
can leave the process.

Run adapter tests with `cargo test -p allowit-solana-vendor --locked`.
