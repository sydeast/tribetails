import { useId, useState } from 'react';
import {
  entryLaunchers,
  entryTitle,
  entryWhen,
  entryMachineWhen,
  type InboxEntry,
} from '../lib/inboxChannels';
import { externalSendBlocker, externalSendErrorText } from '../lib/externalSend';
import { sendExternalMessage } from '../api/externalSend';
import { markVoicemail } from '../api/inboxChannelsWrite';
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
 * branch) and adds the two things it lacks: a Mark read action for a voicemail
 * the operator listened to but is not replying to, and native `tel:` / `mailto:`
 * launchers, which a browser can offer and Compose handled with an intent.
 *
 * ── THE REPLY IS AN SMS, AND ONLY WHERE AN SMS CAN GO ───────────────────────
 * The composer appears only for a row carrying a phone number, which is every
 * voicemail, call and text and no email. An email row gets a `mailto:` launcher
 * instead of a dead composer, because `sendExternalMessage` on the email channel
 * needs a subject and a reply-quoting model this row does not have, and a
 * composer that always fails is worse than a launcher that always works.
 *
 * ── WHAT THE SENT-REPLY BANNER DISCLOSES, AND WHY IT HAS TO ─────────────────
 * `sendExternalMessage` records every send in `external_messages` and NOT in
 * `sms_messages` (mytribe/functions/src/admin/sendExternalMessage.ts:202), so a
 * reply sent from here does not come back as a row in the SMS channel below.
 * Left unsaid, the list would look as though the reply never happened, which is
 * the silent degradation this codebase bans. So the banner says where the reply
 * went. The alternative, mirroring outbound sends into `sms_messages`, is a
 * server change with a real privacy question attached (the audit entry redacts
 * the recipient on purpose), and it is not smuggled into this slice.
 *
 * A voicemail replied to IS stamped `replied` on its own document, so the row
 * the operator just acted on does visibly change state.
 */
export function ThreadActionsCard({ entry, onClose }: ThreadActionsCardProps) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [marking, setMarking] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sent, setSent] = useState<{ redacted: string; voicemailStamped: boolean } | null>(null);
  const [markedRead, setMarkedRead] = useState(false);

  const bodyId = useId();
  const launchers = entryLaunchers(entry);
  const canReply = entry.replyPhone !== '';
  const busy = sending || marking;

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
      setSent({ redacted: res.recipientRedacted, voicemailStamped });
      setBody('');
    } catch (err) {
      setErrorText(externalSendErrorText(err instanceof Error ? err.message : ''));
    } finally {
      setSending(false);
    }
  }

  async function handleMarkRead() {
    if (busy) return;
    setErrorText(null);
    setMarking(true);
    try {
      await markVoicemail({ voicemailId: entry.voicemailId, status: 'read' });
      setMarkedRead(true);
    } catch (err) {
      setErrorText(
        `Could not mark this voicemail read: ${err instanceof Error ? err.message : 'write failed'}`,
      );
    } finally {
      setMarking(false);
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
          <Banner tone="success" title="Reply sent">
            Sent to {sent.redacted}. It is recorded in the external message log, so it will not appear as a
            row in this channel list.
            {entry.voicemailId !== '' && sent.voicemailStamped
              ? ' This voicemail is now marked replied.'
              : ''}
          </Banner>
        )}

        {markedRead && (
          <Banner tone="success" title="Marked read">
            This voicemail is marked read. Nobody has written back to it yet.
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
              {entry.voicemailId !== '' && (
                <GhostButton
                  label={marking ? 'Marking…' : 'Mark read'}
                  onClick={() => void handleMarkRead()}
                  disabled={busy}
                />
              )}
            </div>
          </div>
        ) : (
          <p className="thread-actions__hint">
            This row carries no phone number, so there is nothing to text. Use the email launcher above to
            answer it.
          </p>
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
