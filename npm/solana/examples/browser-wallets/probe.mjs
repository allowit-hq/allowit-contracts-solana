import {ed25519} from '@noble/curves/ed25519';
import {base58, base64, equal, hex, sha256, unbase64, utf8} from '@allowit/solana/bytes';
import {compile, messageBytes, readWire, verify, wire} from '@allowit/solana/message';
import {
  approvalMessage, approvalStep, MEMO_PROGRAM, messageHash, ownerStepsMessage,
  policyApproval, setupMessage, walletOf,
} from '@allowit/solana/native-wallet';
import {DEVNET, USDC_DEVNET} from '@allowit/solana/networks';
import {expiredRecord} from '@allowit/solana/owner-chain';
import {blockhashValid, deposit, recentBlockhash} from '@allowit/solana/rpc';
import {connect, signWalletTransaction} from '@allowit/solana/wallet';

const log = document.querySelector('#log');
const buttons = [...document.querySelectorAll('button')];
let wallet;
let roles;
let lastSigned;

function report(message) {
  log.textContent += `${new Date().toISOString()} ${message}\n`;
}

function action(id, run) {
  document.querySelector(`#${id}`).addEventListener('click', async () => {
    buttons.forEach(button => { button.disabled = true; });
    try {
      await run();
    } catch (error) {
      report(`${id}: ${error.code ? `${error.code}: ` : ''}${error.message}`);
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  });
}

function requireWallet() {
  if (!wallet) throw new Error('Connect a Devnet wallet first.');
}

const ephemeral = () => ed25519.utils.randomPrivateKey();
const addressOf = key => base58(ed25519.getPublicKey(key));
const digest = text => hex(sha256(utf8(text)));

action('connect', async () => {
  wallet = await connect(DEVNET);
  roles = {owner: wallet.address, mint: USDC_DEVNET, agent: addressOf(ephemeral()), server: addressOf(ephemeral())};
  lastSigned = undefined;
  document.querySelector('#owner').textContent = wallet.address;
  report(`Connected ${wallet.address}`);
});

action('transaction', async () => {
  requireWallet();
  lastSigned = undefined;
  const step = document.querySelector('#step').value;
  const tag = crypto.randomUUID();
  const blockhash = await recentBlockhash(DEVNET);
  let tx;
  if (step === 'setup') {
    const [token, delegate] = await Promise.all([deposit(DEVNET, 165), deposit(DEVNET, 355)]);
    tx = setupMessage({...roles, allowance: 1_000_000n, decimals: 6, token: {nothing: token},
      delegate: {nothing: delegate}, tag: `allowit:setup:${roles.agent}:${roles.server}:${Math.floor(Date.now() / 1000) + 90}`,
      blockhash});
  } else {
    const facts = {
      refill: {kind: 'approve', allowance: 1_000_000n, decimals: 6},
      stop: {kind: 'stop'},
      recover: {kind: 'recover', to: addressOf(ephemeral()), amount: 1n, decimals: 6},
      close: {kind: 'close'},
    };
    tx = ownerStepsMessage(roles, [facts[step]], tag, blockhash);
  }
  const message = messageBytes(tx);
  report(`${step}: request ${messageHash(message)}, blockhash ${blockhash}`);
  const signed = await signWalletTransaction(message, wallet.address, DEVNET);
  lastSigned = {hash: messageHash(message), signed, blockhash};
  report(`${step}: message unchanged, valid owner signature, ${unbase64(signed).length} wire bytes`);
});

action('approval', async () => {
  requireWallet();
  const source = '// S4 disposable approval, no server policy';
  const message = 'Allowit: I approve this policy source for my wallet.\n' + JSON.stringify({
    policyId: 's4-devnet-probe', revision: 1, route: 'native', network: DEVNET,
    wallet: walletOf(roles).tokenAccount, source, sourceHash: digest(source), params: {}, paramsHash: digest('{}'),
  });
  if (!policyApproval(message, DEVNET)) throw new Error('Invalid approval fixture.');
  const step = approvalStep(message);
  await wallet.signMessage(approvalMessage(step));
  report(`approval: message unchanged, valid owner signature, ${step.hash}`);
});

action('partial', async () => {
  requireWallet();
  const key = ephemeral();
  const coSigner = addressOf(key);
  const tx = compile([{program: MEMO_PROGRAM, data: utf8(`Allowit S4 ${crypto.randomUUID()}`),
    accounts: [{address: coSigner, signer: true, writable: false}]}],
  wallet.address, await recentBlockhash(DEVNET));
  const message = messageBytes(tx);
  const existing = ed25519.sign(message, key);
  const result = readWire(await wallet.signTransaction(wire([new Uint8Array(64), existing], message)));
  if (!result) throw new Error('Wallet returned invalid transaction bytes.');
  const unchanged = equal(result.message, message);
  const ownerSigned = verify(wallet.address, message, result.signatures[0]);
  const preserved = result.signatures.length === 2 && equal(existing, result.signatures[1]);
  report(`partial: message unchanged=${unchanged}, owner signed original=${ownerSigned}, co-signature preserved=${preserved}`);
});

action('expiry', async () => {
  requireWallet();
  if (!lastSigned) throw new Error('Sign an owner transaction first.');
  const {hash, signed, blockhash} = lastSigned;
  const {valid, at} = await blockhashValid(DEVNET, blockhash);
  if (valid) {
    report(`expiry: blockhash still valid at finalized slot ${at}; check again later`);
    return;
  }
  const record = await expiredRecord(DEVNET, hash, signed);
  report(record ? `expiry: original transaction landed at slot ${record.ledger}`
    : `expiry: transaction cannot take effect; sign the step again for a fresh blockhash (slot ${at})`);
});
