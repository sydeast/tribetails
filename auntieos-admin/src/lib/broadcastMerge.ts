/**
 * Broadcast merge fields, client side (#1610). Mirrors
 * `mytribe/functions/src/lib/broadcastMerge.ts`, which fills them per
 * household on the server for every channel. This copy exists so the composer
 * can refuse a field the server would refuse before the operator presses Send,
 * and so the preview shows a filled example.
 *
 * Operator ruling, 2026-11-05: a household with no first name reads "Kinfolk",
 * so `Hi {{firstName}},` arrives as "Hi Kinfolk,".
 */

export const BROADCAST_MERGE_FIELDS = ['firstName', 'lastName', 'kinfolkName', 'business', 'Business'] as const;

export const KINFOLK_NAME_STAND_IN = 'Kinfolk';

const SUPPORTED: ReadonlySet<string> = new Set(BROADCAST_MERGE_FIELDS);
const SIMPLE_TOKEN = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

/** Every field (or stray brace run) a broadcast cannot fill, first-seen order, no repeats. Pure. */
export function unsupportedMergeFields(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: string): void => {
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(SIMPLE_TOKEN)) {
      const name = m[1] as string;
      if (!SUPPORTED.has(name)) add(name);
    }
    const rest = text.replace(SIMPLE_TOKEN, '');
    for (const m of rest.matchAll(/\{\{[^}]*\}*\}?|\}\}/g)) add(m[0].trim());
  }
  return out;
}

/** The composer's refusal for unfillable fields, or null. Pure. */
export function mergeFieldBlocker(subject: string, body: string): string | null {
  const bad = unsupportedMergeFields(subject, body);
  if (bad.length === 0) return null;
  return `A broadcast can fill {{firstName}}, {{lastName}}, {{kinfolkName}} and {{business}} only. Remove or fix: ${bad.join(', ')}.`;
}

/** What the preview fills the fields with: a sample household. */
export const BROADCAST_PREVIEW_SAMPLE: Readonly<Record<string, string>> = {
  firstName: 'Sandy',
  lastName: 'Wren',
  kinfolkName: 'Sandy Wren',
  business: 'Tribe Tails',
  Business: 'Tribe Tails',
};
