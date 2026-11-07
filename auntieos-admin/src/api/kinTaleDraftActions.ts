import { call } from '../lib/fns';

/**
 * #1563: send or delete a `generated_drafts` KinTale, through the two server
 * callables in `mytribe/functions/src/admin/kinTaleDrafts.ts`. Android and the
 * desktop console call the same two, so the three admin clients send a draft
 * the same way.
 *
 * WHY A CALLABLE AND NOT A CLIENT WRITE. Sending a KinTale means writing a
 * `kin_care_reports` doc with `status: 'SENT'` (what the portal lists and what
 * `onKinTaleCreate` announces) AND marking the draft as sent, together, once.
 * The server does both in one transaction and keys a repeat on the draft's
 * `publishedReportId`, so a double click or a retry after a lost reply returns
 * the first report instead of sending the household the same tale twice.
 *
 * `draftId` is the BARE document id. The KinTales list namespaces draft rows as
 * `generated_drafts/<id>` (`lib/kinTaleList.ts`); strip that with
 * `draftIdFromListRowId` before calling. The server refuses an id with a slash.
 */

export interface PublishGeneratedDraftResult {
  ok: true;
  /** The `kin_care_reports` id the household now has. */
  reportId: string;
  /** True when this draft had already been sent and nothing new was written. */
  alreadyPublished: boolean;
}

export interface PublishGeneratedDraftArgs {
  draftId: string;
  /** The operator's final text, edits included. */
  bodyCopy: string;
  /** The headline as left on screen. Blank means the draft's own generated title. */
  title?: string;
}

export async function publishGeneratedDraft(args: PublishGeneratedDraftArgs): Promise<PublishGeneratedDraftResult> {
  const title = (args.title ?? '').trim();
  return call<PublishGeneratedDraftArgs, PublishGeneratedDraftResult>(
    'publishGeneratedDraft',
    {
      draftId: args.draftId.trim(),
      bodyCopy: args.bodyCopy,
      ...(title !== '' ? { title } : {}),
    },
    // Safe to retry: the server answers a repeat from `publishedReportId`.
    { idempotent: true },
  );
}

export async function deleteGeneratedDraft(draftId: string): Promise<void> {
  await call<{ draftId: string }, { ok: true; draftId: string }>('deleteGeneratedDraft', {
    draftId: draftId.trim(),
  });
}
