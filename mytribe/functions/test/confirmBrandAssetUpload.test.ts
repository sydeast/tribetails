import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The confirm half of the brand-logo pipeline. The signing half is AuntieOS's
 * already-deployed `/api/cloudinary/sign-upload`, so there is nothing to test
 * here about signatures; what IS worth pinning is that this callable refuses to
 * write a URL it cannot prove came from that upload, and that a removal is
 * recorded rather than silently blanked.
 */

const setMock = vi.fn();
const docMock = vi.fn(() => ({ set: setMock }));
const collectionMock = vi.fn(() => ({ doc: docMock }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({ collection: collectionMock }) }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => 'tribetails' }),
}));

const CLOUD = 'https://res.cloudinary.com/tribetails/image/upload';
const GOOD = `${CLOUD}/v1721000000/tribetails/business/business_settings/logo_abc.png`;

async function handler() {
  const mod = await import('../src/admin/confirmBrandAssetUpload');
  return mod.confirmBrandAssetUploadHandler;
}

const req = (data: unknown) => ({ data, auth: { uid: 'admin1', token: { admin: true } } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmBrandAssetUpload: what it will persist', () => {
  it('writes a valid Cloudinary URL to logoUrl for businessLogo', async () => {
    const h = await handler();
    const res = await h(req({ kind: 'businessLogo', secureUrl: GOOD }));

    expect(res.logoUrl).toBe(GOOD);
    expect(res.logoRemovedAt).toBe('');
    const [payload, opts] = setMock.mock.calls[0]!;
    expect(payload.logoUrl).toBe(GOOD);
    // merge, or a logo save would delete the rest of the settings doc.
    expect(opts).toEqual({ merge: true });
  });

  it('writes portalLogo as a NESTED key, so theme/banner/chat/home survive it', async () => {
    const h = await handler();
    await h(req({ kind: 'portalLogo', secureUrl: GOOD }));

    const [payload] = setMock.mock.calls[0]!;
    // The whole point: not a top-level `logoUrl`, and not a replacement of the
    // `mytribePortal` map with a logo-only object at the doc's top level.
    expect(payload.mytribePortal).toEqual({ logoUrl: GOOD, logoRemovedAt: '' });
    expect(payload.logoUrl).toBeUndefined();
  });
});

describe('confirmBrandAssetUpload: URLs it refuses', () => {
  // Each of these is a URL an operator could paste, or a compromised client
  // could send, that would otherwise become the kinfolk portal's header image.
  const cases: [string, string][] = [
    ['a host that is not Cloudinary', 'https://evil.example.com/logo.png'],
    ['plain http', 'http://res.cloudinary.com/tribetails/image/upload/tribetails/business/business_settings/a.png'],
    ['a different Cloudinary account', 'https://res.cloudinary.com/someoneelse/image/upload/tribetails/business/business_settings/a.png'],
    ['a raw (non-image) asset', 'https://res.cloudinary.com/tribetails/raw/upload/tribetails/business/business_settings/a.sh'],
    ['our account but outside the signed folder', `${CLOUD}/v1/tribetails/kinfolks/kf1/kin/k1/photo.png`],
  ];

  for (const [label, url] of cases) {
    it(`rejects ${label}, and writes nothing`, async () => {
      const h = await handler();
      await expect(h(req({ kind: 'businessLogo', secureUrl: url }))).rejects.toThrow();
      expect(setMock).not.toHaveBeenCalled();
    });
  }

  it('rejects an unknown kind rather than guessing a field', async () => {
    const h = await handler();
    await expect(h(req({ kind: 'faviconLogo', secureUrl: GOOD }))).rejects.toThrow();
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('confirmBrandAssetUpload: removal is distinguishable from never-set', () => {
  it('clears the url AND stamps logoRemovedAt, so the two states differ on the wire', async () => {
    const h = await handler();
    const res = await h(req({ kind: 'businessLogo', secureUrl: null }));

    expect(res.logoUrl).toBe('');
    // A never-configured install has logoUrl '' and NO removal stamp. This is
    // the only thing that tells an operator "I removed it" from "it never
    // worked", so it is asserted as a real ISO instant, not merely truthy.
    expect(res.logoRemovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [payload] = setMock.mock.calls[0]!;
    expect(payload.logoUrl).toBe('');
    expect(payload.logoRemovedAt).toBe(res.logoRemovedAt);
  });

  it('clears the portal logo nested, leaving the rest of mytribePortal alone', async () => {
    const h = await handler();
    const res = await h(req({ kind: 'portalLogo', secureUrl: null }));

    const [payload] = setMock.mock.calls[0]!;
    expect(payload.mytribePortal.logoUrl).toBe('');
    expect(payload.mytribePortal.logoRemovedAt).toBe(res.logoRemovedAt);
  });

  it('does not reach Cloudinary config to remove, so a clear works even unconfigured', async () => {
    // Removal must never be blocked by a signing misconfiguration: that would
    // strand a bad logo on the client-facing portal with no way to take it down.
    vi.doMock('firebase-functions/params', () => ({ defineSecret: () => ({ value: () => '' }) }));
    vi.resetModules();
    const mod = await import('../src/admin/confirmBrandAssetUpload');
    await expect(mod.confirmBrandAssetUploadHandler(req({ kind: 'businessLogo', secureUrl: null })))
      .resolves.toMatchObject({ logoUrl: '' });
    vi.doUnmock('firebase-functions/params');
    vi.resetModules();
  });
});
