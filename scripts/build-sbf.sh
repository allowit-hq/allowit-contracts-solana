#!/usr/bin/env bash
# Builds the vault program, the test check program and the three Custom check fixtures of
# sbf-tests/programs/custom-policy in a pinned verifiable-build image, so that
# every host gives the same bytes: the image fixes the operating system, the tools and the paths.
# The programs go to target/deploy; the SHA-256 of the vault program is printed last.
#
# SBF_TOOLS_CACHE, when set, is a host folder that keeps the downloaded platform tools between
# runs. It only saves the download: the tools sit at the same path in the image either way.
set -euo pipefail

IMAGE=solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
TOOLS=v1.57

cd "$(dirname "$0")/.."
cache=()
if [ -n "${SBF_TOOLS_CACHE:-}" ]; then
  mkdir -p "$SBF_TOOLS_CACHE"
  cache=(-v "$SBF_TOOLS_CACHE:/root/.cache/solana")
fi
docker run --rm --platform linux/amd64 -v "$PWD:/build" -w /build "${cache[@]}" \
  -e CARGO_TARGET_DIR=/build/target "$IMAGE" bash -euc "
    for manifest in programs/vault/Cargo.toml sbf-tests/programs/test-check/Cargo.toml; do
      cargo build-sbf --manifest-path \$manifest --arch v3 --optimize-size --tools-version $TOOLS \
        --sbf-out-dir target/deploy -- --locked
    done
    # The Custom check fixtures of sbf-tests: one program per policy feature.
    for policy in paper-transfer destination-list daily-limits; do
      cargo build-sbf --manifest-path sbf-tests/programs/custom-policy/Cargo.toml --arch v3 \
        --optimize-size --tools-version $TOOLS --sbf-out-dir target/custom-policy/\$policy -- \
        --locked --features \$policy
      cp target/custom-policy/\$policy/allowit_custom_policy_spike.so \
        target/deploy/\${policy//-/_}.so
    done"
sha256sum target/deploy/{paper_transfer,destination_list,daily_limits}.so
sha256sum target/deploy/allowit_vault.so
