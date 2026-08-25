import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { addDoc, collection } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn(() => 'mediaFilesCollRef'),
}));
vi.mock('firebase/firestore', () => ({ addDoc, collection }));

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: { currentUser: null as null | { uid: string; getIdToken: () => Promise<string> } },
}));
vi.mock('../lib/firebase', () => ({ db: {}, auth: mockAuth }));

import {
  requestSignedUpload,
  uploadToCloudinary,
  writeMediaFileDoc,
  uploadMediaFile,
  resourceKindForFile,
  cloudinaryThumbnailUrl,
  BUSINESS_ENTITY_ID,
  type CloudinarySignedUpload,
  type CloudinaryUploadResult,
} from './mediaUpload';

function signedUpload(over: Partial<CloudinarySignedUpload> = {}): CloudinarySignedUpload {
  return {
    cloudName: 'tribetails',
    apiKey: 'key123',
    timestamp: 1700000000,
    signature: 'abc123signature',
    folder: 'tribetails/kinfolk/kf1',
    allowedFormats: 'jpg,png,webp,gif',
    transformation: 'fl_force_strip',
    tags: '',
    entityType: 'KINFOLK',
    entityId: 'kf1',
    ...over,
  };
}

function cloudResult(over: Partial<CloudinaryUploadResult> = {}): CloudinaryUploadResult {
  return {
    secureUrl: 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/kinfolk/kf1/abc.jpg',
    publicId: 'tribetails/kinfolk/kf1/abc',
    resourceType: 'image',
    format: 'jpg',
    bytes: 12345,
    width: 800,
    height: 600,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  addDoc.mockReset().mockResolvedValue({ id: 'newMedia1' });
  collection.mockReset().mockReturnValue('mediaFilesCollRef');
  mockAuth.currentUser = { uid: 'admin-uid-1', getIdToken: vi.fn().mockResolvedValue('id-token-abc') };
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestSignedUpload', () => {
  it('rejects fail-loud when nobody is signed in, without ever calling fetch', async () => {
    mockAuth.currentUser = null;
    await expect(requestSignedUpload('KINFOLK', 'kf1')).rejects.toThrow(/sign in/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs the bearer token and JSON body to the same-origin sign endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, signedUpload()));
    await requestSignedUpload('KINFOLK', 'kf1');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cloudinary/sign-upload');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer id-token-abc');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toEqual({
      folder: 'tribetails/kinfolk/kf1',
      entityType: 'KINFOLK',
      entityId: 'kf1',
      // #583: the signer needs to know which incoming transformation to sign.
      resourceKind: 'image',
    });
  });
  // #583. The signer defaults an absent resourceKind to image, but a client
  // that simply never sends it would leave that default as the ONLY thing
  // standing between a photo and its coordinates. Pin that the field is on the
  // wire, and that a video upload asks for the video signature rather than an
  // image-only transformation Cloudinary would reject.
  it('#583 sends the resourceKind the caller derived from the file', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, signedUpload()));
    await requestSignedUpload('KINFOLK', 'kf1', 'video');
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).resourceKind).toBe('video');
  });
  it('#583 carries the signed transformation through to the grant', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, signedUpload()));
    const result = await requestSignedUpload('KINFOLK', 'kf1');
    expect(result.transformation).toBe('fl_force_strip');
  });
  it('#583 treats a signer that sends no transformation as "post none"', async () => {
    const { transformation: _drop, ...noStrip } = signedUpload();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, noStrip));
    const result = await requestSignedUpload('KINFOLK', 'kf1');
    expect(result.transformation).toBe('');
  });
  // #593. A video cannot be stripped inside the upload, so the signer tags it
  // as pending instead and the strip happens afterwards. Same contract as the
  // transformation: carried through the grant, posted verbatim.
  it('#593 carries the signed pending-strip tag through to the grant', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, signedUpload({ transformation: '', tags: 'needs-gps-strip' })),
    );
    const result = await requestSignedUpload('KINFOLK', 'kf1', 'video');
    expect(result.tags).toBe('needs-gps-strip');
  });
  it('#593 treats a signer that sends no tags as "post none"', async () => {
    const { tags: _drop, ...noTags } = signedUpload();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, noTags));
    const result = await requestSignedUpload('KINFOLK', 'kf1');
    expect(result.tags).toBe('');
  });

  it('returns the parsed grant, preferring the SERVER folder over the request guess', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, signedUpload({ folder: 'tribetails/kinfolk/kf1' })));
    const result = await requestSignedUpload('KINFOLK', 'kf1');
    expect(result.folder).toBe('tribetails/kinfolk/kf1');
    expect(result.cloudName).toBe('tribetails');
    expect(result.signature).toBe('abc123signature');
  });

  /**
   * Mark 3 of the 2026-08-17 walk: "cannot upload media", and the walk's own
   * capture of the reply, 401 {"error":"invalid_bearer_token"}. The signer is
   * one of only two endpoints verified with `checkRevoked`, so it refuses a
   * cached token the rest of the app is still using happily.
   */
  it('refreshes the token and retries once when the signer refuses the cached one', async () => {
    const getIdToken = vi.fn(async (force?: boolean) => (force === true ? 'fresh-token' : 'id-token-abc'));
    mockAuth.currentUser = { uid: 'admin-uid-1', getIdToken };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_bearer_token' }))
      .mockResolvedValueOnce(jsonResponse(200, signedUpload()));
    const result = await requestSignedUpload('KINFOLK', 'kf1');
    expect(result.signature).toBe('abc123signature');
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, retry] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });
  it('tells the operator what to do when a FRESH token is refused too', async () => {
    mockAuth.currentUser = {
      uid: 'admin-uid-1',
      getIdToken: vi.fn(async () => 'any-token'),
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: 'invalid_bearer_token' }));
    // Not "HTTP 401: invalid_bearer_token", which is what sent this to the
    // walk as "cannot upload media" with no idea why.
    await expect(requestSignedUpload('KINFOLK', 'kf1')).rejects.toThrow(/sign out and back in/i);
  });
  it('fails loud on a non-200, naming the status and server message', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { error: 'permission-denied' }));
    await expect(requestSignedUpload('KINFOLK', 'kf1')).rejects.toThrow(/403.*permission-denied/i);
  });

  it('fails loud on a response missing required fields, never silently signs with blanks', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { cloudName: 'tribetails' }));
    await expect(requestSignedUpload('KINFOLK', 'kf1')).rejects.toThrow(/incomplete/i);
  });
});

