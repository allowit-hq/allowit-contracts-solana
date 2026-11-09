import {Buffer} from 'buffer';
import {Message, PublicKey, Transaction} from '@solana/web3.js';
import {getTransactionDecoder} from '@solana/kit';
import {ed25519} from '@noble/curves/ed25519.js';
import {sha256Hex} from '../runtime/hash';

const STORAGE_KEY = 'allowit.delegate.wallet-diagnostic.v1';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

interface DiagnosticInput {
  walletName: string; featureVersion: string; chain: string; action: 'approve' | 'revoke' | 'return';
  request: Uint8Array; returned: Uint8Array;
}
interface Instruction {
  program: string; accounts: string[]; data: Uint8Array;
}
interface Decoded {
  raw: Uint8Array; web3: Uint8Array; message: Message; instructions: Instruction[];
  signatures: Readonly<Record<string, Uint8Array | null>>;
}
interface InstructionReport {
  programId: string; dataLength: number; dataHash: string;
  computeUnitLimit?: number; computeUnitPriceMicroLamports?: string;
}
interface PacketReport {
  decoded: boolean; wireLength: number; messageLength?: number; messageHash?: string;
  web3MessageLength?: number; web3MessageHash?: string; instructionCount: number;
  instructions: InstructionReport[]; instructionsTruncated: boolean;
}
interface Comparison {
  rawMessageEqual: boolean; web3MessageEqual: boolean; expectedRawMatchesWeb3: boolean; returnedRawMatchesWeb3: boolean;
  payerChanged: boolean; blockhashChanged: boolean; keyOrderChanged: boolean; keySetChanged: boolean;
  privilegesChanged: boolean; signersChanged: boolean; originalSplChanged: boolean; memoChanged: boolean;
  computeInstructionsChanged: boolean; programOrderChanged: boolean;
}
export interface DelegateWalletDiagnostic {
  version: 1; capturedAtUTC: string; wallet: {name: string; featureVersion: string}; chain: string; action: 'approve' | 'revoke' | 'return';
  expected: PacketReport; returned: PacketReport; comparison: Comparison | null;
  addedPrograms: string[]; removedPrograms: string[];
  signatures?: {expectedCount: number; returnedCount: number; validForReturnedMessage: boolean; validForReviewedMessage: boolean};
  summary: string;
}

function decode(wire: Uint8Array): Decoded | null {
  try {
    if (wire.length > 8_192) return null;
    const decoded = getTransactionDecoder().decode(new Uint8Array(wire));
    const raw = Uint8Array.from(decoded.messageBytes);
    const transaction = Transaction.from(wire);
    return {raw, web3: Uint8Array.from(transaction.serializeMessage()), message: Message.from(raw), signatures: decoded.signatures,
      instructions: transaction.instructions.map(ix => ({program: ix.programId.toBase58(),
        accounts: ix.keys.map(key => key.pubkey.toBase58()), data: Uint8Array.from(ix.data)}))};
  } catch {return null;}
}

function compute(ix: Instruction): Pick<InstructionReport, 'computeUnitLimit' | 'computeUnitPriceMicroLamports'> {
  if (ix.program !== COMPUTE) return {};
  const data = Buffer.from(ix.data);
  if (data.length === 5 && data[0] === 2) return {computeUnitLimit: data.readUInt32LE(1)};
  if (data.length === 9 && data[0] === 3) return {computeUnitPriceMicroLamports: data.readBigUInt64LE(1).toString()};
  return {};
}

async function packetReport(wireLength: number, packet: Decoded | null, labels: Map<string, string>): Promise<PacketReport> {
  if (!packet) return {decoded: false, wireLength, instructionCount: 0, instructions: [], instructionsTruncated: false};
  return {decoded: true, wireLength, messageLength: packet.raw.length, messageHash: await sha256Hex(packet.raw),
    web3MessageLength: packet.web3.length, web3MessageHash: await sha256Hex(packet.web3), instructionCount: packet.instructions.length,
    instructions: await Promise.all(packet.instructions.slice(0, 32).map(async ix => ({
      programId: labels.get(ix.program)!, dataLength: ix.data.length, dataHash: await sha256Hex(ix.data), ...compute(ix),
    }))), instructionsTruncated: packet.instructions.length > 32};
}

