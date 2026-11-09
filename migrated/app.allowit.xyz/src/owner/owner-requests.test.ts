import {afterEach, describe, expect, it, vi} from 'vitest';
import {ApiError} from '../api';
import {answerRequest, httpOwnerApi, intentKey, MAX_NOTE_BYTES, noteBytes, noteProblem, ownerProofs, parseAnswer, parseInbox, payshLimits, nativePurchase, proofKey, readMessage, reconcileProof, refProofs, resendProof, settleProofs, strictJson, validateChallenge, type Decision, type OwnerApi, type OwnerRequest, type ProofStore} from './owner-requests';
import {simulatesAnswers} from '../request-status';
import specimen from '../paysh/fixtures/paysh-owner-binding-specimen.json' with {type: 'json'};

const ORIGIN = 'https://app.allowit.xyz';
const OWNER = 'Own3rAddr1111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111';
const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;
const HASH = 'a'.repeat(64);
const SIG = btoa(String.fromCharCode(...new Uint8Array(64).fill(7)));
const SIG2 = btoa(String.fromCharCode(...new Uint8Array(64).fill(9)));
const NOTICE = 'Answer/start by the expiry below. After the first native authorization is signed, remaining stages may finish later, subject to their original native request expiry, policy expiry, pause and hard limits.';

const RECIPIENT = `Vendor${'1'.repeat(38)}`;
const MINT = `TestMint${'1'.repeat(36)}`;
const INPUT = {location: {latitude: 19.4326, longitude: -99.1332}, universalAqi: true};

const item: OwnerRequest = {
  kind: 'paysh',
  owner: OWNER,
  origin: '',
  policyId: 'pol_a',
  requestId: 'req_1',
  status: 'awaiting_input',
  question: 'Is this lookup a reasonable purchase for the stated task?',
  purpose: 'Current air quality for Mexico City',
  network: 'solana:testnet',
  inputHash: HASH,
  scope: {serviceId: 'air-quality', operation: 'lookup'},
  envelope: quote(1000),
  scoreBps: 6200,
  thresholdBps: 7500,
  expiresAt: SEC + 600,
  decisionHistory: [],
};
/** A PaySH envelope whose caps equal its original quote, as the backend issues it. */
function quote(amountUsdc: number, over: Record<string, unknown> = {}) {
  return {allocationLamports: 50_000_000, input: INPUT, mint: MINT, recipient: RECIPIENT, serviceId: 'air-quality', originalAmountUsdc: amountUsdc, originalSwap: {type: 'swap', amountInLamports: 100_000, minOutUsdc: amountUsdc}, originalServiceFeeLamportsPerExecution: 5000, maxPaymentUsdc: amountUsdc, maxSwapLamports: 100_000, minSwapOutputUsdc: amountUsdc, maxServiceFeeLamportsPerExecution: 5000, maxExecutions: 2, maxTotalServiceFeeLamports: 10_000, scoreBps: 6200, thresholdBps: 7500, ...over};
}
/** The next question the same request asks after a Yes. */
const second: OwnerRequest = {...item, inputHash: 'b'.repeat(64), question: 'Is the follow-up lookup reasonable?', envelope: quote(400)};
const without = <T extends Record<string, unknown>>(v: T, ...keys: string[]) => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));

const binding = (r: OwnerRequest, over: Record<string, unknown> = {}) => ({kind: r.kind, origin: ORIGIN, owner: OWNER, network: r.network, policyId: r.policyId, requestId: r.requestId, inputHash: r.inputHash, question: r.question, purpose: r.purpose, scope: r.scope, envelope: r.envelope, ...over});
const meaning = (r: OwnerRequest) => (r.kind === 'paysh' ? 'answer_and_start_deadline' : 'answer_deadline');
const content = (r: OwnerRequest, decision: Decision, decisionId: string, over: Record<string, unknown> = {}) => ({
  domain: 'allowit-owner-decision',
  version: 1,
  origin: ORIGIN,
  decision,
  nonce: decisionId,
  issuedAt: SEC,
  expiresAt: SEC + 300,
  expiryMeaning: meaning(r),
  binding: binding(r),
  ...over,
});
/** The server's readable message: fixed header, fixed notice, pretty-printed JSON. */
const message = (decision: Decision, body: unknown, notice = NOTICE) => `AllowIt owner decision v1\nAnswer: ${decision === 'yes' ? 'Yes' : 'No'}\n${notice}\n${JSON.stringify(body, null, 2)}`;
/**
 * PaySH challenges name a start deadline equal to the expiry; generic challenges omit it. Every challenge names its note,
 * empty or not; the signed content names it only when it is not empty, as the backend serializes it.
 */
const challenge = (r: OwnerRequest, decision: Decision, decisionId = 'dec_1', over: Record<string, unknown> = {}, signed: Record<string, unknown> = {}, note = '') => ({
  decisionId,
  message: message(decision, content(r, decision, decisionId, {...(note ? {note} : {}), ...signed})),
  expiresAt: SEC + 300,
  expiryMeaning: meaning(r),
  ...(r.kind === 'paysh' ? {startDeadline: SEC + 300} : {}),
  decision,
  binding: binding(r),
  note,
  ...over,
});

function memoryStore(): ProofStore & {m: Map<string, string>} {
  const m = new Map<string, string>();
  return {m, read: k => m.get(k) ?? null, write: (k, v) => void m.set(k, v), remove: k => void m.delete(k), keys: () => [...m.keys()]};
}