describe('uploadToCloudinary', () => {
  function file(): File {
    return new File(['fake-bytes'], 'photo.jpg', { type: 'image/jpeg' });
  }

  it('posts multipart form fields matching the proven JVM/wasm client set exactly (no allowed_formats)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/image/upload/v1/abc.jpg',
        public_id: 'tribetails/kinfolk/kf1/abc',
        resource_type: 'image',
        format: 'jpg',
        bytes: 999,
      }),
    );

    await uploadToCloudinary(file(), signedUpload());

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/tribetails/auto/upload');
    expect(opts.method).toBe('POST');
    const form = opts.body as FormData;
    expect(form.get('api_key')).toBe('key123');
    expect(form.get('timestamp')).toBe('1700000000');
    expect(form.get('signature')).toBe('abc123signature');
    expect(form.get('folder')).toBe('tribetails/kinfolk/kf1');
    expect(form.get('allowed_formats')).toBeNull();
    expect((form.get('file') as File).name).toBe('photo.jpg');
  });
  // #583. The strip only happens if this field actually reaches Cloudinary:
  // the server signed it, so a client that keeps it out of the form does not
  // "skip the strip", it gets an Invalid Signature. Both halves are pinned.
  it('#583 posts the signed transformation so the STORED ORIGINAL is stripped', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/image/upload/v1/abc.jpg',
        public_id: 'tribetails/kinfolk/kf1/abc',
        resource_type: 'image',
        format: 'jpg',
        bytes: 999,
      }),
    );
    await uploadToCloudinary(file(), signedUpload({ transformation: 'fl_force_strip' }));
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.body as FormData).get('transformation')).toBe('fl_force_strip');
  });
  it('#583 posts NO transformation field when the signer signed none (video/raw)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/video/upload/v1/clip.mp4',
        public_id: 'tribetails/kinfolk/kf1/clip',
        resource_type: 'video',
        format: 'mp4',
        bytes: 999,
      }),
    );
    await uploadToCloudinary(file(), signedUpload({ transformation: '' }));
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.body as FormData).get('transformation')).toBeNull();
  });
  // #593. Same both-halves discipline as the transformation above: the tag is
  // in the signature, so a client that keeps it out of the form does not
  // "skip the tagging", it gets an Invalid Signature and uploads nothing.
  it('#593 posts the signed pending-strip tag on a video upload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/video/upload/v1/clip.mp4',
        public_id: 'tribetails/kinfolk/kf1/clip',
        resource_type: 'video',
        format: 'mp4',
        bytes: 999,
      }),
    );
    await uploadToCloudinary(file(), signedUpload({ transformation: '', tags: 'needs-gps-strip' }));
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.body as FormData).get('tags')).toBe('needs-gps-strip');
  });
  it('#593 posts NO tags field when the signer signed none (image/raw)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/image/upload/v1/abc.jpg',
        public_id: 'tribetails/kinfolk/kf1/abc',
        resource_type: 'image',
        format: 'jpg',
        bytes: 999,
      }),
    );
    await uploadToCloudinary(file(), signedUpload({ tags: '' }));
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.body as FormData).get('tags')).toBeNull();
  });

  it('resolves the shape the writer needs, including video duration when present', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        secure_url: 'https://res.cloudinary.com/tribetails/video/upload/v1/clip.mp4',
        public_id: 'tribetails/kinfolk/kf1/clip',
        resource_type: 'video',
        format: 'mp4',
        bytes: 500000,
        width: 1920,
        height: 1080,
        duration: 12.5,
      }),
    );
    const result = await uploadToCloudinary(file(), signedUpload());
    expect(result).toEqual({
      secureUrl: 'https://res.cloudinary.com/tribetails/video/upload/v1/clip.mp4',
      publicId: 'tribetails/kinfolk/kf1/clip',
      resourceType: 'video',
      format: 'mp4',
      bytes: 500000,
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });
  });

  it('fails loud with Cloudinary\'s own error message on a non-200', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid Signature' } }));
    await expect(uploadToCloudinary(file(), signedUpload())).rejects.toThrow('Invalid Signature');
  });

  it('fails loud when Cloudinary reports success but no secure_url, never a silent blank URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { public_id: 'x' }));
    await expect(uploadToCloudinary(file(), signedUpload())).rejects.toThrow(/secure_url/i);
  });
});

