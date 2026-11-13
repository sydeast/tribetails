import { z } from 'zod';

/**
 * The facts a client may attach to an Activity Log line through `logActivity`
 * (#1820). Until this existed the callable took no payload at all, so every
 * client-origin line opened to "This entry was written with no payload".
 *
 * AN ALLOW-LIST, ONE KEY PER LINE. The payload is sealed into the hash chain as
 * evidence, so a client may only say what is listed here, in the shape listed
 * here. A key that is not on the list is refused, not dropped: a dropped fact
 * would leave a line that looks complete and is not.
 *
 * WHAT NEVER GOES IN: a secret, a token, a password, a PIN, card or bank
 * details, an amount of money, an address, a phone number, an email, the text
 * of a note or a message. Names of a Kin, a Kinfolk or a template are allowed
 * because the log's sentences already carry them. Money lines are written by
 * the server callables that move the money, never through this.
 *
 * `admin` and `staffRole` are stamped by the server (`lib/auditActor.ts`) and
 * are deliberately absent, so a client cannot say who it is.
 *
 * To add a key: one line below, with the tightest type that fits.
 */

const id = z.string().max(200);
const word = z.string().max(80);
const name = z.string().max(200);
const sentence = z.string().max(500);
const words = z.array(word).max(50);
const ids = z.array(id).max(50);

export const ACTIVITY_PAYLOAD_FIELDS = {
  // ── What the line is about ───────────────────────────────────────────────
  visitId: id,
  sessionId: id,
  bookingId: id,
  batchId: id,
  kinfolkId: id,
  kinId: id,
  kinIds: ids,
  reportId: id,
  draftId: id,
  templateId: id,
  // ── A change of state ────────────────────────────────────────────────────
  action: word,
  from: word,
  to: word,
  at: z.string().max(40),
  reason: sentence,
  // ── Names the sentence prints ────────────────────────────────────────────
  kinName: name,
  kinfolkName: name,
  secondaryKinfolkName: name,
  templateName: name,
  title: name,
  // ── What changed, by field name, never by value ──────────────────────────
  section: word,
  category: word,
  changedFields: words,
  tags: words,
  addedTags: words,
  removedTags: words,
  // ── Counts and switches ──────────────────────────────────────────────────
  count: z.number().finite().int().min(0).max(1_000_000),
  archived: z.boolean(),
  delivered: z.boolean(),
  channel: word,
  /** Which client wrote the line: web, android or desktop. */
  source: z.enum(['web', 'android', 'desktop']),
} as const;

export type ActivityPayloadKey = keyof typeof ACTIVITY_PAYLOAD_FIELDS;

/** The whole payload, serialized, may not pass this many characters. */
export const ACTIVITY_PAYLOAD_MAX_CHARS = 4000;

/**
 * Strict: an unlisted key fails the parse with the key named in the message.
 * Every key is optional; a null or blank value is dropped before it is stored.
 */
export const ActivityPayload = z
  .object(
    Object.fromEntries(
      Object.entries(ACTIVITY_PAYLOAD_FIELDS).map(([key, schema]) => [key, schema.nullish()]),
    ) as { [K in ActivityPayloadKey]: z.ZodOptional<z.ZodNullable<(typeof ACTIVITY_PAYLOAD_FIELDS)[K]>> },
  )
  .strict()
  .refine((payload) => JSON.stringify(payload).length <= ACTIVITY_PAYLOAD_MAX_CHARS, {
    message: `payload is larger than ${ACTIVITY_PAYLOAD_MAX_CHARS} characters`,
  });

/** The parsed payload without its empty values, ready to store. */
export function compactActivityPayload(
  payload: z.infer<typeof ActivityPayload> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
