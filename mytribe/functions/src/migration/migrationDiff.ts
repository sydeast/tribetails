import { FULL_PERMISSIONS, KINTALES_ONLY_PERMISSIONS, type FamilyDoc, type MemberDoc } from '../lib/schema';

export interface FamilyDiff {
  skipped: boolean;
  familyUpdates: Record<string, unknown>;
  memberUpdates: Array<Partial<MemberDoc> & { uid: string }>;
  themeConfigStub?: Record<string, unknown>;
}

export function computeFamilyDiff(
  fid: string,
  family: Partial<FamilyDoc>,
  members: Array<{ id: string; data: Partial<MemberDoc> & { role?: string } }>,
): FamilyDiff {
  if (family.flags?.foundationV1MigratedAt) {
    return { skipped: true, familyUpdates: {}, memberUpdates: [] };
  }
  const lastNameGuess = family.displayName ?? `${fid}`;
  const familyUpdates: Record<string, unknown> = {
    displayName: family.displayName ?? `The ${lastNameGuess} Tribe`,
    primaryUid: family.primaryUid ?? '',
    themeConfigRef: `families/${fid}/themeConfig/active`,
    flags: {
      tribePinSet: false,
      tribePinChangePending: false,
      unverified: false,
      ...family.flags,
    },
  };
  const memberUpdates: Array<Partial<MemberDoc> & { uid: string }> = [];
  let primaryUid: string | undefined;
  for (const m of members) {
    const oldRole = m.data.role as string | undefined;
    if (oldRole === 'ADMIN') {
      primaryUid ??= m.id;
      memberUpdates.push({
        uid: m.id,
        role: 'PRIMARY',
        status: 'ACTIVE',
        permissions: FULL_PERMISSIONS,
        secondaryLabel: null,
      });
    } else {
      memberUpdates.push({
        uid: m.id,
        role: 'SECONDARY',
        status: 'ACTIVE',
        secondaryLabel: 'Folk',
        permissions: KINTALES_ONLY_PERMISSIONS,
      });
    }
  }
  if (primaryUid) familyUpdates.primaryUid = primaryUid;
  return {
    skipped: false,
    familyUpdates,
    memberUpdates,
    themeConfigStub: { brandTokens: {}, kinfolkOverrides: {} },
  };
}
