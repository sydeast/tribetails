import { describe, expect, it, vi, beforeEach } from 'vitest';

// This project's vitest environment is 'node' (no jsdom/browser globals),
// so sessionStorage doesn't exist here by default. Self-contained polyfill,
// scoped to this file only — activeTribe.ts's ensureAccess/setActiveKinfolkId
// were previously entirely untested for exactly this reason.
if (typeof sessionStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
}

const mocks = vi.hoisted(() => ({
  setActiveTribe: vi.fn(),
  getIdToken: vi.fn(),
  getIdTokenResult: vi.fn(),
  getMyAccess: vi.fn(),
}));
vi.mock('../api/portal', () => ({ setActiveTribe: mocks.setActiveTribe, getMyAccess: mocks.getMyAccess }));
vi.mock('./firebase', () => ({
  auth: { currentUser: { getIdToken: mocks.getIdToken, getIdTokenResult: mocks.getIdTokenResult } },
}));
vi.mock('./auth', () => ({
  getAuthState: () => ({ status: 'signedIn', user: { uid: 'u1' } }),
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1' } }),
}));

import { clearAccess, ensureAccess, resolveLaunchDestination, setActiveKinfolkId, type AccessState } from './activeTribe';

beforeEach(() => {
  mocks.setActiveTribe.mockReset().mockResolvedValue({ ok: true, kinfolkId: 'k2' });
  mocks.getIdToken.mockReset().mockResolvedValue('fresh-token');
  mocks.getIdTokenResult.mockReset().mockResolvedValue({ claims: { kinfolkId: 'k1', role: 'kinfolk' } });
  mocks.getMyAccess.mockReset().mockResolvedValue({ kinfolkIds: ['k1', 'k2'], isOperator: false });
  sessionStorage.clear();
  clearAccess();
});

/** Token claims as the client sees them: cached first, then whatever a forced refresh reveals. */
function tokenClaims(cached: Record<string, unknown>, afterRefresh?: Record<string, unknown>) {
  mocks.getIdTokenResult.mockImplementation((force?: boolean) =>
    Promise.resolve({ claims: force && afterRefresh ? afterRefresh : cached }),
  );
}

function access(overrides: Partial<AccessState>): AccessState {
  return { kinfolkIds: [], isOperator: false, activeKinfolkId: null, error: null, ...overrides };
}

describe('resolveLaunchDestination', () => {
  it('loading while auth is loading', () => {
    expect(resolveLaunchDestination('loading', null)).toBe('loading');
  });

  it('signIn when signed out, regardless of access', () => {
    expect(resolveLaunchDestination('signedOut', null)).toBe('signIn');
  });

  it('loading when signed in but access not yet resolved', () => {
    expect(resolveLaunchDestination('signedIn', null)).toBe('loading');
  });

  it('error when access resolution failed', () => {
    expect(resolveLaunchDestination('signedIn', access({ error: 'boom' }))).toBe('error');
  });

  it('noTribes when kinfolkIds is empty', () => {
    expect(resolveLaunchDestination('signedIn', access({ kinfolkIds: [] }))).toBe('noTribes');
  });

  it('pick for an operator even with a single kinfolkId', () => {
    expect(resolveLaunchDestination('signedIn', access({ kinfolkIds: ['k1'], isOperator: true }))).toBe('pick');
  });

  it('home for exactly one kinfolkId, non-operator', () => {
    expect(resolveLaunchDestination('signedIn', access({ kinfolkIds: ['k1'] }))).toBe('home');
  });

  it('pick for 2+ kinfolkIds, non-operator, with none picked yet', () => {
    expect(resolveLaunchDestination('signedIn', access({ kinfolkIds: ['k1', 'k2'] }))).toBe('pick');
  });

  it('home for 2+ kinfolkIds once one is picked', () => {
    expect(resolveLaunchDestination('signedIn', access({ kinfolkIds: ['k1', 'k2'], activeKinfolkId: 'k2' }))).toBe('home');
  });
});

/**
 * O-37. A single-tribe kinfolk is auto-picked and never sees the TribePicker,
 * so they never hit setActiveKinfolkId's claim re-mint + token refresh. Their
 * token is minted at account-creation, BEFORE acceptInvite stamps the claim —
 * so it carries no kinfolkId, and every claim-gated direct read (realtime
 * Messages, live GPS breadcrumbs) is denied until the token happens to refresh.
 * ensureAccess has to reconcile the token against the tribe it just auto-picked.
 */
