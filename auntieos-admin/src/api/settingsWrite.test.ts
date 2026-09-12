import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setDoc, doc } = vi.hoisted(() => ({ setDoc: vi.fn(), doc: vi.fn() }));
vi.mock('firebase/firestore', () => ({ setDoc, doc }));

const { currentUser } = vi.hoisted(() => ({ currentUser: { current: null as { email?: string; uid?: string } | null } }));
vi.mock('../lib/firebase', () => ({
  db: {},
  get auth() {
    return { get currentUser() { return currentUser.current; } };
  },
}));

import { saveBusinessSettings } from './settingsWrite';

beforeEach(() => {
  setDoc.mockReset();
  doc.mockReset();
  doc.mockReturnValue('doc-ref');
  currentUser.current = null;
  vi.useRealTimers();
});

describe('saveBusinessSettings', () => {
  it('writes business_settings/business_settings with setDoc merge:true, not a callable', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveBusinessSettings({ businessName: 'Tribe Tails Care' });
    expect(doc).toHaveBeenCalledWith({}, 'business_settings', 'business_settings');
    expect(setDoc).toHaveBeenCalledTimes(1);
    const [ref, body, opts] = setDoc.mock.calls[0]!;
    expect(ref).toBe('doc-ref');
    expect(body).toMatchObject({ businessName: 'Tribe Tails Care' });
    expect(opts).toEqual({ merge: true });
  });

  it('stamps updatedAt as an ISO string on every save', async () => {
    setDoc.mockResolvedValue(undefined);
    const before = Date.now();
    const stamp = await saveBusinessSettings({ venmoHandle: '@tribetails' });
    const stampedAt = new Date(stamp.updatedAt).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    const [, body] = setDoc.mock.calls[0]!;
    expect((body as { updatedAt: string }).updatedAt).toBe(stamp.updatedAt);
  });

  it('stamps updatedBy from the signed-in user email', async () => {
    setDoc.mockResolvedValue(undefined);
    currentUser.current = { email: 'auntie@tribetails.com', uid: 'uid123' };
    const stamp = await saveBusinessSettings({ businessName: 'x' });
    expect(stamp.updatedBy).toBe('auntie@tribetails.com');
    const [, body] = setDoc.mock.calls[0]!;
    expect((body as { updatedBy: string }).updatedBy).toBe('auntie@tribetails.com');
  });

  it('falls back to uid when the signed-in user has no email', async () => {
    setDoc.mockResolvedValue(undefined);
    currentUser.current = { uid: 'uid123' };
    const stamp = await saveBusinessSettings({ businessName: 'x' });
    expect(stamp.updatedBy).toBe('uid123');
  });

  it('stamps a blank updatedBy rather than throwing when nobody is signed in', async () => {
    setDoc.mockResolvedValue(undefined);
    currentUser.current = null;
    const stamp = await saveBusinessSettings({ businessName: 'x' });
    expect(stamp.updatedBy).toBe('');
  });

  it('sends only the patched fields, never the whole document', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveBusinessSettings({ paypalHandle: 'auntie@paypal.com' });
    const [, body] = setDoc.mock.calls[0]!;
    expect(Object.keys(body as object).sort()).toEqual(['paypalHandle', 'updatedAt', 'updatedBy']);
  });

  it('propagates a genuine write failure for the caller to surface fail-loud', async () => {
    setDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(saveBusinessSettings({ businessName: 'x' })).rejects.toThrow('permission-denied');
  });

  /**
   * The KinCare types rate card. `merge: true` merges a nested map key by key,
   * so a patch that dropped "Walk" from `serviceRates` left the stored "Walk"
   * in place and Remove never persisted (except for the last type, since an
   * empty map does overwrite). The two rate-card maps are written with
   * `mergeFields`, which replaces each named field wholesale.
   */
  it('replaces the rate-card maps wholesale so a removed KinCare type stays removed', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveBusinessSettings({ serviceRates: { Overnight: '80.00' }, serviceDurations: {} });
    const [, body, opts] = setDoc.mock.calls[0]!;
    expect(body).toMatchObject({ serviceRates: { Overnight: '80.00' }, serviceDurations: {} });
    expect(opts).toEqual({ mergeFields: ['serviceRates', 'serviceDurations', 'updatedAt', 'updatedBy'] });
  });

  it('keeps the key-by-key merge for every other patch, which is what protects mytribePortal', async () => {
    setDoc.mockResolvedValue(undefined);
    await saveBusinessSettings({ mytribePortal: { themeId: 'den' } as never });
    const [, , opts] = setDoc.mock.calls[0]!;
    expect(opts).toEqual({ merge: true });
  });
});
