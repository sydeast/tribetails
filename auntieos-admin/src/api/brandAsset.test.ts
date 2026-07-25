import { describe, expect, it, vi, beforeEach } from 'vitest';

const call = vi.fn();
const requestSignedUpload = vi.fn();
const uploadToCloudinary = vi.fn();

vi.mock('../lib/fns', () => ({ call: (...a: unknown[]) => call(...a) }));
vi.mock('./mediaUpload', () => ({
  BUSINESS_ENTITY_ID: 'business_settings',
  requestSignedUpload: (...a: unknown[]) => requestSignedUpload(...a),
  uploadToCloudinary: (...a: unknown[]) => uploadToCloudinary(...a),
}));

const SECURE_URL =
  'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';

function pngFile(size = 40_000): File {
  return { type: 'image/png', size, name: 'logo.png' } as unknown as File;
}
const decode = () => Promise.resolve({ width: 512, height: 200 });

beforeEach(() => {
  vi.clearAllMocks();
  requestSignedUpload.mockResolvedValue({ cloudName: 'tribetails', apiKey: 'k', timestamp: 1, signature: 's', folder: 'tribetails/business/business_settings', allowedFormats: '', entityType: 'BUSINESS', entityId: 'business_settings' });
  uploadToCloudinary.mockResolvedValue({ secureUrl: SECURE_URL, publicId: 'p', resourceType: 'image', format: 'png', bytes: 40_000 });
  call.mockResolvedValue({ kind: 'businessLogo', logoUrl: SECURE_URL, logoRemovedAt: '' });
});

describe('uploadBrandAsset reuses the existing upload path', () => {
  it('signs through the BUSINESS/business_settings target the admin and Android already use', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    await uploadBrandAsset({ kind: 'businessLogo', file: pngFile(), decode });

    // No new signer: this is `api/mediaUpload.ts`'s existing
    // `/api/cloudinary/sign-upload` call, with the same entity Android's
    // MediaUploadManager uses for the logo today.
    expect(requestSignedUpload).toHaveBeenCalledWith('BUSINESS', 'business_settings');
  });

  it('persists through confirmBrandAssetUpload, not by writing the doc itself', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    const res = await uploadBrandAsset({ kind: 'portalLogo', file: pngFile(), decode });

    expect(call).toHaveBeenCalledWith('confirmBrandAssetUpload', { kind: 'portalLogo', secureUrl: SECURE_URL });
    expect(res.logoUrl).toBe(SECURE_URL);
  });

  it('does NOT write a media_files row, so a logo never lands in the Gallery grid', async () => {
    // Android's uploadLogo does write one, which is why an abandoned upload
    // there leaves an orphan gallery record. This path deliberately does not.
    const mod = await import('./brandAsset');
    expect(Object.keys(mod)).not.toContain('writeMediaFileDoc');
  });

  it('reports every real stage, in order', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    const stages: string[] = [];
    await uploadBrandAsset({ kind: 'businessLogo', file: pngFile(), decode, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['checking', 'signing', 'uploading', 'saving']);
  });
});

describe('validation happens BEFORE anything leaves the browser', () => {
  // This is the whole point of the task's "validate before upload, not after".
  it('refuses an oversize file without signing or uploading', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    await expect(
      uploadBrandAsset({ kind: 'businessLogo', file: pngFile(12_000_000), decode }),
    ).rejects.toThrow(/12\.0 MB/);

    expect(requestSignedUpload).not.toHaveBeenCalled();
    expect(uploadToCloudinary).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a wrong type without signing or uploading', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    const svg = { type: 'image/svg+xml', size: 900, name: 'l.svg' } as unknown as File;
    await expect(uploadBrandAsset({ kind: 'businessLogo', file: svg, decode })).rejects.toThrow();
    expect(requestSignedUpload).not.toHaveBeenCalled();
  });

  it('refuses a wrong-dimension file without signing or uploading', async () => {
    const { uploadBrandAsset } = await import('./brandAsset');
    await expect(
      uploadBrandAsset({ kind: 'businessLogo', file: pngFile(), decode: () => Promise.resolve({ width: 12, height: 12 }) }),
    ).rejects.toThrow(/12x12/);
    expect(requestSignedUpload).not.toHaveBeenCalled();
  });
});

describe('failures leave the stored logo alone', () => {
  it('does not confirm anything when the Cloudinary upload fails', async () => {
    uploadToCloudinary.mockRejectedValue(new Error('Cloudinary said no'));
    const { uploadBrandAsset } = await import('./brandAsset');
    await expect(uploadBrandAsset({ kind: 'businessLogo', file: pngFile(), decode })).rejects.toThrow('Cloudinary said no');
    // Nothing was persisted, so the previous logo is still the current logo.
    expect(call).not.toHaveBeenCalled();
  });

  it('surfaces a rejected confirm rather than reporting success', async () => {
    call.mockRejectedValue(new Error('secureUrl is outside the signed folder.'));
    const { uploadBrandAsset } = await import('./brandAsset');
    await expect(uploadBrandAsset({ kind: 'businessLogo', file: pngFile(), decode })).rejects.toThrow(/signed folder/);
  });
});

describe('removal', () => {
  it('sends secureUrl null, the remove action on the same callable', async () => {
    call.mockResolvedValue({ kind: 'portalLogo', logoUrl: '', logoRemovedAt: '2026-07-25T12:00:00.000Z' });
    const { removeBrandAsset } = await import('./brandAsset');
    const res = await removeBrandAsset('portalLogo');

    expect(call).toHaveBeenCalledWith('confirmBrandAssetUpload', { kind: 'portalLogo', secureUrl: null });
    // The stamp is what keeps "removed" distinguishable from "never set".
    expect(res.logoRemovedAt).not.toBe('');
    expect(res.logoUrl).toBe('');
  });
});