/** An owner API double: a list, numbered challenges for whatever the list currently shows, and answers by decision. */
function setup(list: unknown[] = [item]) {
  const store = memoryStore();
  let requests = list;
  let issued = 0;
  const decisions = new Map<string, Decision>();
  const notes = new Map<string, string>();
  let clock = NOW;
  const find = (b: {policyId: string; requestId: string}) => requests.find(r => (r as OwnerRequest).policyId === b.policyId && (r as OwnerRequest).requestId === b.requestId) as OwnerRequest | undefined;
  const api = {
    list: vi.fn<OwnerApi['list']>(async () => ({requests})),
    challenge: vi.fn<OwnerApi['challenge']>(async b => {
      const decisionId = `dec_${++issued}`;
      decisions.set(decisionId, b.decision);
      notes.set(decisionId, b.note);
      return challenge(find(b) ?? item, b.decision, decisionId, {}, {}, b.note);
    }),
    answer: vi.fn<OwnerApi['answer']>(async b => {
      // As the backend does: a note other than the signed one is refused.
      if (b.note !== notes.get(b.decisionId)) throw new ApiError('The owner note does not match the signed answer.', 409);
      const approved = decisions.get(b.decisionId) === 'yes';
      return {kind: b.kind, policyId: b.policyId, requestId: b.requestId, status: approved ? 'owner_approved' : 'denied', approved, decisionId: b.decisionId, answeredAt: SEC + 5, note: b.note};
    }),
    session: vi.fn<OwnerApi['session']>(async () => OWNER),
  };
  const env = {api, store, origin: ORIGIN, now: () => clock};
  const signer = {owner: OWNER, current: vi.fn(() => true), sign: vi.fn(async (_m: string) => SIG)};
  return {env, api, store, signer, setList: (next: unknown[]) => void (requests = next), advance: (ms: number) => void (clock += ms)};
}
const only = (store: ProofStore) => {
  const all = ownerProofs(store, ORIGIN, OWNER);
  expect(all).toHaveLength(1);
  return all[0];
};

