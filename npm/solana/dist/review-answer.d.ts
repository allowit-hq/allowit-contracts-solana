/** The owner's answer to a held request: the exact text that the server writes and the owner's wallet signs. The text has the same form on every rail. */
/**
 * The fields of an owner review answer message. The request waits for one of two reasons: a decision `question`
 * with its `score`, or a `lookup` that failed, with the score line that says that nothing was scored.
 */
export interface ReviewAnswer {
    answer: 'allow' | 'deny';
    operation: string;
    amount: string;
    to: string;
    policy: string;
    question?: string;
    lookup?: string;
    score: string;
    network: string;
    review: string;
    snapshot: string;
}
/**
 * Reads the exact text of an owner review answer: the title, the answer, what is answered in `Key: value` lines, the
 * note, then the network, the review and the snapshot hash. Line 8 is the decision `Question` with a numeric `Score`
 * on line 9, or the failed `Lookup` with the score line that says that nothing was scored. Any other text is null.
 * Each value is one line without a control character; the snapshot is 64 lowercase hexadecimal characters.
 */
export declare function reviewAnswer(message: unknown): ReviewAnswer | null;