describe('ensureAccess: token claim reconciliation (O-37)', () => {
  it('spends nothing when the cached token already names the active tribe', async () => {
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: ['k1'], isOperator: false });
    tokenClaims({ role: 'kinfolk', kinfolkId: 'k1' });

    const state = await ensureAccess();

    expect(state.activeKinfolkId).toBe('k1');
    expect(mocks.getIdTokenResult).toHaveBeenCalledTimes(1); // the cached read, no force
    expect(mocks.getIdTokenResult).not.toHaveBeenCalledWith(true);
    expect(mocks.setActiveTribe).not.toHaveBeenCalled();
  });

  it('refreshes the token when the claim is missing, and does NOT burn a setActiveTribe call', async () => {
    // The freshly-accepted kinfolk: acceptInvite already stamped the claim
    // server-side, so one forced refresh is enough to see it.
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: ['k1'], isOperator: false });
    tokenClaims({}, { role: 'kinfolk', kinfolkId: 'k1' });

    await ensureAccess();

    expect(mocks.getIdTokenResult).toHaveBeenCalledWith(true);
    expect(mocks.setActiveTribe).not.toHaveBeenCalled();
  });

  it('falls back to a setActiveTribe re-mint when even a fresh token disagrees', async () => {
    // Genuine divergence (another device switched tribes): refreshing alone
    // cannot fix it, the server has to re-mint against the tribe we picked.
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: ['k1'], isOperator: false });
    tokenClaims({ role: 'kinfolk', kinfolkId: 'someone-else' });

    await ensureAccess();

    expect(mocks.getIdTokenResult).toHaveBeenCalledWith(true);
    expect(mocks.setActiveTribe).toHaveBeenCalledWith('k1');
  });

  it('leaves the token alone when there is no tribe to be active in', async () => {
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: [], isOperator: false });
    tokenClaims({});

    const state = await ensureAccess();

    expect(state.activeKinfolkId).toBeNull();
    expect(mocks.getIdTokenResult).not.toHaveBeenCalled();
    expect(mocks.setActiveTribe).not.toHaveBeenCalled();
  });

  it('still resolves access when the claim reconcile throws — boot must not hang on it', async () => {
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: ['k1'], isOperator: false });
    mocks.getIdTokenResult.mockRejectedValue(new Error('token endpoint down'));

    const state = await ensureAccess();

    expect(state.activeKinfolkId).toBe('k1');
    expect(state.error).toBeNull();
  });

  it('does not reconcile for an operator, whose access is not kinfolk-claim gated', async () => {
    mocks.getMyAccess.mockResolvedValue({ kinfolkIds: ['k1'], isOperator: true });
    tokenClaims({});

    const state = await ensureAccess();

    expect(state.activeKinfolkId).toBeNull(); // operators pick explicitly
    expect(mocks.setActiveTribe).not.toHaveBeenCalled();
  });
});

describe('setActiveKinfolkId (O-5 claim re-mint)', () => {
  it('updates sessionStorage + local state synchronously, before the backend call resolves', async () => {
    await ensureAccess();
    // Don't await setActiveTribe's promise yet — prove the sessionStorage
    // write already happened, i.e. the UI-visible part isn't gated on the
    // network round trip.
    setActiveKinfolkId('k2');
    expect(sessionStorage.getItem('mytribe.activeKinfolkId.u1')).toBe('k2');
  });

  it('calls the backend setActiveTribe callable with the picked kinfolkId', async () => {
    await ensureAccess();
    setActiveKinfolkId('k2');
    await Promise.resolve(); // flush the fire-and-forget microtask chain
    await Promise.resolve();
    expect(mocks.setActiveTribe).toHaveBeenCalledWith('k2');
  });

  it('forces an ID token refresh after the claim re-mint succeeds', async () => {
    await ensureAccess();
    setActiveKinfolkId('k2');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.getIdToken).toHaveBeenCalledWith(true);
  });

  it('does not throw when the backend call fails (logged, not surfaced)', async () => {
    mocks.setActiveTribe.mockRejectedValue(new Error('permission-denied'));
    await ensureAccess();
    expect(() => setActiveKinfolkId('k2')).not.toThrow();
  });

  it('is a no-op before ensureAccess has ever resolved (state is null)', () => {
    setActiveKinfolkId('k2');
    expect(sessionStorage.getItem('mytribe.activeKinfolkId.u1')).toBeNull();
    expect(mocks.setActiveTribe).not.toHaveBeenCalled();
  });
});