function instructionEqual(a: Instruction, b: Instruction): boolean {
  return a.program === b.program && same(a.accounts, b.accounts) && equal(a.data, b.data);
}
function instructionsEqual(a: Instruction[], b: Instruction[]): boolean {
  return a.length === b.length && a.every((ix, index) => instructionEqual(ix, b[index]));
}
function roles(packet: Decoded): Map<string, string> {
  return new Map(packet.message.accountKeys.map((key, index) => [key.toBase58(), `${packet.message.isAccountSigner(index)}:${packet.message.isAccountWritable(index)}`]));
}
function validSignatures(packet: Decoded, message: Uint8Array): boolean {
  const entries = Object.entries(packet.signatures);
  return entries.length > 0 && entries.every(([key, signature]) => {
    try {return signature !== null && ed25519.verify(signature, message, new PublicKey(key).toBytes(), {zip215: false});}
    catch {return false;}
  });
}

/** Local diagnostics only. No raw packets, signatures, account addresses or memo contents enter the report. */
export async function buildDelegateWalletDiagnostic(input: DiagnosticInput): Promise<DelegateWalletDiagnostic> {
  // Capture both inputs before hashing yields; the wallet never receives these copies.
  const expected = decode(new Uint8Array(input.request)), returned = decode(new Uint8Array(input.returned));
  const packets = [expected, returned].filter((packet): packet is Decoded => packet !== null);
  const sensitive = new Set<string>();
  for (const packet of packets) {
    const programs = new Set(packet.instructions.map(ix => ix.program));
    packet.message.accountKeys.forEach((key, index) => {
      if (!programs.has(key.toBase58()) || packet.message.isAccountSigner(index)) sensitive.add(key.toBase58());
    });
    packet.instructions.forEach(ix => ix.accounts.forEach(key => sensitive.add(key)));
  }
  const labels = new Map<string, string>();
  for (const program of new Set(packets.flatMap(packet => packet.instructions.map(ix => ix.program)))) {
    labels.set(program, sensitive.has(program) ? `redacted-account:${(await sha256Hex(new PublicKey(program).toBytes())).slice(0, 16)}` : program);
  }
  const text = (value: string, length: number) => {
    for (const key of sensitive) value = value.replaceAll(key, '[account]');
    return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);
  };
  const report: DelegateWalletDiagnostic = {version: 1, capturedAtUTC: new Date().toISOString(),
    wallet: {name: text(input.walletName, 64), featureVersion: text(input.featureVersion, 32)}, chain: text(input.chain, 64), action: input.action,
    expected: await packetReport(input.request.length, expected, labels), returned: await packetReport(input.returned.length, returned, labels),
    comparison: null, addedPrograms: [], removedPrograms: [], summary: 'Changes: the returned packet could not be decoded.'};
  if (!expected || !returned) return report;
  const beforeKeys = expected.message.accountKeys.map(key => key.toBase58()), afterKeys = returned.message.accountKeys.map(key => key.toBase58());
  const beforeRoles = roles(expected), afterRoles = roles(returned);
  const beforePrograms = expected.instructions.map(ix => ix.program), afterPrograms = returned.instructions.map(ix => ix.program);
  const beforeSigners = beforeKeys.slice(0, expected.message.header.numRequiredSignatures), afterSigners = afterKeys.slice(0, returned.message.header.numRequiredSignatures);
  const comparison: Comparison = {
    rawMessageEqual: equal(expected.raw, returned.raw), web3MessageEqual: equal(expected.web3, returned.web3),
    expectedRawMatchesWeb3: equal(expected.raw, expected.web3), returnedRawMatchesWeb3: equal(returned.raw, returned.web3),
    payerChanged: beforeKeys[0] !== afterKeys[0], blockhashChanged: expected.message.recentBlockhash !== returned.message.recentBlockhash,
    keyOrderChanged: !same(beforeKeys, afterKeys), keySetChanged: !same([...beforeKeys].sort(), [...afterKeys].sort()),
    privilegesChanged: beforeKeys.some(key => afterRoles.has(key) && beforeRoles.get(key) !== afterRoles.get(key)),
    signersChanged: !same(beforeSigners, afterSigners), programOrderChanged: !same(beforePrograms, afterPrograms),
    originalSplChanged: !instructionsEqual(expected.instructions.filter(ix => ix.program === TOKEN), returned.instructions.filter(ix => ix.program === TOKEN)),
    memoChanged: !instructionsEqual(expected.instructions.filter(ix => ix.program === MEMO), returned.instructions.filter(ix => ix.program === MEMO)),
    computeInstructionsChanged: !instructionsEqual(expected.instructions.filter(ix => ix.program === COMPUTE), returned.instructions.filter(ix => ix.program === COMPUTE)),
  };
  report.comparison = comparison;
  report.addedPrograms = [...new Set(afterPrograms)].filter(program => !beforePrograms.includes(program)).map(program => labels.get(program)!);
  report.removedPrograms = [...new Set(beforePrograms)].filter(program => !afterPrograms.includes(program)).map(program => labels.get(program)!);
  report.signatures = {expectedCount: Object.keys(expected.signatures).length, returnedCount: Object.keys(returned.signatures).length,
    validForReturnedMessage: validSignatures(returned, returned.raw), validForReviewedMessage: validSignatures(returned, expected.raw)};
  const changes: string[] = [];
  for (const [flag, label] of [
    ['payerChanged', 'payer'], ['blockhashChanged', 'blockhash'], ['keySetChanged', 'account set'], ['keyOrderChanged', 'account order'],
    ['privilegesChanged', 'account privileges'], ['signersChanged', 'signers'], ['originalSplChanged', 'SPL instruction'],
    ['memoChanged', 'memo'], ['computeInstructionsChanged', 'compute budget instructions'], ['programOrderChanged', 'program order'],
  ] as const) if (comparison[flag]) changes.push(label);
  const settings = (packet: Decoded, field: 'computeUnitLimit' | 'computeUnitPriceMicroLamports') => packet.instructions
    .map(ix => compute(ix)[field]).filter(value => value !== undefined).join(',') || 'absent';
  for (const [field, label] of [['computeUnitLimit', 'CU limit'], ['computeUnitPriceMicroLamports', 'priority fee']] as const) {
    const before = settings(expected, field), after = settings(returned, field);
    if (before !== after) changes.push(`${label} ${before} → ${after}${field === 'computeUnitPriceMicroLamports' ? ' microLamports/CU' : ''}`);
  }
  changes.push(...report.addedPrograms.slice(0, 4).map(program => `added program ${program}`));
  changes.push(...report.removedPrograms.slice(0, 4).map(program => `removed program ${program}`));
  changes.push(`raw message ${comparison.rawMessageEqual ? 'unchanged' : 'changed'}`, `reserialized message ${comparison.web3MessageEqual ? 'unchanged' : 'changed'}`);
  report.summary = `Changes: ${changes.join('; ')}.`.slice(0, 1_024);
  return report;
}

/** Best effort storage cannot mask or relax the caller's original rejection. Never sends diagnostics. */
export async function recordDelegateWalletDiagnostic(input: DiagnosticInput): Promise<string> {
  try {
    const report = await buildDelegateWalletDiagnostic(input);
    const encoded = JSON.stringify(report);
    if (encoded.length <= 16_384) {
      try {localStorage.setItem(STORAGE_KEY, encoded);} catch {/* Optional local recovery information. */}
    }
    return report.summary;
  } catch {return 'Changes: diagnostic details are unavailable.';}
}
