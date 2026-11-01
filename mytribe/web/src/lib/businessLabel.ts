/**
 * How household prose names the business (#1381).
 *
 * The name comes from business settings (`getMyHome.businessName`, the same
 * source as the page footnotes, #1369). When the operator has not set one, prose
 * says "your Auntie". No business name is ever invented here.
 *
 * Footnotes ("Cared for by ...") do NOT use this: an unset name omits them, see
 * `BusinessFootnote`. This is for sentences, which need a subject or an object.
 */
export const BUSINESS_FALLBACK = 'your Auntie';
export interface BusinessLabelOptions {
  /** The label opens a sentence: "Your Auntie could not take that time." */
  capital?: boolean;
  /** "your Auntie's" / "Sunny Paws's". */
  possessive?: boolean;
}
export function businessLabel(name: string | null | undefined, opts: BusinessLabelOptions = {}): string {
  const trimmed = (name ?? '').trim();
  let label = trimmed === '' ? BUSINESS_FALLBACK : trimmed;
  if (opts.possessive === true) label = `${label}’s`;
  if (opts.capital === true) label = label.charAt(0).toUpperCase() + label.slice(1);
  return label;
}
