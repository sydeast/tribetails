import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAvatarFile, uploadAvatarToCloudinary, type SignedAvatarUpload } from './accountApi';

describe('validateAvatarFile', () => {
  it('accepts a small jpeg', () => {
    expect(validateAvatarFile({ size: 1024, type: 'image/jpeg' })).toBeNull();
  });

  it('accepts png/webp/gif and is case-insensitive on mime type', () => {
    expect(validateAvatarFile({ size: 1024, type: 'image/PNG' })).toBeNull();
    expect(validateAvatarFile({ size: 1024, type: 'image/webp' })).toBeNull();
    expect(validateAvatarFile({ size: 1024, type: 'image/gif' })).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateAvatarFile({ size: 0, type: 'image/jpeg' })).toMatch(/empty/);
  });

  it('rejects a file over the 2MB cap', () => {
    expect(validateAvatarFile({ size: 2 * 1024 * 1024 + 1, type: 'image/jpeg' })).toMatch(/2MB/);
  });

  it('accepts a file exactly at the 2MB cap', () => {
    expect(validateAvatarFile({ size: 2 * 1024 * 1024, type: 'image/jpeg' })).toBeNull();
  });

  it('rejects a disallowed mime type', () => {
    expect(validateAvatarFile({ size: 1024, type: 'application/pdf' })).toMatch(/JPG, PNG, WebP, or GIF/);
  });
});
// ---------------------------------------------------------------------------
// #583: the stored original of an avatar carries no EXIF GPS
// ---------------------------------------------------------------------------
// Same mechanism as the kin photo: signKinfolkAvatar signs
// `transformation=fl_force_strip`, and this helper is what puts it on the wire.
describe('uploadAvatarToCloudinary (#583)', () => {
  const SIGNED: SignedAvatarUpload = {
    cloudName: 'demo',
    apiKey: 'key123',
    timestamp: 1700000000,
    signature: 'sig',
    folder: 'tribetails/kinfolks/uid/avatars',
    allowedFormats: 'jpg,png,webp,gif',
    transformation: 'fl_force_strip',
  };
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg' }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('posts the signed transformation so the avatar is stored stripped', async () => {
    const url = await uploadAvatarToCloudinary(SIGNED, new File(['b'], 'me.jpg', { type: 'image/jpeg' }));
    expect(url).toBe('https://res.cloudinary.com/demo/image/upload/v1/a.jpg');
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.body as FormData).get('transformation')).toBe('fl_force_strip');
  });
});
