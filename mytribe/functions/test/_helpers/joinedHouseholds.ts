import type { buildDbMock } from './mockDb';

type MockOpts = NonNullable<Parameters<typeof buildDbMock>[0]>;

/**
 * #2482: a broadcast decides who in a household has a MyTribe account with the
 * member check (`resolveKinfolkUid`, #1840), so a household's stored `uid` is
 * an account only when that login is an ACTIVE member of the household.
 *
 * The broadcast suites were written when the stored `uid` alone was the
 * account. This states, in one place, the world they describe: every household
 * fixture with a stored login was really joined by that login, as its PRIMARY.
 * A fixture that seeds its own member record for a household keeps it, which
 * is how the staff-login cases say "nobody joined".
 */
export function withJoinedHouseholds(opts: MockOpts = {}): MockOpts {
  // Added to the fixture's own map, not a copy: a suite that holds that map
  // reads the mock's write-through state from it.
  const docs: NonNullable<MockOpts['docs']> = opts.docs ?? {};
  const households: Array<{ id: string; data: Record<string, unknown> }> = [
    ...(opts.queryDocs?.['kinfolk'] ?? []),
    ...Object.entries(docs)
      .filter(([path, data]) => /^kinfolk\/[^/]+$/.test(path) && data != null)
      .map(([path, data]) => ({ id: path.split('/')[1], data: data as Record<string, unknown> })),
  ];
  for (const { id, data } of households) {
    const uid = typeof data['uid'] === 'string' ? data['uid'].trim() : '';
    if (uid === '') continue;
    const memberPath = `families/${id}/members/${uid}`;
    if (memberPath in docs) continue;
    docs[memberPath] = { role: 'PRIMARY', status: 'ACTIVE' };
  }
  return { ...opts, docs };
}
