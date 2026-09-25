import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  requestSignedUpload: vi.fn(),
  uploadToCloudinary: vi.fn(),
  writeMediaFileDoc: vi.fn(),
}));
vi.mock('./mediaUpload', () => ({ ...m, BUSINESS_ENTITY_ID: 'business_settings' }));

import { EMAIL_IMAGE_MAX_BYTES, emailImageFileError, uploadEmailImage } from './emailImageUpload';

const SIGN = { cloudName: 'tribetails', folder: 'tribetails/business/business_settings' };
const URL_OK = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/pup.jpg';
const png = (bytes = 1000) => Object.defineProperty(new File(['x'], 'pup.png', { type: 'image/png' }), 'size', { value: bytes });

beforeEach(() => {
  m.requestSignedUpload.mockResolvedValue(SIGN);
  m.uploadToCloudinary.mockResolvedValue({ secureUrl: URL_OK, publicId: 'p', resourceType: 'image', format: 'jpg', bytes: 1000 });
  m.writeMediaFileDoc.mockResolvedValue('doc1');
});

describe('emailImageFileError', () => {
  it('accepts a normal photo', () => {
    expect(emailImageFileError({ type: 'image/jpeg', size: 200_000 })).toBeNull();
  });
  it('refuses a PDF, naming the formats it takes', () => {
    expect(emailImageFileError({ type: 'application/pdf', size: 1000 })).toBe('Pick a JPG, PNG, GIF or WebP image.');
  });
  it('refuses an image over the limit, saying how big it is', () => {
    expect(emailImageFileError({ type: 'image/png', size: 12 * 1024 * 1024 })).toBe('That image is 12.0 MB. Pick one under 5 MB.');
    expect(emailImageFileError({ type: 'image/png', size: EMAIL_IMAGE_MAX_BYTES })).toBeNull();
  });
});

describe('uploadEmailImage', () => {
  it('signs for the business folder, uploads, records it in the gallery, and returns the delivery URL', async () => {
    const stages: string[] = [];
    await expect(uploadEmailImage(png(), (s) => stages.push(s))).resolves.toBe(URL_OK);
    expect(m.requestSignedUpload).toHaveBeenCalledWith('BUSINESS', 'business_settings', 'image');
    expect(m.writeMediaFileDoc).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'BUSINESS', entityId: 'business_settings', originalFileName: 'pup.png', cloudName: 'tribetails' }),
    );
    expect(stages).toEqual(['signing', 'uploading', 'saving']);
  });

  it('refuses a bad file before signing anything', async () => {
    await expect(uploadEmailImage(png(12 * 1024 * 1024))).rejects.toThrow('That image is 12.0 MB. Pick one under 5 MB.');
    expect(m.requestSignedUpload).not.toHaveBeenCalled();
  });

  it('refuses a URL outside the image delivery path rather than inserting something the server will strip', async () => {
    m.uploadToCloudinary.mockResolvedValue({ secureUrl: 'https://res.cloudinary.com/tribetails/raw/upload/x.png', publicId: 'p', resourceType: 'raw', format: '', bytes: 1 });
    await expect(uploadEmailImage(png())).rejects.toThrow('Cloudinary did not store this file as an image.');
    expect(m.writeMediaFileDoc).not.toHaveBeenCalled();
  });

  it('refuses a URL from a different cloud than the one that just signed the upload', async () => {
    m.uploadToCloudinary.mockResolvedValue({ secureUrl: 'https://res.cloudinary.com/someone-else/image/upload/v1/x.png', publicId: 'p', resourceType: 'image', format: 'png', bytes: 1 });
    await expect(uploadEmailImage(png())).rejects.toThrow('Cloudinary did not store this file as an image.');
    expect(m.writeMediaFileDoc).not.toHaveBeenCalled();
  });
});
