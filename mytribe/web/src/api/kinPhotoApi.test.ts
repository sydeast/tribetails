import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateKinPhotoFile,
  KIN_PHOTO_MAX_BYTES,
  uploadKinPhotoToCloudinary,
  type SignedKinPhotoUpload,
} from './kinPhotoApi';

describe('validateKinPhotoFile', () => {
  it('accepts a small jpeg', () => {
    expect(validateKinPhotoFile({ size: 1024, type: 'image/jpeg' })).toBeNull();
  });

  it('accepts png/webp/gif and is case-insensitive on mime type', () => {
    expect(validateKinPhotoFile({ size: 1024, type: 'image/PNG' })).toBeNull();
    expect(validateKinPhotoFile({ size: 1024, type: 'image/webp' })).toBeNull();
    expect(validateKinPhotoFile({ size: 1024, type: 'image/gif' })).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateKinPhotoFile({ size: 0, type: 'image/jpeg' })).toMatch(/empty/);
  });

  it('rejects a file over the 10MB cap', () => {
    expect(validateKinPhotoFile({ size: KIN_PHOTO_MAX_BYTES + 1, type: 'image/jpeg' })).toMatch(/10MB/);
  });

  it('accepts a file exactly at the 10MB cap', () => {
    expect(validateKinPhotoFile({ size: KIN_PHOTO_MAX_BYTES, type: 'image/jpeg' })).toBeNull();
  });

  it('rejects a disallowed mime type', () => {
    expect(validateKinPhotoFile({ size: 1024, type: 'application/pdf' })).toMatch(/JPG, PNG, WebP, or GIF/);
  });
});
// ---------------------------------------------------------------------------
// #583: the stored original of a kin photo carries no EXIF GPS
// ---------------------------------------------------------------------------
// signKinPhotoUpload folds `transformation=fl_force_strip` into the signature
// base (functions/test/cloudinary.test.ts pins that). Cloudinary rebuilds the
// signature from the fields it RECEIVES, so this helper posting the field is
// the other half of the mechanism — without it every kin photo upload would
// fail as an Invalid Signature rather than store an unstripped photo.
describe('uploadKinPhotoToCloudinary (#583)', () => {
  const SIGNED: SignedKinPhotoUpload = {
    cloudName: 'demo',
    apiKey: 'key123',
    timestamp: 1700000000,
    signature: 'sig',
    folder: 'tribetails/kinfolks/kf1/kin/dog1',
    allowedFormats: 'jpg,png,webp,gif',
    transformation: 'fl_force_strip',
  };
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/p.jpg' }),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function postedForm(): FormData {
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    return opts.body as FormData;
  }
  it('posts the signed transformation alongside the rest of the signed set', async () => {
    const file = new File(['bytes'], 'dog.jpg', { type: 'image/jpeg' });
    const url = await uploadKinPhotoToCloudinary(SIGNED, file);
    expect(url).toBe('https://res.cloudinary.com/demo/image/upload/v1/p.jpg');
    const form = postedForm();
    expect(form.get('transformation')).toBe('fl_force_strip');
    expect(form.get('folder')).toBe('tribetails/kinfolks/kf1/kin/dog1');
    expect(form.get('allowed_formats')).toBe('jpg,png,webp,gif');
    expect(form.get('signature')).toBe('sig');
  });
  it('posts no transformation field when the signer signed none', async () => {
    const file = new File(['bytes'], 'dog.jpg', { type: 'image/jpeg' });
    await uploadKinPhotoToCloudinary({ ...SIGNED, transformation: '' }, file);
    expect(postedForm().get('transformation')).toBeNull();
  });
});