describe('cloudinaryThumbnailUrl', () => {
  it('builds an image transform with no video params', () => {
    expect(cloudinaryThumbnailUrl('tribetails', 'tribetails/kinfolk/kf1/abc', false)).toBe(
      'https://res.cloudinary.com/tribetails/image/upload/w_300,h_300,c_fill,q_auto,f_auto/tribetails/kinfolk/kf1/abc',
    );
  });

  it('builds a video still-frame transform with a .jpg extension', () => {
    expect(cloudinaryThumbnailUrl('tribetails', 'tribetails/kinfolk/kf1/clip', true)).toBe(
      'https://res.cloudinary.com/tribetails/video/upload/w_300,h_300,c_fill,q_auto,f_auto,so_2.0/tribetails/kinfolk/kf1/clip.jpg',
    );
  });
});

describe('writeMediaFileDoc', () => {
  it('stamps kinfolkId from entityId ONLY for a KINFOLK target', async () => {
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.kinfolkId).toBe('kf1');
    expect(payload.entityId).toBe('kf1');
    expect(payload.entityType).toBe('KINFOLK');
  });

  it('omits kinfolkId entirely for a KIN target: absent, never blank (the equality-on-empty-string Firestore trap, HANDOFF_2026-07-25)', async () => {
    await writeMediaFileDoc({
      entityId: 'pet1',
      entityType: 'KIN',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('kinfolkId' in payload).toBe(false);
  });

  it('omits kinfolkId entirely for a BUSINESS target too (Company / no household, operator ruling 2026-07-31)', async () => {
    await writeMediaFileDoc({
      entityId: BUSINESS_ENTITY_ID,
      entityType: 'BUSINESS',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('kinfolkId' in payload).toBe(false);
  });

  it('classifies fileType from Cloudinary\'s resource_type, never from the file extension', async () => {
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'clip.mov',
      cloud: cloudResult({ resourceType: 'video', durationSeconds: 9.2 }),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.fileType).toBe('VIDEO');
    expect(payload.durationSeconds).toBe(9.2);
    expect((payload.thumbnailUrl as string)).toContain('/video/upload/');
  });

  it('stamps description/isProfilePhoto/durationSeconds even when the dialog never collected them, so the Gallery grid never throws on read', async () => {
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.description).toBe('');
    expect(payload.isProfilePhoto).toBe(false);
    expect(payload.durationSeconds).toBe(0);
  });

  // #593. The async strip job addresses the Cloudinary asset by public id.
  // Android and the desktop uploader have always stamped it; the web path did
  // not, which left a web-uploaded video addressable only by parsing the URL.
  it('#593 stamps cloudinaryPublicId, so the strip job never has to parse a URL', async () => {
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'clip.mp4',
      cloud: cloudResult({ resourceType: 'video', publicId: 'tribetails/kinfolk/kf1/clip' }),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.cloudinaryPublicId).toBe('tribetails/kinfolk/kf1/clip');
  });
  it('#593 queues a VIDEO for the asynchronous location strip', async () => {
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'clip.mp4',
      cloud: cloudResult({ resourceType: 'video' }),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.gpsStripStatus).toBe('PENDING');
    expect(payload.gpsStripAttempts).toBe(0);
  });
  it('#593 leaves an IMAGE with no strip state: absent, never blank', async () => {
    // A photo is stripped before Cloudinary stores it (#583), so it is not
    // pending anything. Writing "" instead of omitting the key is the same
    // equality-on-empty-string trap kinfolkId documents above, and it would
    // also park every photo in the retry sweep's queue as a false positive.
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('gpsStripStatus' in payload).toBe(false);
    expect('gpsStripAttempts' in payload).toBe(false);
  });
  it('stamps the real signed-in uid, falling back to "auntie" only when signed out', async () => {
    mockAuth.currentUser = null;
    await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    const [, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.uploadedBy).toBe('auntie');
  });

  it('uses a client ISO uploadedAt, never serverTimestamp(), matching every other writer on this collection', async () => {
    const id = await writeMediaFileDoc({
      entityId: 'kf1',
      entityType: 'KINFOLK',
      originalFileName: 'photo.jpg',
      cloud: cloudResult(),
      cloudName: 'tribetails',
    });
    expect(id).toBe('newMedia1');
    const [collRef, payload] = addDoc.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(collRef).toBe('mediaFilesCollRef');
    expect(typeof payload.uploadedAt).toBe('string');
    expect(Number.isNaN(Date.parse(payload.uploadedAt as string))).toBe(false);
  });
});

