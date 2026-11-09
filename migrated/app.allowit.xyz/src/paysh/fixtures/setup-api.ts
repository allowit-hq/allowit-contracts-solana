import {parseArchived, parseConfig, parsePrepared, parseSetupState, type PayshConfig, type SetupState, type PreparedSetup} from '../paysh-contracts';
import {PayshError} from '../paysh-api';
/** Historical write transport used only by setup-helper unit fixtures; never imported by the app. */
const MAX_REPLY = 1 << 20;
/** One owner request with the wallet session cookie, never retried here. */
async function call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api/paysh/${route}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45_000)});
  } catch {
    throw new PayshError('The setup service could not be reached. Its reply is unknown.', 0);
  }
  const raw = await response.text().catch(() => '');
  let data: unknown = null;
  if (raw.length <= MAX_REPLY) try {data = JSON.parse(raw);} catch {/* Reported below. */}
  if (!response.ok) {
    const error = (data as {error?: unknown} | null)?.error;
    throw new PayshError(typeof error === 'string' && error ? error.slice(0, 400) : `The setup service returned HTTP ${response.status}.`, response.status);
  }
  if (data === null) throw new PayshError('The setup service returned an unreadable reply.', response.status);
  return data;
}

export const fixtureSetupApi = {
  config: async (): Promise<PayshConfig> => parseConfig(await call('GET', 'config')),
  /** Prepares only the backend's stored, owner-generated draft. A repeated request ID returns the original setup. */
  prepare: async (policyId: string, requestId: string): Promise<PreparedSetup> => parsePrepared(await call('POST', 'prepare', {policyId, requestId})),
  /** The backend verifies and broadcasts the signed bytes, then replies as confirm does. */
  submit: async (policyId: string, requestId: string, signedBytes: string): Promise<SetupState> => parseSetupState(await call('POST', 'submit', {policyId, requestId, signedBytes})),
  /** Reads chain state only; it never broadcasts. Finalization verifies the installed policy and saves it. */
  confirm: async (policyId: string, requestId: string): Promise<SetupState> => parseSetupState(await call('POST', 'confirm', {policyId, requestId})),
  /** Removes an unsigned draft or proven-absent signed setup from the owner's list. Retains signed evidence. */
  archive: async (policyId: string): Promise<void> => parseArchived(await call('POST', 'archive', {policyId}), policyId),
};
