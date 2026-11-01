// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

/**
 * #1339: the `invite.auntie-notify` email links to
 * `${AUNTIE_OS_REVIEW_BASE_URL}/invites/<inviteId>`. This pins that the REAL
 * router (not a stub) matches that path to the invite detail route, under the
 * admin guard, with the id as its param.
 *
 * Only route matching is exercised, so nothing renders and no guard runs; the
 * Firebase seams are stubbed because importing `./router` pulls them in.
 */
vi.mock('./lib/firebase', () => ({
  auth: { currentUser: null },
  db: {},
  functions: {},
  app: {},
  firebaseConfig: {},
  ADMIN_APP_CHECK_SITE_KEY: '',
  activateAppCheck: vi.fn(),
  getAppCheckStatus: () => 'off',
  resetAppCheckForTest: vi.fn(),
  E2E_EMULATOR_HOST: '',
  E2E_FUNCTIONS_PORT: 5399,
}));
vi.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: vi.fn() },
  getIdTokenResult: vi.fn(),
  onAuthStateChanged: (_a: unknown, cb: (u: null) => void) => {
    cb(null);
    return () => {};
  },
  reauthenticateWithCredential: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updatePassword: vi.fn(),
  verifyBeforeUpdateEmail: vi.fn(),
}));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('./lib/sentry', () => ({ reportError: vi.fn(), initSentry: vi.fn() }));
vi.mock('./lib/boot', () => ({ decideAttestation: vi.fn(), attestationOwnsRecaptcha: () => false }));
vi.mock('./lib/firestore', () => ({ useCollection: vi.fn() }));

describe('invite detail route (#1339)', () => {
  it('matches /invites/<id> to the admin-guarded detail route with the id as its param', async () => {
    const { router } = await import('./router');
    const matches = router.matchRoutes('/invites/rq_8fk29abcdef', {});
    const leaf = matches[matches.length - 1]!;
    expect(leaf.routeId).toBe('/admin/invites/$inviteId');
    expect(leaf.params).toMatchObject({ inviteId: 'rq_8fk29abcdef' });
    // Under the admin layout, so the requireAdmin guard runs first.
    expect(matches.map((m) => m.routeId)).toContain('/admin');
  });

  it('leaves /invites itself on the list', async () => {
    const { router } = await import('./router');
    const matches = router.matchRoutes('/invites', {});
    expect(matches[matches.length - 1]!.routeId).toBe('/admin/invites');
  });
});
