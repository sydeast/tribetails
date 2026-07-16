import { describe, expect, it } from 'vitest';
import { validateKinPhotoFile, KIN_PHOTO_MAX_BYTES } from './kinPhotoApi';

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
