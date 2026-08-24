import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

const { updateDoc, doc } = vi.hoisted(() => ({
  updateDoc: vi.fn(),
  doc: vi.fn((_db: unknown, ...segs: string[]) => ({ path: segs.join('/') })),
}));
vi.mock('firebase/firestore', () => ({ updateDoc, doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import {
  deleteMediaFile,
  setMediaProfilePhoto,
  updateMediaCaption,
  mediaWriteErrorMessage,
  MAX_CAPTION_LENGTH,
} from './mediaWrite';

beforeEach(() => {
  call.mockReset();
  updateDoc.mockReset().mockResolvedValue(undefined);
});
/** The payload of the Nth updateDoc call, failing loudly rather than reading `undefined[1]`. */
function updatePayload(n = 0): Record<string, unknown> {
  const args = updateDoc.mock.calls[n];
  if (args === undefined) throw new Error(`updateDoc was not called ${n + 1} time(s)`);
  return args[1] as Record<string, unknown>;
}

describe('deleteMediaFile', () => {
  it('calls the deleteMediaFile callable with the id alone when no scope is given', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1', clearedProfilePhoto: false });
    await deleteMediaFile('m1');
    expect(call).toHaveBeenCalledWith('deleteMediaFile', { mediaFileId: 'm1' });
  });

  it('sends the scope cross-check when the caller has one', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', entityType: 'KIN', entityId: 'pet1', clearedProfilePhoto: true });
    await deleteMediaFile('m1', 'pet1');
    expect(call).toHaveBeenCalledWith('deleteMediaFile', { mediaFileId: 'm1', entityId: 'pet1' });
  });

  it('OMITS a blank entityId rather than sending one the server would reject', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', entityType: '', entityId: '', clearedProfilePhoto: false });
    await deleteMediaFile('m1', '   ');
    expect(call).toHaveBeenCalledWith('deleteMediaFile', { mediaFileId: 'm1' });
  });

  it('refuses a blank mediaFileId before any round trip', async () => {
    await expect(deleteMediaFile('  ')).rejects.toThrow(/non-blank mediaFileId/);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a server refusal instead of resolving as if the row went', async () => {
    call.mockRejectedValue(new Error("Media file 'm1' belongs to a different entity"));
    await expect(deleteMediaFile('m1', 'fam1')).rejects.toThrow(/different entity/);
  });

  it('reports whether the profile photo was cleared, which only the server knows', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1', clearedProfilePhoto: true });
    const res = await deleteMediaFile('m1', 'fam1');
    expect(res.clearedProfilePhoto).toBe(true);
  });
});

describe('setMediaProfilePhoto', () => {
  it('sends the entity STRAIGHT THROUGH, uppercasing nothing: the server compares against the stored value', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', entityId: 'fam1', photoUrl: 'https://cdn/full.jpg' });
    await setMediaProfilePhoto('m1', 'kinfolk', 'fam1');
    expect(call).toHaveBeenCalledWith('setMediaProfilePhoto', {
      mediaFileId: 'm1',
      entityType: 'kinfolk',
      entityId: 'fam1',
    });
  });

  it('refuses a row with no entity, rather than guessing one the server would reject', async () => {
    await expect(setMediaProfilePhoto('m1', '', 'fam1')).rejects.toThrow(/not attached to a household or kin/);
    await expect(setMediaProfilePhoto('m1', 'KIN', '  ')).rejects.toThrow(/not attached to a household or kin/);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates the server refusal for a cross-entity flip', async () => {
    call.mockRejectedValue(new Error("Media file 'm1' belongs to a different entity"));
    await expect(setMediaProfilePhoto('m1', 'KINFOLK', 'fam1')).rejects.toThrow(/different entity/);
  });
});

describe('updateMediaCaption', () => {
  it('writes EXACTLY ONE KEY on the media doc, and never touches taggedKinIds', async () => {
    await updateMediaCaption('m1', 'Rufus at the park');
    expect(doc).toHaveBeenCalledWith({}, 'media_files', 'm1');
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const payload = updatePayload();
    expect(Object.keys(payload)).toEqual(['description']);
    expect(payload.description).toBe('Rufus at the park');
  });

  it('trims the caption, so trailing whitespace never becomes stored content', async () => {
    await updateMediaCaption('m1', '   Rufus   ');
    expect(updatePayload().description).toBe('Rufus');
  });

  it('treats an empty caption as a real value that CLEARS the description', async () => {
    await updateMediaCaption('m1', '');
    expect(updatePayload().description).toBe('');
  });

  it('refuses a caption past the cap before writing anything', async () => {
    await expect(updateMediaCaption('m1', 'x'.repeat(MAX_CAPTION_LENGTH + 1))).rejects.toThrow(
      new RegExp(String(MAX_CAPTION_LENGTH)),
    );
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('refuses a blank mediaFileId, which would otherwise address the collection itself', async () => {
    await expect(updateMediaCaption('   ', 'hi')).rejects.toThrow(/non-blank mediaFileId/);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('propagates a rules refusal rather than resolving silently', async () => {
    updateDoc.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    await expect(updateMediaCaption('m1', 'nope')).rejects.toThrow(/insufficient permissions/);
  });
});

describe('mediaWriteErrorMessage', () => {
  it("shows the server's own sentence verbatim", () => {
    expect(mediaWriteErrorMessage(new Error("Media file 'm1' not found."), 'Deleting this file')).toBe(
      "Media file 'm1' not found.",
    );
  });

  it('names the action for a non-Error throw, never rendering an empty string', () => {
    expect(mediaWriteErrorMessage('boom', 'Deleting this file')).toMatch(/^Deleting this file failed/);
    expect(mediaWriteErrorMessage(new Error('   '), 'Saving the caption')).toMatch(/^Saving the caption failed/);
  });
});
