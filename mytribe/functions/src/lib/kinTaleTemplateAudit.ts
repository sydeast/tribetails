import { AUDIT_EVENTS, type AuditEvent } from './auditEvents';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';

/**
 * #1892: THE ACTIVITY LOG LINE FOR A KINTALE TEMPLATE CHANGE.
 *
 * Creating, saving, archiving, restoring and deleting a KinTale template left
 * no line. The three admin clients write `kintale_templates` directly (there is
 * no template callable; `firestore.rules` gates the writes), so the line is
 * written from the committed write by `triggers/onKinTaleTemplateWrite.ts`,
 * whichever client made it. Same shape as the clock steps (#2037).
 *
 * WHICH WRITES ARE A LINE. Read from before and after:
 *   - no before: created. No after: deleted (the rules allow that only for an
 *     archived template, so it is the Archive's "Delete for good").
 *   - `archived` false to true: archived. True to false: restored.
 *   - any other changed field: saved. `updatedAt`, `createdAt`, `archivedAt`
 *     and the stray `id` do not count, so a write that only moves a stamp is
 *     no line.
 *   - A write whose only change is `isDefault` turning off is no line. That is
 *     the default flag leaving a sibling when another template takes it (web:
 *     one batch; Android and the desktop console: one write per sibling), and
 *     the template that took the default gets its own "saved" line. The cost:
 *     an editor save that changes nothing but turning the default off on that
 *     same template is not logged either.
 */
export type KinTaleTemplateChange = 'created' | 'saved' | 'archived' | 'restored' | 'deleted';

type TemplateData = Record<string, unknown>;

const NOT_A_CHANGE = new Set(['updatedAt', 'createdAt', 'archivedAt', 'id']);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return v;
}

/** The change this write made, or null when it is not a line. Pure. */
export function kinTaleTemplateChangeOf(
  before: TemplateData | undefined,
  after: TemplateData | undefined,
): KinTaleTemplateChange | null {
  if (before === undefined && after === undefined) return null;
  if (before === undefined) return 'created';
  if (after === undefined) return 'deleted';
  const wasArchived = before['archived'] === true;
  const isArchived = after['archived'] === true;
  if (!wasArchived && isArchived) return 'archived';
  if (wasArchived && !isArchived) return 'restored';
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter((k) => !NOT_A_CHANGE.has(k) && !same(before[k], after[k]));
  if (changed.length === 0) return null;
  if (changed.length === 1 && changed[0] === 'isDefault' && after['isDefault'] !== true) return null;
  return 'saved';
}

const EVENT: Record<KinTaleTemplateChange, AuditEvent> = {
  created: AUDIT_EVENTS.KINTALE_TEMPLATE_CREATED,
  saved: AUDIT_EVENTS.KINTALE_TEMPLATE_SAVED,
  archived: AUDIT_EVENTS.KINTALE_TEMPLATE_ARCHIVED,
  restored: AUDIT_EVENTS.KINTALE_TEMPLATE_RESTORED,
  deleted: AUDIT_EVENTS.KINTALE_TEMPLATE_DELETED,
};

const VERB: Record<KinTaleTemplateChange, string> = {
  created: 'Created',
  saved: 'Saved',
  archived: 'Archived',
  restored: 'Restored',
  deleted: 'Deleted',
};

/** Longest template name a line quotes. A longer one is cut and ends with "...". */
export const TEMPLATE_NAME_MAX = 80;

/**
 * The sentence: `Created the KinTale template "Dog walk"`, or
 * `Created a KinTale template` when the template has no name. The name is the
 * business's own label for the template, never a household's text.
 */
export function kinTaleTemplateWords(change: KinTaleTemplateChange, name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (n === '') return `${VERB[change]} a KinTale template`;
  const shown = n.length > TEMPLATE_NAME_MAX ? `${n.slice(0, TEMPLATE_NAME_MAX - 3).trimEnd()}...` : n;
  return `${VERB[change]} the KinTale template "${shown}"`;
}

/** At most one line per trigger event, so a retried delivery writes nothing new. */
export function kinTaleTemplateAuditId(eventId: string): string {
  return `kintale_template_${eventId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const NOT_A_USER = new Set(['auth/user-not-found', 'auth/invalid-uid', 'auth/argument-error']);

/**
 * Who the line names: the owner or an Auntie, read from the writer's claims
 * the way `logActivity` reads them from a token (#1820). Same rules as the
 * clock-step lines (`lib/visitStepNotice.ts`): an id Auth has no user for is
 * the system's; claims that cannot be read for a passing reason still name
 * the writer, in the business band with no stamp.
 */
async function templateActor(
  actorUid: string | null,
): Promise<{ uid: string | null; actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY'; stamp: Record<string, unknown> }> {
  if (!actorUid) return { uid: null, actorRole: 'SYSTEM', stamp: {} };
  try {
    const [{ auth }, { resolveAuditActor, auditActorPayload }] = await Promise.all([
      import('./firestoreAdmin.js'),
      import('./auditActor.js'),
    ]);
    const user = await auth().getUser(actorUid);
    const actor = await resolveAuditActor(
      { uid: actorUid, token: (user.customClaims ?? {}) as never },
      'onKinTaleTemplateWrite',
    );
    return { uid: actorUid, actorRole: actor.actorRole, stamp: auditActorPayload(actor) };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NOT_A_USER.has(code)) return { uid: null, actorRole: 'SYSTEM', stamp: {} };
    return { uid: actorUid, actorRole: 'AUNTIE', stamp: {} };
  }
}

function nameOf(data: TemplateData | undefined): string {
  const raw = data?.['name'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Write the line for one committed template write. Returns the change it
 * recorded, or null for a write that is not a line. A failed line write is
 * logged at `error` and rethrown so the trigger's retry policy and Sentry see it.
 */
export async function recordKinTaleTemplateChange(input: {
  templateId: string;
  before: TemplateData | undefined;
  after: TemplateData | undefined;
  actorUid: string | null;
  eventId: string;
}): Promise<KinTaleTemplateChange | null> {
  const change = kinTaleTemplateChangeOf(input.before, input.after);
  if (change === null) return null;
  const actor = await templateActor(input.actorUid);
  const name = nameOf(input.after ?? input.before);
  try {
    await writeAuditEntry({
      event: EVENT[change],
      severity: change === 'deleted' ? 'warn' : 'info',
      status: 'SUCCESS',
      actorRole: actor.actorRole,
      ...(actor.uid ? { actorUid: actor.uid } : {}),
      targetUid: input.templateId,
      targetCollection: 'kintale_templates',
      description: kinTaleTemplateWords(change, name),
      payload: { templateId: input.templateId, change, ...actor.stamp },
      // No event id (never seen from Eventarc) means no at-most-once key, not a shared one.
      ...(input.eventId.trim() !== '' ? { docId: kinTaleTemplateAuditId(input.eventId) } : {}),
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'onKinTaleTemplateWrite',
      event: 'audit.write.failed',
      extra: { templateId: input.templateId, change },
      errorMessage: (err as Error)?.message,
    });
    throw err;
  }
  return change;
}
