import { auth as authAdmin, db } from './firestoreAdmin';
import type { MemberDoc, MemberRole, MemberStatus } from './schema';

/**
 * Who may receive a PRIMARY recovery claim link for a household.
 *
 * WHY THIS FILE EXISTS. `executePrimaryRecovery` used to mail its claim link to
 * whatever address the operator typed, validated only as `z.string().email()`.
 * That mail does not describe an account, it GRANTS one: the link redeems into
 * a PRIMARY member doc holding `FULL_PERMISSIONS`, billing included, and the
 * same call suspends the sitting PRIMARY. A typo, or a compromised admin
 * session, handed the household to whoever owned the typed address. The audit
 * entry recorded that it happened; nothing stopped it happening.
 *
 * The rule, decided on issue #378: the address must already belong to a
 * VERIFIED Firebase Auth account that is already a member of that household.
 * Recovery can now only ever move control between people the household already
 * has, and only to an address somebody has proved they can read.
 *
 * Both the gate in `executePrimaryRecovery` and the choice list the admin UI
 * renders come from this one function on purpose. If the list of addresses the
 * operator can pick from were computed separately from the list the server will
 * accept, the two would drift and the screen would start offering choices that
 * fail on submit.
 */
export interface RecoveryCandidate {
  uid: string;
  /** Always the Auth account's address, lowercased. Never the member doc's. */
  email: string;
  /** Member doc label, for a human-readable choice. Null when unlabelled. */
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
}

export interface RecoveryCandidateOptions {
  /**
   * The uid being recovered AWAY from, when the caller knows it. Excluded from
   * the result: mailing the claim link to the address that has just lost
   * control of the household is the one destination recovery cannot mean.
   */
  excludeUid?: string;
}

function asRole(v: unknown): MemberRole {
  return v === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY';
}

function asStatus(v: unknown): MemberStatus {
  return v === 'ACTIVE' || v === 'SUSPENDED' ? v : 'INVITED';
}

/**
 * Normalises an address for comparison. Lowercase and trimmed only: no plus-tag
 * stripping and no dot-folding, because "same inbox in practice" is a
 * provider-specific rule and guessing it wrong here would widen the gate.
 */
export function normalizeRecoveryEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Every member of `familyId` whose Auth account carries a verified email.
 *
 * A SUSPENDED member is left out: their access was deliberately taken away, and
 * handing them the household back through the recovery door would undo that
 * decision without anybody choosing it. An INVITED member is left in as long as
 * their Auth account exists and is verified — that is exactly the person who
 * accepted an invite and verified their address but has not been promoted yet.
 *
 * A member whose Auth account is missing (deleted, or never created) is skipped
 * rather than failing the whole read: one stale member doc must not make
 * recovery impossible for the rest of the household.
 */
export async function listRecoveryCandidates(
  familyId: string,
  options: RecoveryCandidateOptions = {},
): Promise<RecoveryCandidate[]> {
  const snap = await db().collection(`families/${familyId}/members`).get();
  const rows = snap.docs
    .map((d) => {
      const data = (d.data() ?? {}) as Partial<MemberDoc> & Record<string, unknown>;
      return {
        uid: typeof data.uid === 'string' && data.uid !== '' ? data.uid : d.id,
        secondaryLabel: typeof data.secondaryLabel === 'string' ? data.secondaryLabel : null,
        role: asRole(data.role),
        status: asStatus(data.status),
      };
    })
    .filter((row) => row.uid !== '' && row.status !== 'SUSPENDED')
    .filter((row) => options.excludeUid === undefined || row.uid !== options.excludeUid);

  const resolved = await Promise.all(
    rows.map(async (row) => {
      const user = await authAdmin()
        .getUser(row.uid)
        .catch(() => null);
      if (user === null) return null;
      if (user.emailVerified !== true) return null;
      if (typeof user.email !== 'string' || user.email === '') return null;
      return { ...row, email: normalizeRecoveryEmail(user.email) };
    }),
  );

  return resolved.filter((row): row is RecoveryCandidate => row !== null);
}

/**
 * The candidate owning `email`, or null.
 *
 * Callers treat null as "refuse", never as "fall back to the typed address":
 * the whole point of #378 is that there is no path from an unrecognised address
 * to a sent claim link.
 */
export function matchRecoveryCandidate(
  candidates: readonly RecoveryCandidate[],
  email: string,
): RecoveryCandidate | null {
  const wanted = normalizeRecoveryEmail(email);
  return candidates.find((c) => c.email === wanted) ?? null;
}

/**
 * The refusal an operator reads when the address they picked is not eligible.
 *
 * It names the two ways out — pick one of the addresses listed, or get the
 * person a verified account on this household first — because "not eligible"
 * on its own leaves the operator with a locked-out family and no next move.
 */
export function recoveryRejectionMessage(
  email: string,
  candidates: readonly RecoveryCandidate[],
): string {
  const typed = normalizeRecoveryEmail(email);
  if (candidates.length === 0) {
    return (
      `Recovery cannot send a claim link to ${typed}. This household has no member with a ` +
      `verified email address, so there is nobody it can safely hand control to. Invite the ` +
      `person to the household and have them verify their email first, then run recovery again.`
    );
  }
  return (
    `Recovery cannot send a claim link to ${typed}. It must go to a household member with a ` +
    `verified email address, and this one is neither on the household nor verified. Eligible ` +
    `addresses: ${candidates.map((c) => c.email).join(', ')}. If the right person is missing, ` +
    `invite them to the household and have them verify their email first.`
  );
}