describe('signed message content', () => {
  const micro: OwnerRequest = {...item, kind: 'micro', envelope: {amount: '3.50', token: 'USDC'}};

  it.each([
    ['a payment cap above the original amount', quote(1000, {maxPaymentUsdc: 5000})],
    ['a swap cap above the original swap input', quote(1000, {maxSwapLamports: 200_000})],
    ['a minimum swap output below the original minimum', quote(1000, {minSwapOutputUsdc: 1})],
    ['a fee cap above the original fee', quote(1000, {maxServiceFeeLamportsPerExecution: 9000})],
    ['a total fee above the per-execution fee times executions', quote(1000, {maxTotalServiceFeeLamports: 10_001})],
    ['three executions', quote(1000, {maxExecutions: 3, maxTotalServiceFeeLamports: 15_000})],
    ['no swap with a swap cap', quote(1000, {originalSwap: null})],
    ['no swap with two executions', quote(1000, {originalSwap: null, maxSwapLamports: 0, minSwapOutputUsdc: 0, maxExecutions: 2, maxTotalServiceFeeLamports: 10_000})],
    ['a swap with one execution', quote(1000, {maxExecutions: 1, maxTotalServiceFeeLamports: 5000})],
    ['an amount as text', quote(1000, {originalAmountUsdc: '1000', maxPaymentUsdc: '1000'})],
    ['an unknown limit', quote(1000, {payee: RECIPIENT})],
    ['a missing original quote', without(quote(1000), 'originalSwap')],
    ['an empty recipient', quote(1000, {recipient: ''})],
    ['a recipient as a number', quote(1000, {recipient: 42})],
    ['a recipient that is not a base58 address', quote(1000, {recipient: `Vend0r${'1'.repeat(38)}`})],
    ['a recipient too short for an address', quote(1000, {recipient: 'Vendor1111'})],
    ['a null mint', quote(1000, {mint: null})],
    ['a mint that is not an address', quote(1000, {mint: 'test token'})],
    ['an allocation as text', quote(1000, {allocationLamports: '50000000'})],
    ['a negative allocation', quote(1000, {allocationLamports: -1})],
    ['a fractional allocation', quote(1000, {allocationLamports: 1.5})],
    ['an unsafe allocation', quote(1000, {allocationLamports: 2 ** 53})],
    ['a null input', quote(1000, {input: null})],
    ['an input list', quote(1000, {input: [INPUT]})],
    ['an input as text', quote(1000, {input: JSON.stringify(INPUT)})],
    ['an oversized input', quote(1000, {input: {query: 'x'.repeat(4000)}})],
  ])('refuses a PaySH envelope with %s before any wallet prompt', (_name, envelope) => {
    const wide: OwnerRequest = {...item, envelope};
    expect(payshLimits(envelope)).toBeNull();
    expect(() => validateChallenge(challenge(wide, 'yes'), wide, 'yes', OWNER, ORIGIN, NOW)).toThrow(/original quote/);
  });

  it('refuses a no-swap quote that allows a second fee-bearing execution before any wallet prompt', async () => {
    const twice: OwnerRequest = {...item, envelope: quote(1000, {originalSwap: null, maxSwapLamports: 0, minSwapOutputUsdc: 0, maxExecutions: 2, maxTotalServiceFeeLamports: 10_000})};
    const {env, api, signer} = setup([twice]);
    expect(await answerRequest(env, signer, twice, 'yes')).toMatchObject({type: 'kept', note: expect.stringMatching(/original quote.*Nothing was signed/)});
    expect(signer.sign).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
  });

  describe('PaySH start deadline', () => {
    it.each([
      ['no listed deadline', {...item, expiresAt: undefined}, /no answer-and-start deadline/],
      ['a challenge deadline later than the listed one', {...item, expiresAt: SEC + 299}, /later than the deadline shown/],
    ])('refuses %s before any wallet prompt', async (_name, shown, why) => {
      expect(() => validateChallenge(challenge(shown, 'yes'), shown, 'yes', OWNER, ORIGIN, NOW)).toThrow(why);
      const {env, api, signer, store} = setup([shown]);
      expect(await answerRequest(env, signer, shown, 'yes')).toMatchObject({type: 'kept', note: expect.stringMatching(why)});
      expect(signer.sign).not.toHaveBeenCalled();
      expect(api.answer).not.toHaveBeenCalled();
      expect(store.m.size).toBe(0);
    });
  });

  it('keeps a quoted newline inside the JSON, so a question cannot forge an answer line', () => {
    const tricky: OwnerRequest = {...item, question: 'Fine?\nAnswer: No'};
    const c = validateChallenge(challenge(tricky, 'yes'), tricky, 'yes', OWNER, ORIGIN, NOW);
    expect(c.message.split('\n').filter(l => /^Answer:/.test(l))).toEqual(['Answer: Yes']);
    expect(readMessage(c.message)?.decision).toBe('yes');
  });

  it.each([
    ['another policy', {binding: binding(item, {policyId: 'pol_b'})}, {}],
    ['another request', {binding: binding(item, {requestId: 'req_2'})}, {}],
    ['another kind', {binding: binding(item, {kind: 'micro'})}, {}],
    ['another owner', {binding: binding(item, {owner: OTHER})}, {}],
    ['another binding origin', {binding: binding(item, {origin: 'https://evil.example'})}, {}],
    ['another network', {binding: binding(item, {network: 'solana:mainnet'})}, {}],
    ['another input', {binding: binding(item, {inputHash: 'c'.repeat(64)})}, {}],
    ['another question', {binding: binding(item, {question: 'Anything goes?'})}, {}],
    ['another purpose', {binding: binding(item, {purpose: 'Something else'})}, {}],
    ['a wider scope', {binding: binding(item, {scope: {...item.scope, operation: '*'}})}, {}],
    ['a larger envelope', {binding: binding(item, {envelope: quote(1_000_000)})}, {}],
    ['an unknown binding field', {binding: binding(item, {extra: true})}, {}],
    ['a missing binding field', {binding: {...binding(item), purpose: undefined}}, {}],
    ['an unknown challenge field', {origin: ORIGIN}, {}],
    ['the other answer', {decision: 'no'}, {}],
    ['an expired challenge', {expiresAt: SEC}, {expiresAt: SEC}],
    ['a challenge longer than five minutes', {expiresAt: SEC + 3600, startDeadline: SEC + 3600}, {expiresAt: SEC + 3600}],
    ['a missing decision ID', {decisionId: ''}, {}],
    ['a missing binding', {binding: undefined}, {}],
    ['signed content for another site', {}, {origin: 'https://evil.example'}],
    ['signed content with the other answer', {}, {decision: 'no'}],
    ['signed content for another nonce', {}, {nonce: 'dec_other'}],
    ['signed content with another expiry', {}, {expiresAt: SEC + 200}],
    ['signed content with an upper-case decision', {}, {decision: 'Yes'}],
    ['signed content issued too early for its expiry', {}, {issuedAt: SEC - 1}],
    ['signed content issued in the future', {}, {issuedAt: SEC + 299}],
    ['signed content for another domain', {}, {domain: 'allowit-sign-in'}],
    ['signed content of another version', {}, {version: 2}],
    ['signed content with an unknown field', {}, {note: 'x'}],
    ['signed content without a binding', {}, {binding: undefined}],
    ['a signed binding for another owner', {}, {binding: binding(item, {owner: OTHER})}],
    ['a signed binding with a larger envelope', {}, {binding: binding(item, {envelope: quote(9999)})}],
    ['a challenge binding with another recipient', {binding: binding(item, {envelope: quote(1000, {recipient: `Other${'1'.repeat(39)}`})})}, {}],
    ['a challenge binding with another mint', {binding: binding(item, {envelope: quote(1000, {mint: `Other${'1'.repeat(39)}`})})}, {}],
    ['a signed binding with another recipient', {}, {binding: binding(item, {envelope: quote(1000, {recipient: `Other${'1'.repeat(39)}`})})}],
    ['a signed binding with another input', {}, {binding: binding(item, {envelope: quote(1000, {input: {...INPUT, universalAqi: false}})})}],
    ['a signed binding with another allocation', {}, {binding: binding(item, {envelope: quote(1000, {allocationLamports: 50_000_001})})}],
    ['a signed binding with an unknown field', {}, {binding: binding(item, {extra: 1})}],
    ['a signed binding without its origin', {}, {binding: without(binding(item), 'origin')}],
    ['a generic expiry meaning in the signed PaySH content', {}, {expiryMeaning: 'answer_deadline'}],
    ['a generic expiry meaning in the PaySH challenge', {expiryMeaning: 'answer_deadline'}, {}],
    ['a start deadline after the expiry', {startDeadline: SEC + 301}, {}],
    ['a start deadline in the signed content', {}, {startDeadline: SEC + 300}],
  ])('fails closed on %s', (_name, over, signed) => {
    const c = challenge(item, 'yes', 'dec_1', over, signed);
    expect(() => validateChallenge(c, item, 'yes', OWNER, ORIGIN, NOW)).toThrow(/Nothing was signed/);
  });

  const valid = () => message('yes', content(item, 'yes', 'dec_1'));
  it.each([
    ['an opaque digest', HASH],
    ['the earlier substring form', ['AllowIt owner answer', `Origin: ${ORIGIN}`, `Owner: ${OWNER}`, 'Policy: pol_a', 'Request: req_1', `Input: ${HASH}`, 'Answer: Yes'].join('\n')],
    ['a header for the other answer', valid().replace('Answer: Yes', 'Answer: No')],
    ['a lower-case header', valid().replace('Answer: Yes', 'answer: yes')],
    ['a second answer line in the notice', message('yes', content(item, 'yes', 'dec_1'), `${NOTICE}\nAnswer: No`)],
    ['a decision line in the notice', message('yes', content(item, 'yes', 'dec_1'), `Decision: No\n${NOTICE}`)],
    ['no notice', message('yes', content(item, 'yes', 'dec_1'), '').replace('\n\n', '\n')],
    ['structured data in the notice', message('yes', content(item, 'yes', 'dec_1'), `${NOTICE} {"decision":"no"}`)],
    ['a duplicated envelope key', valid().replace('"maxPaymentUsdc": 1000,', '"maxPaymentUsdc": 1000,\n      "maxPaymentUsdc": 1000000,')],
    ['a duplicated expiry meaning', valid().replace('"expiryMeaning": "answer_and_start_deadline",', '"expiryMeaning": "answer_and_start_deadline",\n  "expiryMeaning": "answer_deadline",')],
    ['a duplicated binding', valid().replace('"binding": {', '"binding": {},\n  "binding": {')],
    ['trailing text after the JSON', `${valid()}\nAnswer: No`],
    ['a bidirectional override', `${valid()}‮`],
    ['a left-to-right mark', `${valid()}\u200E`],
    ['a right-to-left mark', valid().replace('Answer: Yes', 'Answer: Yes\u200F')],
    ['an Arabic letter mark', `${valid()}\u061C`],
    ['a zero-width space', valid().replace('"decision": "yes"', '"decision": "y\u200Bes"')],
    ['a zero-width joiner', `${valid()}\u200D`],
    ['a zero-width joiner in the header', valid().replace('Answer: Yes', 'Answer: Ye\u200Ds')],
    ['a zero-width non-joiner in the notice', valid().replace(NOTICE, `${NOTICE}\u200C`)],
    ['a zero-width joiner in a signed field', valid().replace('"decision": "yes"', '"decision": "y\u200Des"')],
    ['a zero-width non-joiner in a signed key', valid().replace('"nonce":', '"non\u200Cce":')],
    ['a word joiner', `${valid()}\u2060`],
    ['a byte order mark', `\uFEFF${valid()}`],
    ['a C1 next-line control', valid().replace(NOTICE, `${NOTICE}\u0085Answer: No`)],
    ['a C1 control sequence introducer', `${valid()}\u009B`],
    ['a line separator', valid().replace(NOTICE, `${NOTICE}\u2028Answer: No`)],
    ['an unsafe integer', valid().replace('"maxExecutions": 2', '"maxExecutions": 9007199254740993')],
  ])('refuses a message with %s', (_name, text) => {
    expect(() => validateChallenge({...challenge(item, 'yes'), message: text}, item, 'yes', OWNER, ORIGIN, NOW)).toThrow(/Nothing was signed/);
  });

  it('refuses hidden characters in listed and signed values, and keeps ordinary tabs and quoted newlines', () => {
    const tabbed: OwnerRequest = {...item, question: 'Fine?\tStill fine?\nYes.'};
    expect(() => validateChallenge(challenge(tabbed, 'yes'), tabbed, 'yes', OWNER, ORIGIN, NOW)).not.toThrow();
    const hidden = ['\u200C', '\u200D', '\u200E', '\u200F', '\u200B', '\uFEFF', '\u0085', '\u202E', '\u2066'];
    const parsed = parseInbox(
      {requests: [item, ...hidden.flatMap((c, n) => [{...item, requestId: `req_q${n}`, question: `Fine${c}?`}, {...item, requestId: `req_s${n}`, scope: {...item.scope, operation: `look${c}up`}}, {...item, requestId: `req_k${n}`, envelope: {...item.envelope, [`note${c}`]: 1}}])]},
      OWNER,
      ORIGIN,
    );
    expect(parsed.items.map(i => i.requestId)).toEqual(['req_1']);
    expect(parsed.unreadable).toBe(hidden.length * 3);
    // An escaped hidden character in the signed JSON is refused once read, even though the message text is plain ASCII.
    // The shown request and challenge carry the same value, so only the hidden-character check can refuse it.
    const disguised: OwnerRequest = {...item, scope: {...item.scope, operation: 'look\u202Eup'}};
    const escaped = challenge(disguised, 'yes');
    escaped.message = escaped.message.replace('\u202E', '\\u202E');
    expect(escaped.message).not.toMatch(/[^\x00-\x7F]/);
    expect(() => validateChallenge(escaped, disguised, 'yes', OWNER, ORIGIN, NOW)).toThrow(/binding could not be read/);
    expect(() => validateChallenge({...escaped, binding: binding(item)}, {...disguised, scope: item.scope}, 'yes', OWNER, ORIGIN, NOW)).toThrow(/message is not in the expected form/);
  });

  it('parses JSON strictly', () => {
    expect(strictJson('{"a":{"b":[1,"x",true,null]}}')).toEqual({a: {b: [1, 'x', true, null]}});
    for (const bad of ['{"a":1,"a":1}', '{"a":{"b":1,"b":2}}', '{"a":"line\nbreak"}', '{"a":1}x', '{"a":01}', '{"a":1e400}', '{"a":12345678901234567890}', "{'a':1}"]) expect(() => strictJson(bad), bad).toThrow();
  });
});

