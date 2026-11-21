import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * #2487: the names a household's portal invite prints.
 *
 * The invite templates greet `{{primaryDisplayName}}` and name the household as
 * `{{tribeName}}`. Two of the three primary-invite senders filled those with
 * what they had to hand instead: the invited address as the person's name
 * ("Hello catch@...,") and, in `mintInvite`, the household's record id as its
 * name ("Welcome to 9fQ2..."). An address is not a name and an id is not
 * anything a household can read.
 *
 * Resolved here, once, the way `inviteKinfolkToPortal` already did it: the
 * person's own name off the `kinfolk` record, else the household's name off
 * `families/{id}`, else a plain greeting word. Never the address, never an id.
 * `kinfolkName` (the editor's merge field for the household's person) is the
 * same value, so a template written with it fills too.
 *
 * Never throws: a failed read is logged and the fallbacks are used, because the
 * invite still has to go.
 */
export interface InviteNames {
  /** Who the email greets. */
  primaryDisplayName: string;
  /** The household, as the household calls itself. */
  tribeName: string;
  /** Same person as `primaryDisplayName`, under the editor's merge field name. */
  kinfolkName: string;
}

/** What a greeting reads when no name is on file: "Hello there,". */
export const INVITE_GREETING_FALLBACK = 'there';
/** What the household is called when it has no name on file. */
export const INVITE_TRIBE_FALLBACK = 'your household';

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A stored "name" that is really an address (an older invite named the household by it). */
function nameOrBlank(v: unknown): string {
  const t = text(v);
  return t.includes('@') ? '' : t;
}

/** The person's name off a `kinfolk` record, '' when it has none. PURE. */
export function kinfolkPersonName(record: Record<string, unknown> | undefined | null): string {
  if (!record) return '';
  const full = `${text(record.firstName)} ${text(record.lastName)}`.trim();
  return nameOrBlank(full) || nameOrBlank(record.displayName) || nameOrBlank(record.name);
}

/**
 * The invite's names for one household. `householdName` is the name the
 * caller already holds (provisionTribe has it in hand), used before a read.
 */
export async function inviteNamesFor(
  kinfolkId: string,
  opts: { householdName?: string; caller: string },
): Promise<InviteNames> {
  let person = '';
  let household = nameOrBlank(opts.householdName);
  try {
    if (kinfolkId) {
      const [kinfolkSnap, familySnap] = await Promise.all([
        db().collection('kinfolk').doc(kinfolkId).get(),
        household ? Promise.resolve(null) : db().collection('families').doc(kinfolkId).get(),
      ]);
      person = kinfolkPersonName(kinfolkSnap.exists ? (kinfolkSnap.data() as Record<string, unknown>) : null);
      if (!household && familySnap?.exists) {
        const fam = familySnap.data() as Record<string, unknown>;
        household = nameOrBlank(fam.displayName) || nameOrBlank(fam.name);
      }
    }
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: opts.caller,
      event: 'invite.names.read_failed',
      extra: { kinfolkId, err: (err as Error)?.message ?? String(err), action: 'sent with the plain greeting' },
    });
  }
  const greeting = person || household || INVITE_GREETING_FALLBACK;
  return {
    primaryDisplayName: greeting,
    tribeName: household || person || INVITE_TRIBE_FALLBACK,
    kinfolkName: greeting,
  };
}
