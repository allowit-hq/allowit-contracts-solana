const REVIEW_TITLE = 'Allowit owner review';
const REVIEW_NOTE = 'This answer is for this request only. Every rule and limit of the policy still applies.';
const REVIEW_ANSWERS = { 'Allow this one request': 'allow', 'Deny this one request': 'deny' };
const REVIEW_SCORE = /^[0-9.]+ of 100 \(below [0-9.]+ denies; [0-9.]+ or more allows\)$/;
const REVIEW_NOT_SCORED = 'none. A lookup failed, so nothing was scored';
const REVIEW_LOOKUP = /^[\x21-\x7e]{1,128} failed \([\x21-\x7e]{1,128}\)$/;
/**
 * Reads the exact text of an owner review answer: the title, the answer, what is answered in `Key: value` lines, the
 * note, then the network, the review and the snapshot hash. Line 8 is the decision `Question` with a numeric `Score`
 * on line 9, or the failed `Lookup` with the score line that says that nothing was scored. Any other text is null.
 * Each value is one line without a control character; the snapshot is 64 lowercase hexadecimal characters.
 */
export function reviewAnswer(message) {
    if (typeof message !== 'string' || message.length > 8192)
        return null;
    const lines = message.split('\n');
    if (lines.length !== 15 || lines[0] !== REVIEW_TITLE || lines[1] !== '' || lines[9] !== '' || lines[10] !== REVIEW_NOTE || lines[11] !== '')
        return null;
    const value = (index, key) => {
        const prefix = `${key}: `, line = lines[index];
        // No control character and no line or paragraph separator: one value is one visible line.
        return line.startsWith(prefix) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line) ? line.slice(prefix.length) : null;
    };
    const keys = [[2, 'Answer'], [3, 'Operation'], [4, 'Amount'], [5, 'To'], [6, 'Policy'], [8, 'Score'], [12, 'Network'], [13, 'Review'], [14, 'Snapshot']];
    const values = keys.map(([index, key]) => value(index, key));
    if (values.some(v => v === null))
        return null;
    const [answerText, operation, amount, to, policy, score, network, review, snapshot] = values;
    if (!Object.hasOwn(REVIEW_ANSWERS, answerText))
        return null;
    if (!operation || !amount || !to)
        return null;
    // A question goes with a numeric score, and a failed lookup with the line that nothing was scored. Never mixed.
    const question = value(7, 'Question'), lookup = value(7, 'Lookup');
    const cause = question ? (REVIEW_SCORE.test(score) ? { question } : null) : lookup !== null && REVIEW_LOOKUP.test(lookup) && score === REVIEW_NOT_SCORED ? { lookup } : null;
    if (!cause)
        return null;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(review) || !/^[0-9a-f]{64}$/.test(snapshot))
        return null;
    return { answer: REVIEW_ANSWERS[answerText], operation, amount, to, policy, ...cause, score, network, review, snapshot };
}