/*
 * Regression specimen of the PaySH owner decision in the backend's actual production owner-binding serialization: the
 * owner inbox list and the challenge, as produced by the production owner inbox, challenge and binding code without a
 * chain, model, signature or stored decision. Authority, addresses, hashes, config bytes and byte arrays are replaced
 * with fakes; the shape and types are unchanged, and it holds no signature, session or capability. It is checked at its
 * own issuedAt, because the challenge is deliberately short-lived. It is not acceptance evidence.
 */
describe('PaySH owner-binding specimen in the production wire shape', () => {
  type J = Record<string, unknown>;
  const AT = 'http://localhost:5173';
  const KEY = specimen.challenge.binding.owner;
  const MESSAGE = specimen.challenge.message;
  const PREFIX = MESSAGE.slice(0, MESSAGE.indexOf('\n{\n') + 1);
  const SIGNED = readMessage(MESSAGE)!.content;
  const ISSUED = SIGNED.issuedAt as number;
  const EXPIRES = specimen.challenge.expiresAt;
  const at = ISSUED * 1000;
  /** The server prints the signed JSON after a fixed prefix, pretty-printed with two spaces. */
  const print = (signed: unknown) => PREFIX + JSON.stringify(signed, null, 2);
  const envelopeOf = (o: unknown) => (o as J).envelope as J;
  /**
   * The specimen, optionally edited: `envelope` edits the envelope everywhere it appears (listed item, challenge binding
   * and signed binding), so only the envelope rules can refuse it; `edit` edits the challenge and the signed JSON.
   */
  function spec(envelope: (e: J) => void = () => {}, edit: (c: J, signed: J) => void = () => {}) {
    const listed = structuredClone(specimen.inbox) as J[];
    // The specimen predates the owner note; the backend now names the (empty) note in every challenge. Its signed
    // message has no note, which is the unchanged empty-note form.
    const c = {...structuredClone(specimen.challenge), note: ''} as J;
    const signed = structuredClone(SIGNED);
    for (const e of [envelopeOf(listed[0]), envelopeOf(c.binding), envelopeOf(signed.binding)]) envelope(e);
    edit(c, signed);
    c.message = print(signed);
    const parsed = parseInbox({requests: listed}, KEY, AT);
    expect(parsed.unreadable).toBe(0);
    return {challenge: c as J & {message: string}, shown: parsed.items[0]};
  }
  const check = (s: ReturnType<typeof spec>, nowMs = at) => validateChallenge(s.challenge, s.shown, 'yes', KEY, AT, nowMs);

  const other = 'FakeOtherVendor11111111111111111111111111111';

  it('refuses a challenge expiry later than the listed answer-and-start deadline', () => {
    const s = spec();
    expect(() => validateChallenge(s.challenge, {...s.shown, expiresAt: EXPIRES - 1}, 'yes', KEY, AT, at)).toThrow(/later than the deadline shown/);
  });

  function specEnv(reply: unknown, listed: OwnerRequest) {
    const store = memoryStore();
    const api = {
      list: vi.fn<OwnerApi['list']>(async () => ({requests: [listed]})),
      challenge: vi.fn<OwnerApi['challenge']>(async () => reply),
      answer: vi.fn<OwnerApi['answer']>(async b => ({kind: 'paysh', policyId: b.policyId, requestId: b.requestId, status: 'owner_approved', approved: true, decisionId: b.decisionId, answeredAt: ISSUED + 5, note: b.note})),
      session: vi.fn<OwnerApi['session']>(async () => KEY),
    };
    const signer = {owner: KEY, current: () => true, sign: vi.fn(async (_m: string) => SIG)};
    return {env: {api, store, origin: AT, now: () => at}, api, store, signer};
  }

  it('signs the exact specimen bytes once and resends the identical signature after a lost reply', async () => {
    const s = spec();
    const {env, api, signer, store} = specEnv(s.challenge, s.shown);
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    expect((await answerRequest(env, signer, s.shown, 'yes')).type).toBe('unconfirmed');
    expect(signer.sign).toHaveBeenCalledWith(MESSAGE);
    const proof = ownerProofs(store, AT, KEY)[0];
    expect(proof).toMatchObject({message: MESSAGE, signature: SIG, decisionId: specimen.challenge.decisionId, expiresAt: EXPIRES});
    expect((await resendProof(env, signer, proof)).type).toBe('answered');
    const ref = {kind: 'paysh', policyId: specimen.challenge.binding.policyId, requestId: specimen.challenge.binding.requestId};
    expect(api.answer.mock.calls.map(([b]) => b)).toEqual([0, 1].map(() => ({...ref, decisionId: specimen.challenge.decisionId, signature: SIG, note: ''})));
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
});

describe('owner request list', () => {
  it('keeps only this owner and this origin, and reads history', () => {
    const history = [{decisionId: 'dec_0', approved: true, answeredAt: SEC - 60, expiresAt: SEC - 30, origin: ORIGIN}];
    const parsed = parseInbox(
      {
        requests: [
          {...item, decisionHistory: history},
          {...item, requestId: 'req_other_owner', owner: OTHER},
          {...item, requestId: 'req_other_site', origin: 'https://evil.example'},
          {...item, requestId: 'req_signed_here', origin: ORIGIN},
          {...item, requestId: 'req_no_owner', owner: undefined},
        ],
      },
      OWNER,
      ORIGIN,
    );
    expect(parsed.items.map(i => i.requestId)).toEqual(['req_1', 'req_signed_here']);
    expect(parsed.items[0].decisionHistory).toEqual(history);
    expect(parsed.unreadable).toBe(3);
  });

  it('drops unreadable and ambiguous items', () => {
    const past = {decisionId: 'dec_0', approved: true, answeredAt: SEC, expiresAt: SEC, origin: ORIGIN};
    const parsed = parseInbox(
      {
        requests: [
          item,
          {...item, requestId: 'req_2', scoreBps: 20000},
          {...item, policyId: 'dup'},
          {...item, policyId: 'dup'},
          {...item, requestId: 'req_3', approved: true, decisionId: 'dec_3'},
          {...item, requestId: 'req_4', status: 'owner_approved', approved: true},
          {...item, requestId: 'req_5', decisionHistory: [past, past]},
          {...item, requestId: 'req_6', status: 'owner_approved', approved: true, decisionId: 'dec_0', answeredAt: SEC, decisionHistory: [past]},
          {...item, requestId: 'req_7', decisionHistory: [{...past, origin: 'not an origin'}]},
        ],
      },
      OWNER,
      ORIGIN,
    );
    expect(parsed.items.map(i => i.requestId)).toEqual(['req_1']);
    expect(parsed.unreadable).toBe(8);
    expect(() => parseInbox({}, OWNER, ORIGIN)).toThrow();
  });
});

describe('answering a request', () => {
  it('re-reads the request, checks the owner before and after signing, signs the exact message and sends no caller boolean', async () => {
    const {env, api, signer, store} = setup();
    const out = await answerRequest(env, signer, item, 'yes');
    expect(out).toMatchObject({type: 'answered', earlier: false, answer: {status: 'owner_approved', approved: true, decisionId: 'dec_1'}});
    expect(api.list.mock.invocationCallOrder[0]).toBeLessThan(api.challenge.mock.invocationCallOrder[0]);
    expect(signer.sign).toHaveBeenCalledWith(challenge(item, 'yes').message);
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(api.session.mock.invocationCallOrder[0]).toBeLessThan(signer.sign.mock.invocationCallOrder[0]);
    expect(api.session.mock.invocationCallOrder[1]).toBeGreaterThan(signer.sign.mock.invocationCallOrder[0]);
    expect(api.answer).toHaveBeenCalledWith({kind: 'paysh', policyId: 'pol_a', requestId: 'req_1', decisionId: 'dec_1', signature: SIG, note: ''});
    expect(store.m.size).toBe(0);
  });

  it('keeps but does not send a signature when the owner changes while signing', async () => {
    const {env, api, signer, store} = setup();
    api.session.mockResolvedValueOnce(OWNER).mockResolvedValueOnce(OTHER);
    expect((await answerRequest(env, signer, item, 'yes')).type).toBe('unconfirmed');
    expect(api.answer).not.toHaveBeenCalled();
    expect(only(store).signature).toBe(SIG);
  });

  it('never opens a second wallet prompt while another tab is signing', async () => {
    const {env, api, signer} = setup();
    let release!: () => void;
    signer.sign.mockImplementationOnce(() => new Promise(r => (release = () => r(SIG))));
    const first = answerRequest(env, signer, item, 'yes');
    await vi.waitFor(() => expect(signer.sign).toHaveBeenCalledTimes(1));
    expect(await answerRequest(env, signer, item, 'no')).toEqual({type: 'kept', note: 'Another tab is waiting for your wallet to answer this request.'});
    release();
    expect((await first).type).toBe('answered');
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledTimes(1);
  });

  it('reconciles a proof another tab saved while this one waited for the lock, without a second wallet prompt', async () => {
    const {env, api, signer, store} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    await answerRequest(env, signer, item, 'yes');
    const other = only(store);
    store.m.clear();
    signer.sign.mockClear();
    // This tab found no saved proof and fetched its own challenge; meanwhile the other tab saved its signed answer.
    api.challenge.mockImplementationOnce(async b => {
      store.write(proofKey(ORIGIN, OWNER, item, other.decisionId), JSON.stringify(other));
      return challenge(item, b.decision, 'dec_9');
    });
    expect(await answerRequest(env, signer, item, 'no')).toMatchObject({type: 'unconfirmed'});
    expect(signer.sign).not.toHaveBeenCalled();
    expect(only(store).decisionId).toBe(other.decisionId);
    expect([...store.m.keys()].some(k => k.startsWith('allowit.owner-signing.v1:'))).toBe(false);
  });

  it('does not sign after the lock when another tab finished answering meanwhile', async () => {
    const {env, api, signer, store, setList} = setup();
    api.challenge.mockImplementationOnce(async b => {
      setList([{...item, status: 'denied', approved: false, answeredAt: SEC, decisionId: 'dec_other', origin: ORIGIN}]);
      return challenge(item, b.decision, 'dec_9');
    });
    expect(await answerRequest(env, signer, item, 'yes')).toMatchObject({type: 'already', item: {approved: false}});
    expect(signer.sign).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
    expect(store.m.size).toBe(0);
  });

  it('reviews a changed request again instead of signing it', async () => {
    const {env, signer} = setup([{...item, envelope: quote(5000)}]);
    expect((await answerRequest(env, signer, item, 'yes')).type).toBe('changed');
    expect(signer.sign).not.toHaveBeenCalled();
  });
});

describe('lost replies and saved proofs', () => {
  it('saves the exact proof on an unknown HTTP outcome, never signs again, and resends the identical proof only when asked', async () => {
    const {env, api, signer, store} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('The service could not be reached.', 0));
    expect(await answerRequest(env, signer, item, 'yes')).toMatchObject({type: 'unconfirmed', note: 'Answer signed. The server has not recorded it yet.'});
    const proof = only(store);
    expect(proof).toMatchObject({decision: 'yes', decisionId: 'dec_1', signature: SIG, message: challenge(item, 'yes').message, intent: intentKey(item), ref: {kind: 'paysh', policyId: 'pol_a', requestId: 'req_1'}});
    expect(Object.keys(proof).sort()).toEqual(['decision', 'decisionId', 'expiresAt', 'intent', 'message', 'note', 'origin', 'owner', 'ref', 'signature', 'signedAt', 'v']);
    expect(proofKey(ORIGIN, OWNER, item, 'dec_1')).toContain(`${ORIGIN}|${OWNER}|paysh|pol_a|req_1|dec_1`);

    // Clicking again reconciles instead of opening the wallet.
    expect((await answerRequest(env, signer, item, 'no')).type).toBe('unconfirmed');
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledTimes(1);

    expect((await resendProof(env, signer, proof)).type).toBe('answered');
    expect(api.answer).toHaveBeenLastCalledWith({kind: 'paysh', policyId: 'pol_a', requestId: 'req_1', decisionId: 'dec_1', signature: SIG, note: ''});
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(store.m.size).toBe(0);
  });

  it('does not resend before the server list could be read', async () => {
    const {env, api, signer, store} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    await answerRequest(env, signer, item, 'yes');
    api.list.mockRejectedValueOnce(new ApiError('The service could not be reached.', 0));
    expect((await resendProof(env, signer, only(store))).type).toBe('unconfirmed');
    expect(api.answer).toHaveBeenCalledTimes(1);
  });

  it('clears a proof at once only for an invalid signature', async () => {
    const {env, api, signer, store} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('Session required.', 403));
    expect(await answerRequest(env, signer, item, 'yes')).toMatchObject({type: 'unconfirmed', note: 'Answer signed, not sent. Sign in again as the owner, then send the same answer.'});
    api.answer.mockRejectedValueOnce(new ApiError('Invalid signature.', 422));
    expect(await resendProof(env, signer, only(store))).toMatchObject({type: 'rejected'});
    expect(store.m.size).toBe(0);
  });

  it('clears an expiry refusal only once the server list agrees', async () => {
    const {env, api, signer, store, setList, advance} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    await answerRequest(env, signer, item, 'yes');
    const proof = only(store);
    // A 409 while the proof is still within its own expiry and the question still waits: kept.
    api.answer.mockRejectedValueOnce(new ApiError('Decision expired.', 409));
    expect((await resendProof(env, signer, proof)).type).toBe('unconfirmed');
    expect(store.m.size).toBe(1);
    // The server lists the question as expired: cleared, and not a No.
    setList([{...item, status: 'expired'}]);
    expect(await reconcileProof(env, proof)).toMatchObject({type: 'expired'});
    expect(store.m.size).toBe(0);

    // A signed challenge past its own expiry, refused with 409, while the question still waits: cleared, still pending.
    setList([item]);
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    await answerRequest(env, signer, item, 'no');
    advance(301_000);
    api.answer.mockRejectedValueOnce(new ApiError('Decision expired.', 409));
    expect(await resendProof(env, signer, only(store))).toMatchObject({type: 'expired', note: expect.stringContaining('still waits for you')});
    expect(store.m.size).toBe(0);
  });

  it('refuses to resend another owner’s proof', async () => {
    const {env, api, signer, store} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    await answerRequest(env, signer, item, 'yes');
    expect((await resendProof(env, {...signer, owner: OTHER}, only(store))).type).toBe('kept');
    expect(api.answer).toHaveBeenCalledTimes(1);
  });
});

