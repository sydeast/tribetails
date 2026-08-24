import { useId, useState } from 'react';
import {
  entryLaunchers,
  entryTitle,
  entryWhen,
  entryMachineWhen,
  type InboxEntry,
} from '../lib/inboxChannels';
import { externalSendBlocker, externalSendErrorText } from '../lib/externalSend';
import { sendExternalMessage, type MirrorSkippedReason } from '../api/externalSend';
import { markVoicemail, type VoicemailReplyWrite } from '../api/inboxChannelsWrite';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './ThreadActionsCard.css';

const BODY_MAX = 5000;

export interface ThreadActionsCardProps {
  entry: InboxEntry;
  onClose: () => void;
}

/**
 * What an operator can DO about one channel row: phone them back, text them,
 * email them, play the voicemail, or write a reply here and now.
 *
 * Ports the Android modal (`ui/inbox/InboxScreen.kt`, the `selectedEntry`
 * branch), plus the native `tel:` / `mailto:` launchers a browser can offer and
 * Compose handled with an intent.
 *
 * ── THREE ENDINGS FOR A VOICEMAIL, NOT ONE ─────────────────────────────────
 * Reply, Mark read and Dismiss are the three honest ways a voicemail stops
 * being work. Reply writes `replied` as a side effect of the text going out.
 * Mark read says somebody listened. Dismiss says this one never needed an
 * answer — a robocall, a misdial, ten seconds of somebody's pocket. All three
 * exist because the alternative for the third case was marking a robocall
 * "read", which quietly turns that word into "seen and ignored" for every other
 * row too.
 *
 * ── THE REPLY IS AN SMS, AND ONLY WHERE AN SMS CAN GO ───────────────────────
 * The composer appears only for a row carrying a phone number, which is every
 * voicemail, call and text and no email. An email row gets a `mailto:` launcher
 * instead of a dead composer, because `sendExternalMessage` on the email channel
 * needs a subject and a reply-quoting model this row does not have, and a
 * composer that always fails is worse than a launcher that always works.
 *
 * ── WHAT THE SENT-REPLY BANNER DISCLOSES, AND WHY IT HAS TO ─────────────────
 * A reply is sent with `mirrorToChannel: true`, which asks the server to also
 * write an outbound row into `sms_messages` so the thread below reads as a
 * conversation instead of one-sided.
 *
 * ASKING IS NOT THE SAME AS GETTING, and the banner has to carry that
 * difference. The server refuses to mirror unless the number is ALREADY a
 * counterpart in that collection, because an `sms_messages` row holds the number
 * in the clear while everything else this callable writes holds it redacted (the
 * reasoning is in mytribe/functions/src/lib/smsChannelMirror.ts). So a reply to a
 * number that has never texted in is sent and NOT mirrored, and so is one whose
 * mirror write failed after the text really went out.
 *
 * The banner therefore reports what the server actually did, off
 * `mirrorSkippedReason`, instead of asserting the happy path. Claiming a row
 * that is not in the list is the same silent degradation as the old copy
 * claiming a reply could never be listed.
 *
 * A voicemail replied to IS stamped `replied` on its own document, so the row
 * the operator just acted on does visibly change state.
 */
/**
 * The one sentence in the success banner that says where the reply actually
 * went. Exported so it is tested directly: every branch here is a claim about
 * whether a row exists in the list the operator is looking at, and the wrong
 * sentence sends somebody hunting for a row that was never written.
 *
 * The send itself succeeded in ALL of these cases. None of this text may read as
 * a failed reply, because an operator who believes a reply failed sends it again.
 */
export function mirrorDisclosure(mirrored: boolean, reason: MirrorSkippedReason | null): string {
  if (mirrored) return 'It is listed below as your reply.';
  switch (reason) {
    case 'no_existing_thread':
      return 'This number has not texted in before, so the reply is kept in the external message log and is not added to this channel list.';
    case 'write_failed':
      return 'The text went out, but it could not be added to this channel list, so the thread below still reads as one-sided.';
    default:
      return 'It is recorded in the external message log, so it will not appear as a row in this channel list.';
  }
}

