/**
 * Secondary kinfolk with no portal access (operator rulings 2026-09-27, R1 and
 * Q3): "A Secondary kinfolk can be added to the household but doesn't have
 * portal access unless PK invites them and set access."
 *
 * A person record on the household (`families/{id}/secondaryKinfolk`), read and
 * written only through these three callables. Adding one sends no invite and
 * grants nothing. Portal access comes only from the primary's own invite on
 * MyTribe; the admin has no invite for a secondary (`addSecondaryContact`
 * refuses staff).
 *
 * Nothing here catches: a refusal carries the server's own sentence to the
 * screen.
 */
import { call } from '../lib/fns';

export type SecondaryKinfolkAccess = 'NONE' | 'INVITED' | 'ACTIVE';

export interface SecondaryKinfolk {
  personId: string;
  name: string;
  phone: string | null;
  email: string | null;
  access: SecondaryKinfolkAccess;
  memberUid: string | null;
}

export interface SecondaryKinfolkDraft {
  name: string;
  phone: string;
  email: string;
}

/** What each access state reads as on a row. ACTIVE rows are member rows instead. */
export const SECONDARY_KINFOLK_ACCESS_LABEL: Record<SecondaryKinfolkAccess, string> = {
  NONE: 'No portal access',
  INVITED: 'Invited',
  ACTIVE: 'Portal access',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function asAccess(v: unknown): SecondaryKinfolkAccess {
  return v === 'INVITED' || v === 'ACTIVE' ? v : 'NONE';
}

/** Decodes the answer. A missing `people` array is an error, never "nobody". */
export function decodeSecondaryKinfolk(res: unknown): SecondaryKinfolk[] {
  const rows = (res as { people?: unknown } | null)?.people;
  if (!Array.isArray(rows)) throw new Error('listSecondaryKinfolk: the server returned no people array.');
  return rows
    .map((r) => (r ?? {}) as Record<string, unknown>)
    .filter((r) => typeof r['personId'] === 'string' && r['personId'] !== '')
    .map((r) => ({
      personId: r['personId'] as string,
      name: str(r['name']) ?? '(no name)',
      phone: str(r['phone']),
      email: str(r['email']),
      access: asAccess(r['access']),
      memberUid: str(r['memberUid']),
    }));
}

export async function listSecondaryKinfolk(kinfolkId: string): Promise<SecondaryKinfolk[]> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('listSecondaryKinfolk requires a household id');
  return decodeSecondaryKinfolk(await call<{ kinfolkId: string }, unknown>('listSecondaryKinfolk', { kinfolkId: id }));
}

/**
 * Adds (no `personId`) or edits one. Every field is sent, a cleared one as
 * null, so clearing a phone sticks.
 */
export async function saveSecondaryKinfolk(
  kinfolkId: string,
  draft: SecondaryKinfolkDraft,
  personId?: string,
): Promise<void> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('saveSecondaryKinfolk requires a household id');
  const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());
  await call<
    { kinfolkId: string; personId?: string; name: string; phone: string | null; email: string | null },
    unknown
  >('saveSecondaryKinfolk', {
    kinfolkId: id,
    ...(personId !== undefined ? { personId } : {}),
    name: draft.name.trim(),
    phone: blankToNull(draft.phone),
    email: blankToNull(draft.email),
  });
}

export async function removeSecondaryKinfolk(kinfolkId: string, personId: string): Promise<void> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('removeSecondaryKinfolk requires a household id');
  await call<{ kinfolkId: string; personId: string }, { ok: true }>('removeSecondaryKinfolk', { kinfolkId: id, personId });
}