describe('several questions under one request', () => {
  const recorded = (decisionId: string, approved = true) => ({decisionId, approved, answeredAt: SEC + 5, expiresAt: SEC + 300, origin: ORIGIN});

  it('never lets an unconfirmed proof for an earlier question stand in for the current one', async () => {
    const {env, api, signer, store, setList} = setup();
    api.answer.mockRejectedValueOnce(new ApiError('The service could not be reached.', 0));
    await answerRequest(env, signer, item, 'yes');
    // History does not name the saved decision (for example, it was answered elsewhere first).
    setList([{...second, decisionHistory: [recorded('dec_elsewhere', false)]}]);
    const old = only(store);
    expect(await reconcileProof(env, old)).toMatchObject({type: 'unconfirmed', note: expect.stringContaining('earlier question')});
    expect(settleProofs(env, OWNER, [{...second, decisionHistory: [recorded('dec_elsewhere', false)]}])).toEqual([]);
    // The second question gets its own challenge and signature; the old proof is neither reused nor sent.
    expect(refProofs(store, ORIGIN, OWNER, second).filter(p => p.intent === intentKey(second))).toEqual([]);
    expect((await answerRequest(env, signer, second, 'yes')).type).toBe('answered');
    expect(api.answer).toHaveBeenLastCalledWith(expect.objectContaining({decisionId: 'dec_2'}));
    expect(api.answer).not.toHaveBeenCalledWith(expect.objectContaining({decisionId: 'dec_1', requestId: 'req_1', signature: SIG2}));
    expect(refProofs(store, ORIGIN, OWNER, item).map(p => p.decisionId)).toEqual(['dec_1']);
  });
});

