import { describe, expect, it } from 'vitest';
import { validateAvatarFile } from './accountApi';

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