export function ThreadActionsCard({ entry, onClose }: ThreadActionsCardProps) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  /** Which state write is in flight, so the two buttons report separately. */
  const [marking, setMarking] = useState<Exclude<VoicemailReplyWrite, 'replied'> | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    redacted: string;
    voicemailStamped: boolean;
    mirrored: boolean;
    mirrorSkippedReason: MirrorSkippedReason | null;
  } | null>(null);
  /**
   * The state this card last WROTE, or null. One field for both actions rather
   * than a boolean each, because they are mutually exclusive outcomes of the
   * same document and two booleans could go true together and confirm two
   * contradictory things at once.
   */
  const [marked, setMarked] = useState<Exclude<VoicemailReplyWrite, 'replied'> | null>(null);

  const bodyId = useId();
  const launchers = entryLaunchers(entry);
  const canReply = entry.replyPhone !== '';
  const busy = sending || marking !== null;
  const isVoicemail = entry.voicemailId !== '';
  /**
   * Neither action is offered once a voicemail is `replied` (issue #581).
   * Before this gate, a stray Mark read or Dismiss tap on an already-answered
   * voicemail silently rewrote `replyStatus` back to `read`/`dismissed` and
   * blanked `repliedAt`/`replyLogId` - the only record of who answered and
   * when - with no confirmation and no way back. The Firestore rule on
   * `voicemails/{id}` now refuses that write outright regardless of this
   * gate (so Android and desktop, which write the same three keys through
   * the same rule, are covered too), but the button should not invite a tap
   * that is going to fail: hiding it here is the honest UI for a write the
   * data layer will not allow.
   */
  const canMarkRead = isVoicemail && entry.statusHint !== 'replied';
  /**
   * Dismiss is additionally offered only while the voicemail is not ALREADY
   * dismissed, the way Android gates Mark read on `statusHint == "unread"`:
   * pressing it again would write the state it is already in, and a control
   * whose only effect is a redundant network round-trip is the dead control
   * `components/Buttons.tsx` exists to make inexpressible. The live listener
   * re-renders this card with the new `statusHint`, so the button disappears
   * once the write lands.
   */
  const canDismiss =
    isVoicemail && entry.statusHint !== 'dismissed' && entry.statusHint !== 'replied' && marked !== 'dismissed';

  async function handleSend() {
    if (busy) return;
    setErrorText(null);
    setSent(null);
    const blocker = externalSendBlocker('sms', entry.replyPhone, '', body);
    if (blocker !== null) {
      setErrorText(blocker);
      return;
    }
    setSending(true);
    try {
      const res = await sendExternalMessage({
        channel: 'sms',
        to: entry.replyPhone,
        body,
        transactional: true,
        // Ask for the outbound row. The server decides whether it is allowed;
        // the banner below reports what it actually did.
        mirrorToChannel: true,
      });
      // The send SUCCEEDED. A failure to stamp the voicemail afterwards must not
      // be reported as a failed reply, or the operator sends it twice. It is
      // disclosed as its own warning instead, the same split
      // `communicateApprove.ts` makes between its gate write and its audit entry.
      let voicemailStamped = true;
      if (entry.voicemailId !== '') {
        try {
          await markVoicemail({
            voicemailId: entry.voicemailId,
            status: 'replied',
            replyLogId: res.providerMessageId,
          });
        } catch (err) {
          voicemailStamped = false;
          setErrorText(
            `The reply was sent, but this voicemail could not be marked replied: ${
              err instanceof Error ? err.message : 'write failed'
            }`,
          );
        }
      }
      setSent({
        redacted: res.recipientRedacted,
        voicemailStamped,
        mirrored: res.mirrored,
        mirrorSkippedReason: res.mirrorSkippedReason,
      });
      setBody('');
    } catch (err) {
      setErrorText(externalSendErrorText(err instanceof Error ? err.message : ''));
    } finally {
      setSending(false);
    }
  }

  /**
   * Both no-reply outcomes go through here: the operator listened (`read`), or
   * the voicemail wants nothing from anyone (`dismissed`).
   *
   * The confirmation is set only AFTER the write resolves. Nothing is shown
   * optimistically, because the only thing this card could optimistically show
   * is a sentence claiming the record changed, and Firestore is where that
   * claim is either true or not. The list row behind the sheet, and the sheet's
   * own gating, both restyle off the live `voicemails` listener the moment the
   * write lands, so there is no lag worth lying to cover.
   */
  async function handleMark(status: Exclude<VoicemailReplyWrite, 'replied'>) {
    if (busy) return;
    setErrorText(null);
    setMarking(status);
    try {
      await markVoicemail({ voicemailId: entry.voicemailId, status });
      setMarked(status);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'write failed';
      setErrorText(
        status === 'read'
          ? `Could not mark this voicemail read: ${reason}`
          : `Could not dismiss this voicemail: ${reason}`,
      );
    } finally {
      setMarking(null);
    }
  }

  return (
    <Dialog title={entryTitle(entry)} onClose={onClose} variant="sheet">
      <div className="thread-actions">
        <p className="thread-actions__meta">
          <span className="thread-actions__channel">{CHANNEL_NOUN[entry.channel]}</span>
          {entry.counterpart !== '' && <span className="thread-actions__contact">{entry.counterpart}</span>}
          <time className="thread-actions__when" dateTime={entryMachineWhen(entry.timestamp)}>
            {entryWhen(entry.timestamp)}
          </time>
        </p>

        {entry.preview !== '' && <p className="thread-actions__preview">{entry.preview}</p>}

        {/* The audio element is rendered only for a row that really has a URL.
            A player with no source is a control that cannot work. */}
        {entry.playbackUrl !== '' && (
          <div className="thread-actions__player">
            <p className="thread-actions__player-label">Recording</p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
              className="thread-actions__audio"
              controls
              preload="none"
              src={entry.playbackUrl}
              aria-label={`Play the recording from ${entryTitle(entry)}`}
            />
          </div>
        )}

        <div className="thread-actions__launchers">
          {launchers.tel !== null && (
            <a className="thread-actions__launcher" href={launchers.tel}>
              Call back
            </a>
          )}
          {launchers.sms !== null && (
            <a className="thread-actions__launcher" href={launchers.sms}>
              Text from this device
            </a>
          )}
          {launchers.mailto !== null && (
            <a className="thread-actions__launcher" href={launchers.mailto}>
              Email back
            </a>
          )}
        </div>

        {errorText !== null && (
          <Banner tone="error" title="Something did not go through">
            {errorText}
          </Banner>
        )}

        {sent !== null && (
          <Banner tone={sent.mirrored ? 'success' : 'warning'} title="Reply sent">
            Sent to {sent.redacted}. {mirrorDisclosure(sent.mirrored, sent.mirrorSkippedReason)}
            {entry.voicemailId !== '' && sent.voicemailStamped
              ? ' This voicemail is now marked replied.'
              : ''}
          </Banner>
        )}

        {marked === 'read' && (
          <Banner tone="success" title="Marked read">
            This voicemail is marked read. Nobody has written back to it yet.
          </Banner>
        )}

        {marked === 'dismissed' && (
          <Banner tone="success" title="Dismissed">
            This voicemail is marked dismissed. It stays in the list and no longer counts as waiting on a
            reply.
          </Banner>
        )}

        {canReply ? (
          <div className="thread-actions__reply">
            <label className="thread-actions__field" htmlFor={bodyId}>
              <span className="thread-actions__field-label">Reply by text</span>
              <textarea
                id={bodyId}
                className="thread-actions__textarea"
                value={body}
                disabled={busy}
                maxLength={BODY_MAX}
                rows={4}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the text you want to send back."
              />
            </label>
            <div className="thread-actions__actions">
              <PrimaryButton label="Send text" onClick={() => void handleSend()} busy={sending} disabled={busy} />
            </div>
          </div>
        ) : (
          <p className="thread-actions__hint">
            This row carries no phone number, so there is nothing to text. Use the email launcher above to
            answer it.
          </p>
        )}

        {/* Outside the composer, not inside it. A voicemail from a withheld or
            unparseable number has no `replyPhone`, so it falls into the hint
            branch above — and that is exactly the voicemail an operator most
            wants to close out, since there is nobody to text back. Nesting
            these two under `canReply` put the only way off `unread` behind
            having somewhere to reply to. */}
        {isVoicemail && (
          <div className="thread-actions__actions">
            {canMarkRead && (
              <GhostButton
                label={marking === 'read' ? 'Marking…' : 'Mark read'}
                onClick={() => void handleMark('read')}
                disabled={busy}
              />
            )}
            {canDismiss && (
              <GhostButton
                label={marking === 'dismissed' ? 'Dismissing…' : 'Dismiss'}
                onClick={() => void handleMark('dismissed')}
                disabled={busy}
              />
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The noun each channel is called in the row header. */
const CHANNEL_NOUN: Record<InboxEntry['channel'], string> = {
  voicemail: 'Voicemail',
  call: 'Call',
  sms: 'Text',
  email: 'Email',
};
