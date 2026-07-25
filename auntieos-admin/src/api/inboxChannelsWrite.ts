import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The only write this screen makes: a voicemail's reply state.
 *
 * ── WHY NO CALLABLE, STATED RATHER THAN ASSUMED ─────────────────────────────
 * `mytribe/firestore.rules:745` is `match /voicemails/{id} { allow read, write:
 * if isAuntie(); }`, and Android has written this exact field through that grant
 * since launch (`AuntieRepository.markVoicemailReplied`). This is the
 * rules-backed direct write the plan's Firestore-rules constraint carves out,
 * the same shape as `tags` and `kintale_templates`, so no callable is missing
 * and none is built. Adding one for this field alone would leave the two
 * clients writing the same three keys through two different paths with two
 * different validation stories, which is a worse outcome than the one it fixes.
 *
 * What is NOT in this module, deliberately: the inbound voicemail/call/SMS rows
 * themselves. WARNING-8 in `mytribe/functions/src/twilio/twilioInbound.ts`
 * records that client-authored comms records are forgeable, and the three
 * signature-verified webhooks exist to take that write server-side. Nothing
 * here creates a channel row; it only annotates one the server wrote.
 *
 * ── `updateDoc`, NOT `setDoc` ───────────────────────────────────────────────
 * A voicemail document carries the transcript, the audio URL, the Twilio SIDs
 * and the python reconcile pipeline's provenance fields (`reconcileStatus` and
 * friends, read by `reconcile_comms.py`). A merge-less overwrite would destroy
 * all of it to record that somebody pressed Mark read. `updateDoc` also FAILS
 * on a document that does not exist, which is the behaviour we want: a voicemail
 * deleted underneath the operator should error loudly, not be resurrected as a
 * three-field husk.
 */

const VOICEMAILS_COLLECTION = 'voicemails';

/** The states this client may set. `unread` is the server's initial value and
 *  `dismissed` has no UI, so neither is offered here. */
export type VoicemailReplyWrite = 'read' | 'replied';

export interface MarkVoicemailArgs {
  voicemailId: string;
  status: VoicemailReplyWrite;
  /**
   * The provider message id of the SMS sent in response, when there was one.
   * `voicemails.replyLogId` is documented in `Models.kt` as pointing at the log
   * row created in response, so a blank is written when the operator only marks
   * it read, rather than inventing a link that does not exist.
   */
  replyLogId?: string | null;
}

export class MarkVoicemailError extends Error {}

/**
 * Stamp a voicemail's reply state. Writes the SAME three keys Android writes,
 * with the same ISO-string `repliedAt`, so a voicemail marked on one client
 * reads identically on the other.
 *
 * `repliedAt` is stamped only for `replied`. Marking a voicemail read is not a
 * reply, and putting a reply timestamp on it would make the field a lie for
 * every row the operator merely listened to.
 */
export async function markVoicemail(args: MarkVoicemailArgs): Promise<void> {
  const id = args.voicemailId.trim();
  if (id === '') {
    throw new MarkVoicemailError('This voicemail has no id, so its state cannot be saved.');
  }
  const replyLogId = (args.replyLogId ?? '').trim();
  await updateDoc(doc(db, VOICEMAILS_COLLECTION, id), {
    replyStatus: args.status,
    repliedAt: args.status === 'replied' ? new Date().toISOString() : '',
    replyLogId,
  });
}
