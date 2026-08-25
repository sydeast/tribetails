import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

const { requestSignedUpload, uploadToCloudinary, writeMediaFileDoc } = vi.hoisted(() => ({
  requestSignedUpload: vi.fn(),
  uploadToCloudinary: vi.fn(),
  writeMediaFileDoc: vi.fn(),
}));
vi.mock('./mediaUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mediaUpload')>()),
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
}));

import {
  createTrainingDocument,
  deleteTrainingDocument,
  updateTrainingDocument,
  uploadTribalIntelAttachment,
} from './tribalIntelWrite';

beforeEach(() => {
  call.mockReset();
  requestSignedUpload.mockReset();
  uploadToCloudinary.mockReset();
  writeMediaFileDoc.mockReset();
});

const args = {
  title: 'Gate code',
  content: 'Side gate code changed to 4417.',
  notes: '',
  communicationType: 'note',
  targetType: 'KINFOLK' as const,
  targetKinfolkId: 'kf1',
  attachments: [],
};

describe('tribalIntelWrite api', () => {
  it('createTrainingDocument sends the flat args the deployed callable parses, and returns the docId', async () => {
    call.mockResolvedValue({ ok: true, docId: 'td-1' });
    const id = await createTrainingDocument(args);
    expect(call).toHaveBeenCalledWith('createTrainingDocument', args);
    expect(id).toBe('td-1');
  });

  it('updateTrainingDocument folds docId into the same flat arg shape', async () => {
    call.mockResolvedValue({ ok: true, docId: 'td-1' });
    const id = await updateTrainingDocument('td-1', args);
    expect(call).toHaveBeenCalledWith('updateTrainingDocument', { docId: 'td-1', ...args });
    expect(id).toBe('td-1');
  });

  it('deleteTrainingDocument sends only { docId }', async () => {
    call.mockResolvedValue({ ok: true, docId: 'td-1' });
    await deleteTrainingDocument('td-1');
    expect(call).toHaveBeenCalledWith('deleteTrainingDocument', { docId: 'td-1' });
  });

  it('surfaces a callable rejection rather than swallowing it', async () => {
    call.mockRejectedValueOnce(new Error('createTrainingDocument validation failed'));
    await expect(createTrainingDocument(args)).rejects.toThrow('createTrainingDocument validation failed');
  });

  it('refuses a blank docId locally rather than sending a doomed callable', async () => {
    await expect(deleteTrainingDocument('  ')).rejects.toThrow(/docId/);
    expect(call).not.toHaveBeenCalled();
  });

  it('uploadTribalIntelAttachment runs sign, upload, media_files write and returns the attachment shape', async () => {
    requestSignedUpload.mockResolvedValue({
      cloudName: 'tt',
      apiKey: 'k',
      timestamp: 1,
      signature: 's',
      folder: 'tribetails/tribal_intel/pending',
      allowedFormats: '',
      transformation: 'fl_force_strip',
      entityType: 'TRIBAL_INTEL',
      entityId: 'pending',
    });
    uploadToCloudinary.mockResolvedValue({
      secureUrl: 'https://res.cloudinary.com/tt/image/upload/v1/a.jpg',
      publicId: 'tribetails/tribal_intel/pending/a',
      resourceType: 'image',
      format: 'jpg',
      bytes: 100,
    });
    writeMediaFileDoc.mockResolvedValue('media-1');

    const file = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
    const attachment = await uploadTribalIntelAttachment(file);

    // #583: a photographed document attached here is stripped exactly like a
    // gallery photo, and the kind comes from the picked file, not the caller.
    expect(requestSignedUpload).toHaveBeenCalledWith('TRIBAL_INTEL', 'pending', 'image');
    expect(writeMediaFileDoc).toHaveBeenCalled();
    expect(attachment).toEqual({
      storageUrl: 'https://res.cloudinary.com/tt/image/upload/v1/a.jpg',
      cloudinaryPublicId: 'tribetails/tribal_intel/pending/a',
      fileType: 'IMAGE',
      mimeType: 'image/jpeg',
      fileName: 'gate.jpg',
    });
  });

  it('uploadTribalIntelAttachment lets an upload failure propagate, never a half-built attachment', async () => {
    requestSignedUpload.mockRejectedValueOnce(new Error('Upload signing failed (HTTP 403)'));
    const file = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
    await expect(uploadTribalIntelAttachment(file)).rejects.toThrow('Upload signing failed (HTTP 403)');
    expect(writeMediaFileDoc).not.toHaveBeenCalled();
  });
});