describe('uploadMediaFile (orchestrator)', () => {
  function file(): File {
    return new File(['bytes'], 'logo.png', { type: 'image/png' });
  }

  it('rejects a blank entityId fail-loud before ever touching the network', async () => {
    await expect(
      uploadMediaFile({ file: file(), entityType: 'BUSINESS', entityId: '  ' }),
    ).rejects.toThrow(/entityId/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs sign -> upload -> write in order, reporting each stage exactly once', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, signedUpload({ entityType: 'BUSINESS', entityId: BUSINESS_ENTITY_ID })))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          secure_url: 'https://res.cloudinary.com/tribetails/image/upload/v1/logo.png',
          public_id: 'tribetails/business/business_settings/logo',
          resource_type: 'image',
          format: 'png',
          bytes: 4000,
        }),
      );

    const stages: string[] = [];
    const id = await uploadMediaFile({
      file: file(),
      entityType: 'BUSINESS',
      entityId: BUSINESS_ENTITY_ID,
      onStage: (s) => stages.push(s),
    });

    expect(stages).toEqual(['signing', 'uploading', 'saving']);
    expect(id).toBe('newMedia1');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(addDoc).toHaveBeenCalledTimes(1);
  });

  it('stops before the Cloudinary call when signing fails, never writing a media_files doc for a failed sign', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: 'cloudinary_signing_not_configured' }));
    await expect(
      uploadMediaFile({ file: file(), entityType: 'KINFOLK', entityId: 'kf1' }),
    ).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('stops before the media_files write when the Cloudinary upload fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, signedUpload()))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'Invalid Signature' } }));
    await expect(
      uploadMediaFile({ file: file(), entityType: 'KINFOLK', entityId: 'kf1' }),
    ).rejects.toThrow('Invalid Signature');
    expect(addDoc).not.toHaveBeenCalled();
  });
});
// ---------------------------------------------------------------------------
// #583: the resource kind is read off the FILE, never chosen by a caller
// ---------------------------------------------------------------------------
// The signer strips only when the client says "image". If a caller could pass
// that in by hand, a mislabelled photo would keep its coordinates, so the one
// thing worth pinning is that the file's own MIME type decides.
describe('resourceKindForFile (#583)', () => {
  it('reports image for every image MIME type, including HEIC from a phone', () => {
    expect(resourceKindForFile({ type: 'image/jpeg' })).toBe('image');
    expect(resourceKindForFile({ type: 'image/png' })).toBe('image');
    expect(resourceKindForFile({ type: 'image/heic' })).toBe('image');
    expect(resourceKindForFile({ type: 'IMAGE/JPEG' })).toBe('image');
  });
  it('reports video for video MIME types, so no image-only flag is signed for them', () => {
    expect(resourceKindForFile({ type: 'video/mp4' })).toBe('video');
    expect(resourceKindForFile({ type: 'video/quicktime' })).toBe('video');
  });
  it('reports raw for anything else, including a blank type', () => {
    expect(resourceKindForFile({ type: 'application/pdf' })).toBe('raw');
    expect(resourceKindForFile({ type: '' })).toBe('raw');
  });
});
describe('uploadMediaFile: the kind it signs comes from the file (#583)', () => {
  function bodyOf(callIndex: number): Record<string, unknown> {
    const [, opts] = vi.mocked(fetch).mock.calls[callIndex] as [string, RequestInit];
    return JSON.parse(opts.body as string);
  }
  function cloudinaryOk(resourceType: string): Response {
    return jsonResponse(200, {
      secure_url: `https://res.cloudinary.com/tribetails/${resourceType}/upload/v1/a`,
      public_id: 'tribetails/kinfolk/kf1/a',
      resource_type: resourceType,
      format: resourceType === 'video' ? 'mp4' : 'jpg',
      bytes: 10,
    });
  }
  it('asks for the image signature — and posts the strip — for a photo', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, signedUpload({ transformation: 'fl_force_strip' })))
      .mockResolvedValueOnce(cloudinaryOk('image'));
    await uploadMediaFile({
      file: new File(['b'], 'beach.jpg', { type: 'image/jpeg' }),
      entityType: 'KINFOLK',
      entityId: 'kf1',
    });
    expect(bodyOf(0).resourceKind).toBe('image');
    const [, upload] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect((upload.body as FormData).get('transformation')).toBe('fl_force_strip');
  });
  it('asks for the video signature for a video, and posts no transformation', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, signedUpload({ transformation: '' })))
      .mockResolvedValueOnce(cloudinaryOk('video'));
    await uploadMediaFile({
      file: new File(['b'], 'clip.mp4', { type: 'video/mp4' }),
      entityType: 'KINFOLK',
      entityId: 'kf1',
    });
    expect(bodyOf(0).resourceKind).toBe('video');
    const [, upload] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect((upload.body as FormData).get('transformation')).toBeNull();
  });
});