describe('owner request replies', () => {
  it('checks the answer reply against the signed answer and its decision', () => {
    const ok = {kind: 'paysh', policyId: 'pol_a', requestId: 'req_1', decisionId: 'dec_1', answeredAt: SEC};
    expect(parseAnswer({...ok, status: 'denied', approved: false}, item, 'no', 'dec_1').status).toBe('denied');
    expect(parseAnswer({...ok, status: 'submitted', approved: true}, item, 'yes', 'dec_1').status).toBe('submitted');
    expect(() => parseAnswer({...ok, status: 'owner_approved', approved: false}, item, 'no', 'dec_1')).toThrow();
    expect(() => parseAnswer({...ok, status: 'denied', approved: true}, item, 'no', 'dec_1')).toThrow();
    expect(() => parseAnswer({...ok, status: 'owner_approved', approved: true}, item, 'yes', 'dec_2')).toThrow();
    expect(() => parseAnswer({...ok, status: 'owner_approved', approved: true, answeredAt: undefined}, item, 'yes', 'dec_1')).toThrow();
    expect(() => parseAnswer({...ok, policyId: 'pol_b', status: 'owner_approved', approved: true}, item, 'yes', 'dec_1')).toThrow();
    expect(parseAnswer({...ok, kind: 'micro', status: 'ready', approved: true, policies: []}, {...item, kind: 'micro'}, 'yes', 'dec_1').approved).toBe(true);
  });
});

