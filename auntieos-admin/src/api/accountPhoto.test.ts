import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requestSignedUpload, uploadToCloudinary, writeMediaFileDoc } = vi.hoisted(() => ({
  requestSignedUpload: vi.fn(),
  uploadToCloudinary: vi.fn(),
  writeMediaFileDoc: vi.fn(),
}));
const { saveUserPhotoUrl } = vi.hoisted(() => ({ saveUserPhotoUrl: vi.fn() }));
vi.mock('./mediaUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mediaUpload')>()),
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
}));
vi.mock('./accountWrite', () => ({ saveUserPhotoUrl }));
const { setMediaProfilePhoto } = vi.hoisted(() => ({ setMediaProfilePhoto: vi.fn() }));
vi.mock('./mediaWrite', () => ({ setMediaProfilePhoto }));

import { uploadMyStaffPhoto, uploadUserPhoto } from './accountPhoto';

const SIGN = { cloudName: 'demo', apiKey: 'k', timestamp: 1, signature: 's', folder: 'tribetails/user/op-1', entityType: 'USER' };
const CLOUD = { secureUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tribetails/user/op-1/a.jpg', publicId: 'tribetails/user/op-1/a', resourceType: 'image', format: 'jpg', bytes: 10, width: 4, height: 4 };

function png(name = 'me.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

beforeEach(() => {
  requestSignedUpload.mockReset().mockResolvedValue(SIGN);
  uploadToCloudinary.mockReset().mockResolvedValue(CLOUD);
  writeMediaFileDoc.mockReset().mockResolvedValue('media-1');
  saveUserPhotoUrl.mockReset().mockResolvedValue(undefined);
  setMediaProfilePhoto.mockReset().mockResolvedValue({ ok: true });
});

describe('uploadUserPhoto', () => {
  it('signs as USER under the operator uid, uploads, records the media doc, then saves photoUrl', async () => {
    const stages: string[] = [];
    const url = await uploadUserPhoto('op-1', png(), (s) => stages.push(s));

    expect(requestSignedUpload).toHaveBeenCalledWith('USER', 'op-1', 'image');
    expect(uploadToCloudinary).toHaveBeenCalledWith(expect.any(File), SIGN);
    expect(writeMediaFileDoc).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'op-1', entityType: 'USER', originalFileName: 'me.png', cloud: CLOUD, cloudName: 'demo' }),
    );
    // The same URL the media doc stores as storageUrl, so Android and web read
    // one shape off users/{uid}.
    expect(saveUserPhotoUrl).toHaveBeenCalledWith('op-1', CLOUD.secureUrl);
    expect(url).toBe(CLOUD.secureUrl);
    expect(stages).toEqual(['signing', 'uploading', 'saving']);
    // The owner's last step is unchanged by #2287.
    expect(setMediaProfilePhoto).not.toHaveBeenCalled();
  });

  it('saves photoUrl only after the media doc is written, never before', async () => {
    const order: string[] = [];
    writeMediaFileDoc.mockImplementation(async () => {
      order.push('media');
      return 'media-1';
    });
    saveUserPhotoUrl.mockImplementation(async () => {
      order.push('photoUrl');
    });
    await uploadUserPhoto('op-1', png());
    expect(order).toEqual(['media', 'photoUrl']);
  });

  it('refuses a non-image before any network call', async () => {
    const pdf = new File([new Uint8Array([1])], 'scan.pdf', { type: 'application/pdf' });
    await expect(uploadUserPhoto('op-1', pdf)).rejects.toThrow(/image/i);
    expect(requestSignedUpload).not.toHaveBeenCalled();
    expect(uploadToCloudinary).not.toHaveBeenCalled();
    expect(saveUserPhotoUrl).not.toHaveBeenCalled();
  });

  it('leaves photoUrl untouched when the upload itself fails', async () => {
    uploadToCloudinary.mockRejectedValue(new Error('Cloudinary upload failed (HTTP 500)'));
    await expect(uploadUserPhoto('op-1', png())).rejects.toThrow('HTTP 500');
    expect(writeMediaFileDoc).not.toHaveBeenCalled();
    expect(saveUserPhotoUrl).not.toHaveBeenCalled();
  });

  it('requires a uid', async () => {
    await expect(uploadUserPhoto('  ', png())).rejects.toThrow(/uid/);
    expect(requestSignedUpload).not.toHaveBeenCalled();
  });
});

/** #2287: an Auntie's photo. Same upload, and the server puts it on her record. */
describe('uploadMyStaffPhoto', () => {
  it('signs, uploads and records the media as USER under her uid, then asks the server to set it', async () => {
    const stages: string[] = [];
    const url = await uploadMyStaffPhoto('auntie-1', png(), (s) => stages.push(s));
    expect(requestSignedUpload).toHaveBeenCalledWith('USER', 'auntie-1', 'image');
    expect(writeMediaFileDoc).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'auntie-1', entityType: 'USER', originalFileName: 'me.png' }),
    );
    expect(setMediaProfilePhoto).toHaveBeenCalledWith('media-1', 'USER', 'auntie-1');
    // Never the browser write the rules refuse her.
    expect(saveUserPhotoUrl).not.toHaveBeenCalled();
    expect(url).toBe(CLOUD.secureUrl);
    expect(stages).toEqual(['signing', 'uploading', 'saving']);
  });
  it('asks the server only after the media record exists', async () => {
    const order: string[] = [];
    writeMediaFileDoc.mockImplementation(async () => {
      order.push('media');
      return 'media-9';
    });
    setMediaProfilePhoto.mockImplementation(async () => {
      order.push('set');
      return { ok: true };
    });
    await uploadMyStaffPhoto('auntie-1', png());
    expect(order).toEqual(['media', 'set']);
    expect(setMediaProfilePhoto).toHaveBeenCalledWith('media-9', 'USER', 'auntie-1');
  });
  it('refuses a non-image and a blank uid before any network call', async () => {
    const pdf = new File([new Uint8Array([1])], 'scan.pdf', { type: 'application/pdf' });
    await expect(uploadMyStaffPhoto('auntie-1', pdf)).rejects.toThrow(/image/i);
    await expect(uploadMyStaffPhoto('  ', png())).rejects.toThrow(/uid/);
    expect(requestSignedUpload).not.toHaveBeenCalled();
    expect(setMediaProfilePhoto).not.toHaveBeenCalled();
  });
  it('passes on a server refusal, and a failed upload never reaches the server step', async () => {
    setMediaProfilePhoto.mockRejectedValue(new Error('You can change only your own account photo.'));
    await expect(uploadMyStaffPhoto('auntie-1', png())).rejects.toThrow('You can change only your own account photo.');
    setMediaProfilePhoto.mockClear();
    uploadToCloudinary.mockRejectedValue(new Error('Cloudinary upload failed (HTTP 500)'));
    await expect(uploadMyStaffPhoto('auntie-1', png())).rejects.toThrow('HTTP 500');
    expect(setMediaProfilePhoto).not.toHaveBeenCalled();
  });
});
