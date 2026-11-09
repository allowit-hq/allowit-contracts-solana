import type {Session} from '../contracts';

type ComposerSession = Pick<Session, 'address' | 'network'> | null;

/** A choice of words for a new draft, never an authorization or an edit to an existing policy. */
export function devnetResearchExample(network: string, session: ComposerSession) {
  if (network !== 'solana:devnet' || !session || !['solana', 'solana:devnet'].includes(session.network)
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(session.address)) return null;
  return {
    title: 'Devnet research transfers',
    prompt: `Create an explicit Solana Devnet demonstration policy using test USDC only, never real money or Mainnet. Allocate 9 test USDC total. The lifetime spending limit is 9 USDC, the limit per UTC day is 10 USDC, and each transfer must be at most 1 USDC. Additional deposits or a new day must not reset the lifetime spending limit. Allow at most 2 transfers above 0.50 up to 1 USDC, at most 4 transfers above 0.25 up to 0.50 USDC, and continue halving each price ceiling and doubling its transfer count for cheaper bands, without a minimum transfer amount. Only wallet ${session.address} may receive transfers; deny every other recipient.

Only allow the research action. I expressly authorize demonstration transfers associated with researching freely accessible primary sources: original papers, original datasets, filings, transcripts, interviews, court documents or regulatory documents. A source may be free and already retrieved; these test transfers do not require a paywall, vendor invoice, paid API or proof of paid delivery. They demonstrate bounded autonomous transfers, not a purchase from the source publisher or evidence that a paid service delivered anything.

Keep semantic checks of research relevance and primary evidence. Automatically allow a clear match within every hard limit; deny a clear mismatch. Do not allow newsletters, summaries, digests or reports that repackage sources. Ask me only when research relevance or the primary-source nature of the material is genuinely unclear. Keep the default preference thresholds: deny at or below 0.40, ask above 0.40 and below 0.85, and pass at or above 0.85. A score cannot override any hard limit or recipient restriction. After I sign this new policy's setup once, in-policy transfers must not require another owner transaction signature. Stop spending after revocation.`,
  };
}

/** Unsaved words and wallet choices must not survive a change of owner or destination network. */
export function composerScope(network: string, session: ComposerSession, seed?: string) {
  return JSON.stringify([network, session?.network ?? '', session?.address ?? '', seed ?? '']);
}
