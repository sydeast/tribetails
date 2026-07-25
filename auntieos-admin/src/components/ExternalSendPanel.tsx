import { useId, useState } from 'react';
import {
  EXTERNAL_CHANNELS,
  externalSendBlocker,
  externalSuppressBlocker,
  externalSendErrorText,
  type ExternalChannel,
} from '../lib/externalSend';
import { sendExternalMessage, suppressExternalRecipient } from '../api/externalSend';
import { DenPanel } from './DenScreenKit';
import { PrimaryButton, GhostButton } from './Buttons';
import { Banner } from './Banner';
import './ExternalSendPanel.css';

const BODY_MAX = 5000;
const SUBJECT_MAX = 500;
const RECIPIENT_MAX = 320;

export interface ExternalSendPanelProps {
  /**
   * False only for a genuine marketing send. The default is true because every
   * send from this panel is an operator writing to one named person, and a
   * transactional message skips the marketing suppression gate. A bulk
   * unsubscribe silently eating a personal reply is the worse failure of the
   * two, so the marketing case is the one that has to say so.
   */
  transactional?: boolean;
}

/**
 * "Send outside the tribe": a one-off email or text to somebody who is not a
 * kinfolk, plus the opt-out that blocks future sends to them.
 *
 * Ports the archive's `ExternalSendPanel` (`CommunicateScreen.kt:1546`), with
 * two corrections it needed:
 *
 *  - The archive left `transactional` at its `false` default here, which put
 *    every one-off personal reply behind the marketing consent gate. This
 *    defaults to true.
 *  - The archive ran a send failure through `externalSendErrorText` but NOT an
 *    opt-out failure, so an opt-out that hit a permissions problem printed a
 *    raw code. Both paths go through the same mapping here.
 *
 * The pre-flight in `lib/externalSend.ts` mirrors the server's validation so a
 * doomed request never leaves the browser, and the server still validates
 * everything it validated before. A blocked send renders its reason and makes
 * no network call at all.
 *
 * Nothing here ever renders the raw recipient back. The server returns a
 * REDACTED form (`d***@example.com`, `+1******7890`) precisely so the plaintext
 * contact stays out of the audit log and out of the UI, and that is what the
 * confirmation shows.
 */
export function ExternalSendPanel({ transactional = true }: ExternalSendPanelProps) {
  const [channel, setChannel] = useState<ExternalChannel>('email');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [sending, setSending] = useState(false);
  const [suppressing, setSuppressing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sentRedacted, setSentRedacted] = useState<{ redacted: string; providerId: string | null } | null>(null);
  const [suppressedRedacted, setSuppressedRedacted] = useState<string | null>(null);

  const legendId = useId();
  const recipientId = useId();
  const subjectId = useId();
  const bodyId = useId();

  const busy = sending || suppressing;

  function clearOutcomes() {
    setErrorText(null);
    setSentRedacted(null);
    setSuppressedRedacted(null);
  }

  async function handleSend() {
    if (busy) return;
    clearOutcomes();
    const blocker = externalSendBlocker(channel, to, subject, body);
    if (blocker !== null) {
      setErrorText(blocker);
      return;
    }
    setSending(true);
    try {
      // No `mirrorToChannel` here, deliberately. This panel texts people who are
      // not kinfolk, one off, and mirroring those into `sms_messages` would fill
      // the Inbox Channels list with rows for contacts the operator has no
      // ongoing thread with. The Inbox reply composer opts in; this does not.
      const res = await sendExternalMessage({ channel, to, subject, body, transactional });
      setSentRedacted({ redacted: res.recipientRedacted, providerId: res.providerMessageId });
    } catch (err) {
      setErrorText(externalSendErrorText(err instanceof Error ? err.message : ''));
    } finally {
      setSending(false);
    }
  }

  async function handleSuppress() {
    if (busy) return;
    clearOutcomes();
    const blocker = externalSuppressBlocker(channel, to);
    if (blocker !== null) {
      setErrorText(blocker);
      return;
    }
    setSuppressing(true);
    try {
      const res = await suppressExternalRecipient({ channel, to });
      setSuppressedRedacted(res.recipientRedacted);
    } catch (err) {
      setErrorText(externalSendErrorText(err instanceof Error ? err.message : ''));
    } finally {
      setSuppressing(false);
    }
  }

  return (
    <DenPanel
      title="Send outside the tribe"
      subtitle="A one-off email or text to someone who is not a kinfolk. You write it, Auntie sends it and logs it."
    >
      <div className="external-send__form">
        <fieldset className="external-send__fieldset" aria-labelledby={`${legendId}-channel`}>
          <legend id={`${legendId}-channel`} className="external-send__legend">
            Channel
          </legend>
          <div className="external-send__radio-row" role="radiogroup" aria-labelledby={`${legendId}-channel`}>
            {EXTERNAL_CHANNELS.map((c) => (
              <label key={c.key} className="external-send__radio">
                <input
                  type="radio"
                  name="externalSendChannel"
                  checked={channel === c.key}
                  disabled={busy}
                  onChange={() => {
                    setChannel(c.key);
                    clearOutcomes();
                  }}
                />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="external-send__field" htmlFor={recipientId}>
          <span className="external-send__field-label">{channel === 'email' ? 'Email address' : 'Phone number'}</span>
          <input
            id={recipientId}
            type="text"
            className="external-send__text-input"
            value={to}
            disabled={busy}
            maxLength={RECIPIENT_MAX}
            onChange={(e) => setTo(e.target.value)}
            placeholder={channel === 'email' ? 'name@example.com' : '+1 555 123 4567'}
          />
        </label>

        {channel === 'email' && (
          <label className="external-send__field" htmlFor={subjectId}>
            <span className="external-send__field-label">Subject</span>
            <input
              id={subjectId}
              type="text"
              className="external-send__text-input"
              value={subject}
              disabled={busy}
              maxLength={SUBJECT_MAX}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What is this about?"
            />
          </label>
        )}

        <label className="external-send__field" htmlFor={bodyId}>
          <span className="external-send__field-label">Message</span>
          <textarea
            id={bodyId}
            className="external-send__textarea"
            value={body}
            disabled={busy}
            maxLength={BODY_MAX}
            rows={5}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write the message you want to send."
          />
        </label>

        {errorText !== null && (
          <Banner tone="error" title="Send blocked">
            {errorText}
          </Banner>
        )}

        {sentRedacted !== null && (
          <Banner tone="info" title="Delivered to the provider">
            Sent to {sentRedacted.redacted}.
            {sentRedacted.providerId !== null ? ` Provider id ${sentRedacted.providerId}.` : ''} The full recipient is
            never stored in the audit log.
          </Banner>
        )}

        {suppressedRedacted !== null && (
          <Banner tone="success" title="Opted out">
            {suppressedRedacted} will no longer receive messages. Future sends to them are blocked at the source.
          </Banner>
        )}

        <div className="external-send__actions">
          <PrimaryButton label="Send" onClick={() => void handleSend()} busy={sending} disabled={busy} />
          <GhostButton
            label={suppressing ? 'Opting out…' : 'Opt out recipient'}
            onClick={() => void handleSuppress()}
            disabled={busy}
          />
        </div>
      </div>
    </DenPanel>
  );
}
