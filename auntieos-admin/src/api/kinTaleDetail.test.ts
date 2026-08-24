import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  getKinTaleComments,
  addKinTaleComment,
  getKinTaleReaction,
  toggleKinTaleLove,
  getMyKinTaleMedia,
  createShareLink,
  type KinTaleComment,
} from './kinTaleDetail';

beforeEach(() => call.mockReset());

describe('getKinTaleComments', () => {
  it('passes only taleId (kinfolkId is derived server-side, RULING O-6) and unwraps the { comments } envelope', async () => {
    const comments: KinTaleComment[] = [
      {
        id: 'c1',
        authorRole: 'kinfolk',
        authorUid: 'kf-uid',
        guestName: null,
        body: 'Thank you!',
        parentCommentId: null,
        createdAtMs: 1_752_600_000_000,
      },
    ];
    call.mockResolvedValue({ comments });
    const result = await getKinTaleComments('tale1');
    expect(call).toHaveBeenCalledWith('getKinTaleComments', { taleId: 'tale1' });
    expect(result).toEqual(comments);
  });

  it('defaults to [] when the callable returns no comments field', async () => {
    call.mockResolvedValue({});
    expect(await getKinTaleComments('tale1')).toEqual([]);
  });

  it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('not-found'));
    await expect(getKinTaleComments('ghost')).rejects.toThrow('not-found');
  });
});

describe('addKinTaleComment', () => {
  it('sends taleId + body, omitting parentCommentId when not given', async () => {
    call.mockResolvedValue({ commentId: 'c2' });
    const result = await addKinTaleComment({ taleId: 'tale1', body: 'A lovely visit.' });
    expect(call).toHaveBeenCalledWith('addKinTaleComment', { taleId: 'tale1', body: 'A lovely visit.' });
    expect(result).toBe('c2');
  });

  it('includes parentCommentId only when given', async () => {
    call.mockResolvedValue({ commentId: 'c3' });
    await addKinTaleComment({ taleId: 'tale1', body: 'Replying', parentCommentId: 'c2' });
    expect(call).toHaveBeenCalledWith('addKinTaleComment', {
      taleId: 'tale1',
      body: 'Replying',
      parentCommentId: 'c2',
    });
  });

  it('propagates a rejected call (e.g. whitespace-only body), fail loud', async () => {
    call.mockRejectedValueOnce(new Error('body cannot be whitespace-only'));
    await expect(addKinTaleComment({ taleId: 'tale1', body: '   ' })).rejects.toThrow(
      'body cannot be whitespace-only',
    );
  });
});

describe('getKinTaleReaction / toggleKinTaleLove', () => {
  it('getKinTaleReaction passes only taleId and returns the reaction shape as-is', async () => {
    call.mockResolvedValue({ loved: false, loveCount: 2 });
    const result = await getKinTaleReaction('tale1');
    expect(call).toHaveBeenCalledWith('getKinTaleReaction', { taleId: 'tale1' });
    expect(result).toEqual({ loved: false, loveCount: 2 });
  });

  it('toggleKinTaleLove returns the authoritative post-toggle state', async () => {
    call.mockResolvedValue({ loved: true, loveCount: 3 });
    const result = await toggleKinTaleLove('tale1');
    expect(call).toHaveBeenCalledWith('toggleKinTaleLove', { taleId: 'tale1' });
    expect(result).toEqual({ loved: true, loveCount: 3 });
  });

  it('propagates a rejected toggle rather than guessing the new state, fail loud', async () => {
    call.mockRejectedValueOnce(new Error('unavailable'));
    await expect(toggleKinTaleLove('tale1')).rejects.toThrow('unavailable');
  });
});

describe('getMyKinTaleMedia', () => {
  it('sends both taleId AND kinfolkId (required, see file header) and unwraps { media }', async () => {
    const media = [{ id: 'm1', url: 'https://cdn/img.jpg', contentType: 'image/jpeg' }];
    call.mockResolvedValue({ taleId: 'tale1', media });
    const result = await getMyKinTaleMedia('tale1', 'kf1');
    expect(call).toHaveBeenCalledWith('getMyKinTaleMedia', { taleId: 'tale1', kinfolkId: 'kf1' });
    expect(result).toEqual(media);
  });

  it('defaults to [] when the callable returns no media field', async () => {
    call.mockResolvedValue({ taleId: 'tale1' });
    expect(await getMyKinTaleMedia('tale1', 'kf1')).toEqual([]);
  });

  it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('failed-precondition'));
    await expect(getMyKinTaleMedia('tale1', 'kf1')).rejects.toThrow('failed-precondition');
  });
});

describe('createShareLink', () => {
  it('sends the tale id as kinTaleId and the household as familyId (the server compares the two)', async () => {
    call.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    const result = await createShareLink('tale1', 'kf1');
    expect(call).toHaveBeenCalledWith('createShareLink', {
      familyId: 'kf1',
      kinTaleId: 'tale1',
      includePhotos: true,
    });
    expect(result).toEqual({ shareId: 's1', shareUrl: 'https://share.example/s1' });
  });

  it('carries includePhotos through when the caller opts out', async () => {
    call.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    await createShareLink('tale1', 'kf1', false);
    expect(call).toHaveBeenCalledWith('createShareLink', {
      familyId: 'kf1',
      kinTaleId: 'tale1',
      includePhotos: false,
    });
  });

  it('sends no expiresInDays or passcode: the server owns the default TTL, and this surface has no passcode field', async () => {
    call.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    await createShareLink('tale1', 'kf1');
    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['familyId', 'includePhotos', 'kinTaleId']);
  });

  it('propagates a rejected call rather than fabricating a url (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('not-found'));
    await expect(createShareLink('tale1', 'kf1')).rejects.toThrow('not-found');
  });
});
