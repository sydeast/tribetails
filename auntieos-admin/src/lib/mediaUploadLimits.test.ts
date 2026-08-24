import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  formatMegabytes,
  isAcceptedUploadType,
  uploadFileError,
} from './mediaUploadLimits';

function file(over: Partial<{ name: string; type: string; size: number }> = {}) {
  return { name: 'biscuit.jpg', type: 'image/jpeg', size: 1024, ...over };
}

describe('MAX_UPLOAD_BYTES', () => {
  it('is 50MB, byte-for-byte Android CloudinaryConfig.MAX_FILE_SIZE', () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('isAcceptedUploadType', () => {
  it('accepts every image/* and video/* subtype, not a hardcoded list', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime']) {
      expect(isAcceptedUploadType(t)).toBe(true);
    }
  });

  it('is case- and whitespace-insensitive: browsers are not consistent about either', () => {
    expect(isAcceptedUploadType('IMAGE/JPEG')).toBe(true);
    expect(isAcceptedUploadType('  video/mp4 ')).toBe(true);
  });

  it('refuses documents, archives, and audio, which this gallery upload does not offer', () => {
    for (const t of ['application/pdf', 'application/zip', 'text/csv', 'audio/mpeg']) {
      expect(isAcceptedUploadType(t)).toBe(false);
    }
  });

  it('refuses a BLANK type rather than waving through a file nothing could identify', () => {
    expect(isAcceptedUploadType('')).toBe(false);
    expect(isAcceptedUploadType('   ')).toBe(false);
  });
});

describe('uploadFileError', () => {
  it('accepts an ordinary photo', () => {
    expect(uploadFileError(file())).toBeNull();
  });

  it('accepts a file exactly ON the limit: the cap is inclusive, as Android reads it', () => {
    expect(uploadFileError(file({ size: MAX_UPLOAD_BYTES }))).toBeNull();
  });

  it('refuses one byte over the limit, naming the file, its size, and the cap', () => {
    const msg = uploadFileError(file({ name: 'huge.mp4', type: 'video/mp4', size: MAX_UPLOAD_BYTES + 1 }));
    expect(msg).toContain('huge.mp4');
    expect(msg).toContain('50MB');
  });

  it('refuses a non-media file BY TYPE even when it is tiny', () => {
    const msg = uploadFileError(file({ name: 'invoice.pdf', type: 'application/pdf', size: 12 }));
    expect(msg).toMatch(/not a photo or a video/i);
  });

  it('checks the type BEFORE the size, so a huge PDF is refused for what it is', () => {
    const msg = uploadFileError(file({ name: 'scan.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES * 3 }));
    expect(msg).toMatch(/not a photo or a video/i);
  });

  it('refuses a zero-byte file, which Cloudinary would only reject after a full round trip', () => {
    expect(uploadFileError(file({ size: 0 }))).toMatch(/empty/i);
  });
});

describe('formatMegabytes', () => {
  it('keeps a round number round, so the cap reads as "50MB"', () => {
    expect(formatMegabytes(MAX_UPLOAD_BYTES)).toBe('50MB');
  });

  it('shows one decimal for a partial megabyte', () => {
    expect(formatMegabytes(1.5 * 1024 * 1024)).toBe('1.5MB');
  });
});