describe('Local dev simulation boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('allows wallet-free simulated answers only for a local:dev policy in the local_* workspace', () => {
    expect(simulatesAnswers('local:dev', 'local_abc', 'local:dev')).toBe(true);
    expect(simulatesAnswers('solana:testnet', 'local_abc', 'local:dev')).toBe(false);
    expect(simulatesAnswers('local:dev', OWNER, 'local:dev')).toBe(false);
    expect(simulatesAnswers('local:dev', 'local_abc', 'solana:testnet')).toBe(false);
    expect(simulatesAnswers('local:dev', undefined, 'local:dev')).toBe(false);
  });

  it('never treats a Local dev session as a signing owner', async () => {
    const reply = (session: unknown) => vi.fn(async () => new Response(JSON.stringify({session}), {status: 200, headers: {'content-type': 'application/json'}}));
    vi.stubGlobal('fetch', reply({address: 'local_abc', network: 'local:dev'}));
    expect(await httpOwnerApi.session()).toBeNull();
    vi.stubGlobal('fetch', reply({address: OWNER, network: 'solana:testnet'}));
    expect(await httpOwnerApi.session()).toBe(OWNER);
  });
});

describe('owner note', () => {
  /** Leading and trailing spaces and a line break are part of the note; nothing trims them. */
  const NOTE = '  Groceries only, never alcohol.\nAsk again above 20.  ';
  const withNote = (decision: Decision, note: string, over: Record<string, unknown> = {}, signed: Record<string, unknown> = {}) => challenge(item, decision, 'dec_1', over, signed, note);
  const lost = async (note: string) => {
    const s = setup();
    s.api.answer.mockRejectedValueOnce(new ApiError('Backend reply unavailable.', 502));
    expect((await answerRequest(s.env, s.signer, item, 'yes', undefined, note)).type).toBe('unconfirmed');
    return s;
  };

  it('bounds a note by UTF-8 bytes, not characters, and refuses hidden or control characters', () => {
    expect(MAX_NOTE_BYTES).toBe(2000);
    for (const ok of ['', 'x'.repeat(2000), '€'.repeat(666), '🙂'.repeat(500), NOTE, 'tab\tand\nline', 'ünïcödé 日本語']) expect(noteProblem(ok), ok.slice(0, 20)).toBeNull();
    expect(noteBytes('€'.repeat(667))).toBe(2001);
    expect('€'.repeat(667).length).toBe(667);
    for (const long of ['x'.repeat(2001), '€'.repeat(667), '🙂'.repeat(501), `${'x'.repeat(1999)}é`]) expect(noteProblem(long)).toBe('too_long');
    for (const hidden of ['a‮b', 'a​b', 'a‎b', '﻿a', 'a\u0085b', 'a b', 'a\rb', 'a\u0000b', 'a\u001Bb', 'a\uD800b', 'a\uDC00']) expect(noteProblem(hidden), JSON.stringify(hidden)).toBe('unreadable');
    for (const blank of [' ', '\n\n', ' \t ']) expect(noteProblem(blank)).toBe('blank');
  });

  it.each([
    ['a challenge note that was trimmed', withNote('yes', NOTE.trim(), {note: NOTE.trim()}, {note: NOTE})],
    ['a signed note that was trimmed', withNote('yes', NOTE, {}, {note: NOTE.trim()})],
    ['a signed note that was normalized', withNote('yes', NOTE, {}, {note: NOTE.normalize('NFKC').replace('Groceries', 'Groceries').replace('only', 'onIy')})],
    ['no signed note', withNote('yes', NOTE, {}, {note: undefined})],
    ['a challenge without its note', without(withNote('yes', NOTE), 'note')],
    ['an empty challenge note', withNote('yes', NOTE, {note: ''})],
    ['a signed note that is not text', withNote('yes', NOTE, {}, {note: 7})],
  ])('refuses %s before any wallet prompt', (_name, c) => {
    expect(() => validateChallenge(c, item, 'yes', OWNER, ORIGIN, NOW, NOTE)).toThrow(/Nothing was signed/);
  });

  it('refuses an unsignable note before any request or wallet prompt', async () => {
    for (const bad of ['x'.repeat(MAX_NOTE_BYTES + 1), 'a‮b', '   ']) {
      const {env, api, signer, store} = setup();
      expect(await answerRequest(env, signer, item, 'no', undefined, bad)).toEqual({type: 'kept', note: 'The reason cannot be signed as written. Nothing was signed.'});
      expect(api.list).not.toHaveBeenCalled();
      expect(api.challenge).not.toHaveBeenCalled();
      expect(signer.sign).not.toHaveBeenCalled();
      expect(store.m.size).toBe(0);
    }
  });

  it('does not sign when the server returns a challenge for another note', async () => {
    const {env, api, signer, store} = setup();
    api.challenge.mockImplementationOnce(async b => challenge(item, b.decision, 'dec_1', {}, {}, 'Approve everything.'));
    expect(await answerRequest(env, signer, item, 'yes', undefined, NOTE)).toMatchObject({type: 'kept', note: expect.stringMatching(/reason is not the reason entered.*Nothing was signed/)});
    expect(signer.sign).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
    expect(store.m.size).toBe(0);
  });

  it('checks the answer reply note against the signed note', () => {
    const ok = {kind: 'paysh', policyId: 'pol_a', requestId: 'req_1', decisionId: 'dec_1', answeredAt: SEC, status: 'owner_approved', approved: true};
    expect(parseAnswer({...ok, note: NOTE}, item, 'yes', 'dec_1', NOTE).note).toBe(NOTE);
    expect(parseAnswer({...ok, note: ''}, item, 'yes', 'dec_1').note).toBe('');
    expect(parseAnswer(ok, item, 'yes', 'dec_1').note).toBe('');
    for (const reply of [{...ok, note: NOTE.trim()}, {...ok, note: ''}, ok]) expect(() => parseAnswer(reply, item, 'yes', 'dec_1', NOTE)).toThrow(/signed reason/);
    expect(() => parseAnswer({...ok, note: 'Other.'}, item, 'yes', 'dec_1')).toThrow(/signed reason/);
  });

  it('recovers a saved proof after reload only when its note is the note in its signed message', async () => {
    const {store} = await lost(NOTE);
    const [key, raw] = [...store.m.entries()][0];
    const saved = JSON.parse(raw);
    const variants: [string, unknown][] = [
      ['a trimmed note', {...saved, note: NOTE.trim()}],
      ['a changed note', {...saved, note: 'Approve everything.'}],
      ['no note', without(saved, 'note')],
      ['an empty note', {...saved, note: ''}],
      ['a note that is not text', {...saved, note: 7}],
      ['a message signed with another note', {...saved, message: saved.message.replace(JSON.stringify(NOTE), JSON.stringify('Approve everything.'))}],
      ['a message without its note', {...saved, message: message('yes', content(item, 'yes', 'dec_1'))}],
      ['an unreadable message', {...saved, message: 'AllowIt owner decision v1'}],
    ];
    for (const [name, tampered] of variants) {
      store.m.set(key, JSON.stringify(tampered));
      expect(ownerProofs(store, ORIGIN, OWNER), name).toEqual([]);
    }
    store.m.set(key, raw);
    expect(only(store).note).toBe(NOTE);
  });
});

