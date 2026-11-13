import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { savedByStamp } from '../lib/savedByStamp';

/**
 * changeBusinessTags (owner). Adds tags to, and recolours tags on, the
 * business's two tag lists (`business_settings.householdTags` and `.petTags`),
 * one named tag at a time, against the list AS STORED.
 *
 * ── WHY THIS EXISTS (#2204, #2205) ────────────────────────────────────────
 * The lists used to travel whole: every client read the list, edited its copy
 * and sent the copy back through `saveBusinessSettings`, which replaces arrays.
 * A panel left open while tags changed elsewhere put its old list back, so a
 * tag added in the meantime was lost and a deleted one came back. On admin
 * Android, "add to your tags" before the list had loaded sent a list of one
 * over the whole list. A version check would only have refused the second of
 * two adds; adding one name to what is stored keeps both.
 *
 * So no client sends a list any more. Each change names one tag:
 *   - `add`   puts a new name on the list. A name already there (in any
 *             casing, the way `resolveTag` matches) is refused in plain words.
 *   - `style` sets the colour and emoji of a name already there. A name that
 *             is no longer there is refused, never re-created, so a stale
 *             Settings screen cannot bring a deleted tag back.
 * Deleting stays `removeBusinessTag`, which also strips the name off every
 * household or Kin. There is no rename: the name is the key assignments use.
 *
 * ALL OR NOTHING, IN ONE TRANSACTION. The Settings editor's Save sends every
 * add and recolour it holds, across both lists. They are applied in order to
 * the stored lists inside one transaction, so two devices adding at once both
 * land (the loser of the race re-reads and retries), and one refusal writes
 * nothing at all.
 *
 * `saveBusinessSettings` refuses a changed `householdTags` / `petTags`
 * (`checkTagsUnchanged` in `lib/businessSettingsChecks.ts`), so an installed
 * old build that still sends a whole list cannot undo anything either.
 *
 * Owner-only: not in `AUNTIE_ALLOWED_CALLABLES`, the same as
 * `saveBusinessSettings`. Business Settings are the owner's.
 *
 * Answers with both lists as stored after the write, so the screen that sent
 * the change repaints from what the server holds, tags added elsewhere
 * included.
 */

export const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** The stored field for each scope. The same pair `removeBusinessTag` uses. */
const VOCAB_FIELD = { household: 'householdTags', pet: 'petTags' } as const;

/** 40 and 200 match `MAX_TAG_NAME_LENGTH` / `MAX_TAGS` in `lib/businessSettingsChecks.ts` and the clients. */
export const MAX_TAG_NAME_LENGTH = 40;
export const MAX_TAGS = 200;
/** The clients cap a typed emoji at 8 UTF-16 units; a little room for a modifier sequence. */
const MAX_ICON_LENGTH = 16;
/** One Save can carry an add or a recolour for every row of both lists. */
const MAX_CHANGES = MAX_TAGS * 2;

/** Refusal codes a client can read off `details.code`. */
export const TAG_EXISTS_CODE = 'tag_exists';
export const TAG_MISSING_CODE = 'tag_missing';
export const TOO_MANY_TAGS_CODE = 'too_many_tags';

const Color = z
  .object({
    token: z.string().trim().min(1).max(32),
    css: z.string().trim().min(1).max(64),
  })
  .strict();

const Name = z.string().trim().min(1, 'A tag name is required.').max(MAX_TAG_NAME_LENGTH, `A tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer.`);

const Change = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add'),
      scope: z.enum(['household', 'pet']),
      name: Name,
      color: Color,
      icon: z.string().max(MAX_ICON_LENGTH),
    })
    .strict(),
  z
    .object({
      action: z.literal('style'),
      scope: z.enum(['household', 'pet']),
      name: Name,
      color: Color,
      icon: z.string().max(MAX_ICON_LENGTH),
    })
    .strict(),
]);

// Exported so `test/callableContract.test.ts` can freeze the request shape:
// three clients (admin web, admin Android, desktop console) build it by hand.
export const Args = z
  .object({
    changes: z.array(Change).min(1, 'Nothing to save.').max(MAX_CHANGES),
  })
  .strict();

export type TagChange = z.infer<typeof Change>;

export interface ChangeBusinessTagsResult {
  ok: true;
  /** `business_settings.householdTags` as stored after the write. */
  householdTags: unknown[];
  /** `business_settings.petTags` as stored after the write. */
  petTags: unknown[];
  updatedAt: string;
  updatedBy: string;
}

