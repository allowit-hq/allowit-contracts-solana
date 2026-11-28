# S4: Browser wallet compatibility (TASK-1066)

Run from `npm/solana`. The probe bundles the checked-in browser build and keeps its tools in a temporary directory:

```sh
tools="$(mktemp -d)"
npm install --prefix "$tools" --no-package-lock --no-audit --no-fund esbuild@0.25.12 @noble/curves@1.9.7 @noble/hashes@1.8.0
NODE_PATH="$tools/node_modules" node "$tools/node_modules/esbuild/bin/esbuild" examples/browser-wallets/probe.mjs --bundle --format=esm --outfile=examples/browser-wallets/bundle.js
python3 -m http.server 8765 --bind 127.0.0.1 --directory examples/browser-wallets
```

Open http://localhost:8765 in separate browser profiles for Phantom, Solflare and Backpack. Use a disposable account in Devnet mode. Enable just the wallet under test in each profile so the SDK selects it deterministically.

1. Connect and record the wallet and browser versions. Sign Setup, the policy approval and each of Refill, Stop, Recover and Close. Record a refusal as shown, including a byte-change refusal. These signatures are kept in page memory and none are broadcast. Some wallets simulate transactions before signing and may warn about missing accounts in these fixtures. Record that warning or refusal.
2. Sign the memo with an existing co-signature. Record whether the wallet accepted it, returned the original message, added a valid owner signature and preserved the co-signature. This exercises the wallet adapter directly because the SDK owner path takes exactly one signature.
3. After a successful owner transaction signature, check expiry while the blockhash is valid. Wait for finalization to show the blockhash is invalid, then check again. Sign the same step again and compare the two reported blockhashes. Record the RPC outcome separately from wallet signing behavior.

Save the log with the wallet versions and any refusal from the extension prompt. A passing run requires unchanged owner messages with valid signatures. The partially signed and expired cases record the actual behavior of each wallet.
