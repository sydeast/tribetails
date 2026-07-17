import { HttpsError } from 'firebase-functions/v2/https';

export function isAuntieOperator(uid: string | undefined): boolean {
  if (!uid) return false;
  const raw = process.env.AUNTIE_OPERATOR_UIDS ?? '';
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(uid);
}

export function requireAuntieOperator(uid: string | undefined): void {
  if (!isAuntieOperator(uid)) {
    throw new HttpsError('permission-denied', 'permission-denied: operator allowlist');
  }
}
