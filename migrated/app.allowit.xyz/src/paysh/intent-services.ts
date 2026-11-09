import {categoryLabel, PAYSH_SERVICES} from './paysh-catalog';

/**
 * Words that name a pay.sh category in the owner's request, in English and Russian. A match only preselects services in
 * the whitelist editor: the owner still reviews, edits and saves the list, and the compiled policy enforces it.
 * Phrases stay specific on purpose. A research prompt that mentions "datasets" or "transcripts" must not pull in a
 * whole category the owner never asked for.
 */
const CYR = (stems: string) => new RegExp(`(?<!\\p{L})(?:${stems})`, 'iu');
const CATEGORY_WORDS: readonly [string, readonly RegExp[]][] = [
  ['finance', [
    /\b(?:financ\w*|fintech|trad(?:e|es|ing|er|ers)|crypto\w*|defi|stocks?|stock market|equit(?:y|ies)|market data|price feeds?|invest\w*|portfolios?|forex|dex)\b/i,
    CYR('финанс|финтех|трейд|торгов(?:ля|ли|лю|ать|ый|ые)|крипт|дефай|бирж|акци[йия]|котировк|инвест|портфел|форекс'),
  ]],
  ['ai_ml', [
    /\b(?:ai\s*\/\s*ml|ai tasks?|machine learning|llms?|neural networks?|image generation)\b/i,
    CYR('нейросет|машинн\\p{L}* обучени|ии[- ]задач|задач\\p{L}* ии'),
  ]],
  ['data', [/\b(?:data tasks?|data providers?|web scraping|scrap(?:e|ing|er))\b/i, CYR('скрап|парсинг\\p{L}* сайт')]],
  ['maps', [/\b(?:maps?|geocod\w*|places api|address validation|air quality)\b/i, CYR('карт(?:а|ы|у|е|ам|ами|ах)(?!\\p{L})|геокод|адрес\\p{L}* провер')]],
  ['translation', [/\b(?:translat\w*|localiz\w*)\b/i, CYR('перевод|переве(?:сти|ди)|локализ')]],
  ['search', [/\b(?:web search|search engines?|search tasks?)\b/i, CYR('поиск\\p{L}* в (?:интернете|сети)|веб-поиск')]],
  ['messaging', [/\b(?:e-?mails?|sms|text messages?|messaging|inbox(?:es)?)\b/i, CYR('почт|письм|смс|рассылк')]],
  ['media', [/\b(?:images?|videos?|screenshots?|media tasks?)\b/i, CYR('картинк|изображени|видео|скриншот')]],
  ['security', [/\b(?:security|fraud|content moderation)\b/i, CYR('безопасност|мошеннич|модераци')]],
  ['shopping', [/\b(?:flights?|airfare|shopping)\b/i, CYR('авиабилет|перел[её]т|покупк\\p{L}* билет')]],
  ['productivity', [/\b(?:reservations?|bookings?|productivity)\b/i, CYR('бронир|продуктивност')]],
  ['compute', [/\b(?:rpc|nodes?|compute)\b/i, CYR('нод[аыу](?!\\p{L})|вычислен')]],
  ['devtools', [/\b(?:captchas?|dev ?tools|developer tools)\b/i, CYR('капч|инструмент\\p{L}* разработ')]],
];

const categoryOf = new Map(PAYSH_SERVICES.map(s => [s.fqn, s.category]));

/** The pay.sh categories a request names, in catalog-table order. */
export function intentCategories(intent: string): string[] {
  const text = intent.normalize('NFKC');
  return CATEGORY_WORDS.filter(([, words]) => words.some(w => w.test(text))).map(([category]) => category);
}

export interface IntentWhitelist {
  /** Categories the request names. */
  categories: string[];
  /** Services to preselect: every listed service in those categories, in catalog order, up to `max`. */
  ids: string[];
  /** Named categories with no service on the given list, for example because pay.sh does not take payment there. */
  unavailable: string[];
  /** Services in the named categories that did not fit under `max`. */
  omitted: number;
}

/**
 * The whitelist a request suggests. `services` is what this editor may add (paid on the policy's network, or registered
 * for the wallet), so a suggestion never holds a service the owner could not pick by hand.
 */
export function intentWhitelist(intent: string, services: readonly {id: string}[], max: number): IntentWhitelist {
  const categories = intentCategories(intent);
  const matching = services.filter(s => categories.includes(categoryOf.get(s.id) ?? ''));
  const unavailable = categories.filter(c => !matching.some(s => categoryOf.get(s.id) === c));
  const ids = [...new Set(matching.map(s => s.id))];
  return {categories, ids: ids.slice(0, Math.max(0, max)), unavailable, omitted: Math.max(0, ids.length - max)};
}

/** One sentence saying what was preselected and why, or why nothing could be. Empty when the request names no category. */
export function intentWhitelistNote(s: IntentWhitelist, networkLabel: string, max: number): string {
  if (!s.categories.length) return '';
  const names = (list: string[]) => list.map(categoryLabel).join(', ');
  const found = s.categories.filter(c => !s.unavailable.includes(c));
  const parts: string[] = [];
  if (found.length) parts.push(`Added ${s.ids.length} ${names(found)} service${s.ids.length === 1 ? '' : 's'} from your request. Review the list and save it.`);
  if (s.omitted) parts.push(`${s.omitted} more did not fit: the whitelist holds ${max}.`);
  if (s.unavailable.length) parts.push(`Your request names ${names(s.unavailable)}, but no service in ${s.unavailable.length === 1 ? 'that category' : 'those categories'} can be paid on ${networkLabel}.`);
  return parts.join(' ');
}