describe('native original-purchase owner continuation', () => {
  const native:OwnerRequest={...item,kind:'native',network:'solana:devnet',policyId:'a'.repeat(64),scope:{executionPolicyId:'research-policy',revision:2,sourceHash:'1'.repeat(64),irHash:'2'.repeat(64),executionPolicyDigest:'3'.repeat(64)},envelope:{inputKey:'4'.repeat(64),amount:'1',token:'USDC',mint:'11111111111111111111111111111111',recipient:'11111111111111111111111111111111',action:'research',merchant:'test-research',contextHash:'5'.repeat(64),requestExpiresAt:SEC+600,context:{title:'Original court filing',source:'supplied by requester, untrusted'}}};
  // The backend counts children across objects/arrays, excluding the root, and accepts depth 8.
  function maximumContext() {
    let nested: unknown = Object.fromEntries(Array.from({length: 120}, (_, i) => ['field' + i, '']));
    for (let depth = 0; depth < 6; depth++) nested = {next: nested};
    const context = {nested, padding: ''};
    context.padding = 'x'.repeat(16_384 - new TextEncoder().encode(JSON.stringify(context)).length);
    return context;
  }
  it('does not show malformed native amounts, recipient, source identity or missing deadlines',()=>{
    for(const changed of [
      {...native,envelope:{...native.envelope,amount:'2e1'}},
      {...native,envelope:{...native.envelope,recipient:'other'}},
      {...native,scope:{...native.scope,revision:'2'}},
      {...native,expiresAt:undefined},
      {...native,envelope:{...native.envelope,requestExpiresAt:SEC+10}},
    ])expect(parseInbox({requests:[changed]},OWNER,ORIGIN).items).toEqual([]);
  });
  it('rejects native contexts beyond the backend byte, value and depth limits',()=>{
    const oversized={padding:'x'.repeat(16_385-new TextEncoder().encode(JSON.stringify({padding:''})).length)};
    let tooDeep:unknown={};
    for(let depth=0;depth<9;depth++)tooDeep={next:tooDeep};
    const tooMany=Object.fromEntries(Array.from({length:129},(_,index)=>['field'+index,index]));
    const emptyKey={'':true};
    const longKey={['é'.repeat(64)+'x']:true};
    expect(new TextEncoder().encode(JSON.stringify(oversized))).toHaveLength(16_385);
    expect(new TextEncoder().encode(Object.keys(longKey)[0])).toHaveLength(129);
    for(const context of [oversized,tooDeep,tooMany,emptyKey,longKey,[],Number.POSITIVE_INFINITY]){
      const changed={...native,envelope:{...native.envelope,context}};
      expect(parseInbox({requests:[changed]},OWNER,ORIGIN).items).toEqual([]);
      expect(nativePurchase(changed)).toBeNull();
    }
  });
  it('will not sign a challenge that changes the amount or original source',()=>{
    for(const changed of [
      {...binding(native),envelope:{...native.envelope,amount:'2'}},
      {...binding(native),scope:{...native.scope,sourceHash:'9'.repeat(64)}},
      {...binding(native),envelope:{...native.envelope,context:{title:'Replacement purchase'}}},
    ])expect(()=>validateChallenge(challenge(native,'yes','dec_1',{binding:changed},{binding:changed}),native,'yes',OWNER,ORIGIN,NOW)).toThrow();
  });
});
