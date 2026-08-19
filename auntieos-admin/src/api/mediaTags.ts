import { call } from '../lib/fns';

/**
 * Kin tagging, the write half of `api/gallery.ts` (#447).
 *
 * THIS GOES THROUGH A CALLABLE, unlike the upload pipeline next door
 * (`api/mediaUpload.ts`, a direct `addDoc`), and the difference is deliberate:
 * `firestore.rules` refuses ANY client update that touches
 * `media_files.taggedKinIds`, so `saveMediaTags` is the only writer. That is
 * what makes the household-scoping rule (a photo attached to a household may
 * only carry that household's kin) enforceable rather than a picker convention
 * two clients each re-implement, and what binds an audit entry to every change.
 *
 * The payload is the COMPLETE list after the edit, not a delta -- the same
 * shape Android's tag dialog has always sent (`GalleryViewModel.saveTags`), so
 * the two clients speak one language. An empty array is a real, meaningful
 * value: it clears every tag.
 */

export interface SaveMediaTagsRequest {
  mediaFileId: string;
  taggedKinIds: string[];
}

export interface SaveMediaTagsResponse {
  ok: true;
  mediaFileId: string;
  /** The list AS STORED: de-duplicated server-side, so callers reflect this, not what they sent. */
  taggedKinIds: string[];
}

/** Mirrors the server's own `MAX_TAGGED_KIN`, so the dialog can refuse before a round trip. */
export const MAX_TAGGED_KIN = 50;

/**
 * Persists the tag list for one media file.
 *
 * Fail-loud: a rejected save (missing doc, unknown kin id, a kin from another
 * household, a lost connection) propagates so the dialog can show the server's
 * own sentence. It never resolves as if it worked, because a silently-dropped
 * tag looks identical to a tag that was never added.
 */
export async function saveMediaTags(
  mediaFileId: string,
  taggedKinIds: string[],
): Promise<SaveMediaTagsResponse> {
  const id = mediaFileId.trim();
  if (id === '') throw new Error('saveMediaTags requires a non-blank mediaFileId');
  return call<SaveMediaTagsRequest, SaveMediaTagsResponse>('saveMediaTags', {
    mediaFileId: id,
    taggedKinIds,
  });
}

/**
 * Turns whatever a rejected `saveMediaTags` threw into one sentence an operator
 * can act on.
 *
 * The callable SDK puts the server's own message on `.message` (the machine
 * code lives on `.code`), and `saveMediaTags` writes those messages as
 * plain-English instructions -- "No kin on file for id ghost. Refresh the
 * household roster and try again." So the right thing is to show it verbatim.
 * The fallback exists for the non-Error a transport layer can throw: naming the
 * failure beats rendering an empty string, which reads as "nothing went wrong".
 */
export function mediaTagsErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return 'Saving tags failed for an unknown reason. Try again.';
}
