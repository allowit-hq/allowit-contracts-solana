#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
out="$PWD/target/deploy"
mkdir -p "$out"
export CARGO_TARGET_DIR="$PWD/target/custom-policy"
for policy in paper-sample destination-list daily-limits; do
  cargo build-sbf --manifest-path sbf-tests/programs/custom-policy/Cargo.toml \
    --arch v3 --optimize-size --tools-version v1.57 --sbf-out-dir "$out" -- \
    --locked --features "$policy"
  cp "$out/allowit_custom_policy_spike.so" "$out/${policy//-/_}.so"
done