/** Trim and collapse whitespace runs, mirroring `normalizeTagName` on every client. */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The comparison key: normalized, then lowercased, the way `resolveTag` matches. */
function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/** The name on a stored row, or null for a row with none (kept as it is, never matched). */
function rowName(row: unknown): string | null {
  if (row === null || typeof row !== 'object') return null;
  const name = (row as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : null;
}

function refuse(code: string, message: string, change: TagChange): never {
  throw new HttpsError('failed-precondition', message, {
    code,
    scope: change.scope,
    name: normalizeTagName(change.name),
  });
}

/**
 * Apply [changes] in order to the stored lists. Pure, so the rules are tested
 * without a database. Throws the refusal for the first change that cannot
 * apply; the caller then writes nothing.
 */
export function applyTagChanges(
  stored: { household: unknown[]; pet: unknown[] },
  changes: TagChange[],
): { household: unknown[]; pet: unknown[]; touched: Set<'household' | 'pet'> } {
  const lists = { household: [...stored.household], pet: [...stored.pet] };
  const touched = new Set<'household' | 'pet'>();
  for (const change of changes) {
    const list = lists[change.scope];
    const name = normalizeTagName(change.name);
    const key = tagKey(name);
    const at = list.findIndex((row) => {
      const n = rowName(row);
      return n !== null && tagKey(n) === key;
    });
    const color = { token: change.color.token.trim(), css: change.color.css.trim() };
    if (change.action === 'add') {
      if (at >= 0) {
        refuse(TAG_EXISTS_CODE, `A "${normalizeTagName(rowName(list[at]) ?? name)}" tag already exists.`, change);
      }
      if (list.length >= MAX_TAGS) {
        refuse(TOO_MANY_TAGS_CODE, `That is more than ${MAX_TAGS} tags.`, change);
      }
      list.push({ name, color, icon: change.icon });
    } else {
      if (at < 0) {
        refuse(
          TAG_MISSING_CODE,
          `The tag list changed since this screen opened: "${name}" is no longer on it. Reload and try again.`,
          change,
        );
      }
      // The stored row keeps its own name and any field this server does not
      // know about; only the colour and emoji change.
      list[at] = { ...(list[at] as Record<string, unknown>), color, icon: change.icon };
    }
    touched.add(change.scope);
  }
  return { ...lists, touched };
}

function storedList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export async function changeBusinessTagsHandler(
  req: CallableRequest<unknown>,
): Promise<ChangeBusinessTagsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      throw new HttpsError(
        'invalid-argument',
        first && first.message.startsWith('A tag name') ? first.message : 'The tag change did not arrive in a form the server can read. Reload and try again.',
        { validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      );
    }
    throw err;
  }

  const ref = db().doc(BUSINESS_SETTINGS_DOC);
  const stamp = savedByStamp(uid);
  const after = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = ((snap.exists ? snap.data() : undefined) ?? {}) as Record<string, unknown>;
    const next = applyTagChanges(
      { household: storedList(data[VOCAB_FIELD.household]), pet: storedList(data[VOCAB_FIELD.pet]) },
      args.changes,
    );
    const body: Record<string, unknown> = { ...stamp };
    for (const scope of next.touched) body[VOCAB_FIELD[scope]] = next[scope];
    tx.set(ref, body, { merge: true });
    return next;
  });

  const summary = args.changes.map((c) => ({ action: c.action, scope: c.scope, name: normalizeTagName(c.name) }));
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BUSINESS_TAGS_CHANGED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'business_settings',
    description: summary
      .map(
        (s) =>
          // A style change may be the emoji alone, so it is not called a recolour.
          `${s.action === 'add' ? 'Added the tag' : 'Changed the colour or emoji of the tag'} "${s.name}" ${s.action === 'add' ? 'to' : 'on'} the ${s.scope === 'household' ? 'household' : 'Kin'} tag list`,
      )
      .join('. '),
    payload: { changes: summary },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'changeBusinessTags',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'changeBusinessTags',
    event: 'admin.tags.changed',
    uid,
    extra: { changes: summary.length, scopes: [...after.touched] },
  });

  return {
    ok: true,
    householdTags: after.household,
    petTags: after.pet,
    updatedAt: stamp.updatedAt,
    updatedBy: stamp.updatedBy,
  };
}

export const changeBusinessTags = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('changeBusinessTags', changeBusinessTagsHandler),
);
