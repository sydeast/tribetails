import { useId, useState } from 'react';
import {
  sendBroadcast,
  describeAudience,
  channelCountsOf,
  type BroadcastCriteria,
  type BroadcastChannel,
  type SendBroadcastResult,
} from '../api/communicateWrite';
import { channelLabel } from '../lib/communicateFormat';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import './CommunicateCompose.css';

const BODY_MAX = 5000;
const SUBJECT_MAX = 200;

type AudienceKind = BroadcastCriteria['kind'];

/** Splits a comma-separated field into trimmed, non-blank entries. Pure. */
export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builds the `criteria` this screen will send, or `null` when the current
 * audience picker state doesn't yet describe a valid one (e.g. "By status"
 * chosen with no statuses typed). `null` is the honest "not ready", never a
 * fabricated `{ kind: 'all' }` fallback that would silently broaden the send.
 */
export function buildCriteria(kind: AudienceKind, statusesRaw: string, tagsRaw: string, tagMatch: 'any' | 'all'): BroadcastCriteria | null {
  if (kind === 'all') return { kind: 'all' };
  if (kind === 'status') {
    const statuses = splitList(statusesRaw);
    return statuses.length > 0 ? { kind: 'status', statuses } : null;
  }
  const tags = splitList(tagsRaw);
  return tags.length > 0 ? { kind: 'tags', tags, tagMatch } : null;
}

interface CommunicateComposeProps {
  /** Back to the Recent list. Wired by Communicate.tsx's "New broadcast" toggle. */
  onClose: () => void;
}

/**
 * Communicate COMPOSE / BROADCAST: the send surface `Communicate.tsx` ("Recent")
 * deliberately left out (see that file's module doc). Sends one admin-authored
 * message to an audience of kinfolk over email and/or sms via the `broadcastMessage`
 * callable (see `api/communicateWrite.ts` for the confirmed payload, the channel
 * scope, and why no live pre-send recipient count is shown).
 *
 * Three steps, same shape as `FormSchemas.tsx`'s delete flow (fail-loud, disabled-
 * while-busy, a confirm before the consequential action):
 *   1. Fill the form (audience, channels, subject, body). Client-side validation
 *      mirrors the backend's zod `Args` exactly (broadcastMessage.ts lines 56-79)
 *      so a doomed request never reaches the network.
 *   2. "Review broadcast" opens a confirm Dialog naming the audience, channels,
 *      and message, since sending to real kinfolk is not undoable.
 *   3. "Send now" calls `sendBroadcast`, busy + disabled throughout. A failure
 *      surfaces inline, named, with the form left exactly as typed (no data
 *      loss on a failed send). A success replaces the form with the REAL
 *      per-channel result the callable returned, then offers "Send another".
 */
export function CommunicateCompose({ onClose }: CommunicateComposeProps) {
  const [audienceKind, setAudienceKind] = useState<AudienceKind>('all');
  const [statusesRaw, setStatusesRaw] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [tagMatch, setTagMatch] = useState<'any' | 'all'>('any');
  const [emailOn, setEmailOn] = useState(true);
  const [smsOn, setSmsOn] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SendBroadcastResult | null>(null);

  const legendId = useId();

  const criteria = buildCriteria(audienceKind, statusesRaw, tagsRaw, tagMatch);
  const channels: BroadcastChannel[] = [...(emailOn ? (['email'] as const) : []), ...(smsOn ? (['sms'] as const) : [])];
  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();

  // Mirrors broadcastMessage's zod Args exactly (superRefine, lines 64-79):
  // a segmentId or criteria (this screen always supplies criteria), at least
  // one channel, subject required when email is selected, body required.
  const subjectRequired = channels.includes('email');
  const formErrors: string[] = [];
  if (!criteria) formErrors.push('Pick an audience (or fill in the status/tags you chose).');
  if (channels.length === 0) formErrors.push('Pick at least one channel.');
  if (subjectRequired && trimmedSubject.length === 0) formErrors.push('Subject is required for email.');
  if (trimmedBody.length === 0) formErrors.push('Message body is required.');
  if (trimmedBody.length > BODY_MAX) formErrors.push(`Message body must be ${BODY_MAX} characters or fewer.`);
  const formValid = formErrors.length === 0 && criteria !== null;

  function openConfirm() {
    if (!formValid || sending) return;
    setResult(null);
    setSendError(null);
    setConfirmOpen(true);
  }

  async function confirmSend() {
    if (!formValid || !criteria || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await sendBroadcast({
        criteria,
        channels,
        ...(subjectRequired || trimmedSubject.length > 0 ? { subject: trimmedSubject } : {}),
        body: trimmedBody,
      });
      setResult(res);
      setConfirmOpen(false);
    } catch (err) {
      setSendError(`sendBroadcast failed: ${friendlySendError(err)}`);
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  }

  function sendAnother() {
    setResult(null);
    setSendError(null);
    setSubject('');
    setBody('');
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Communicate"
        title="New"
        accentTail="broadcast"
        subtitle="Send one message to an audience of kinfolk over email and text."
        trailing={<GhostButton label="Back to Recent" onClick={onClose} />}
      />

      {result ? (
        <BroadcastResultPanel result={result} channels={channels} onSendAnother={sendAnother} />
      ) : (
        <DenPanel title="Compose" subtitle="Every field below is validated the same way the send itself will be.">
          <div className="compose__form">
            {sendError !== null && (
              <Banner tone="error" title="Broadcast failed">
                {sendError}
              </Banner>
            )}

            <fieldset className="compose__fieldset" aria-labelledby={`${legendId}-audience`}>
              <legend id={`${legendId}-audience`} className="compose__legend">
                Audience
              </legend>
              <div className="compose__radio-row" role="radiogroup" aria-labelledby={`${legendId}-audience`}>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'all'}
                    disabled={sending}
                    onChange={() => setAudienceKind('all')}
                  />
                  All active kinfolk
                </label>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'status'}
                    disabled={sending}
                    onChange={() => setAudienceKind('status')}
                  />
                  By status
                </label>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'tags'}
                    disabled={sending}
                    onChange={() => setAudienceKind('tags')}
                  />
                  By tag
                </label>
              </div>

              {audienceKind === 'status' && (
                <label className="compose__field">
                  <span className="compose__field-label">Statuses (comma-separated)</span>
                  <input
                    type="text"
                    className="compose__text-input"
                    value={statusesRaw}
                    disabled={sending}
                    onChange={(e) => setStatusesRaw(e.target.value)}
                    placeholder="active, prospect"
                  />
                </label>
              )}

              {audienceKind === 'tags' && (
                <>
                  <label className="compose__field">
                    <span className="compose__field-label">Tags (comma-separated)</span>
                    <input
                      type="text"
                      className="compose__text-input"
                      value={tagsRaw}
                      disabled={sending}
                      onChange={(e) => setTagsRaw(e.target.value)}
                      placeholder="vip, newsletter"
                    />
                  </label>
                  <div className="compose__radio-row" role="radiogroup" aria-label="Tag match mode">
                    <label className="compose__radio">
                      <input
                        type="radio"
                        name="tagMatch"
                        checked={tagMatch === 'any'}
                        disabled={sending}
                        onChange={() => setTagMatch('any')}
                      />
                      Any of these tags
                    </label>
                    <label className="compose__radio">
                      <input
                        type="radio"
                        name="tagMatch"
                        checked={tagMatch === 'all'}
                        disabled={sending}
                        onChange={() => setTagMatch('all')}
                      />
                      All of these tags
                    </label>
                  </div>
                </>
              )}
            </fieldset>

            <fieldset className="compose__fieldset" aria-labelledby={`${legendId}-channels`}>
              <legend id={`${legendId}-channels`} className="compose__legend">
                Channels
              </legend>
              <ul className="compose__toggle-list">
                <li className="compose__toggle-row">
                  <span className="compose__toggle-caption">Email</span>
                  <Toggle checked={emailOn} onChange={setEmailOn} disabled={sending} label="Send by email" />
                </li>
                <li className="compose__toggle-row">
                  <span className="compose__toggle-caption">Text (SMS)</span>
                  <Toggle checked={smsOn} onChange={setSmsOn} disabled={sending} label="Send by text (SMS)" />
                </li>
              </ul>
            </fieldset>

            <label className="compose__field">
              <span className="compose__field-label">
                Subject{subjectRequired ? ' (required for email)' : ' (optional)'}
              </span>
              <input
                type="text"
                className="compose__text-input"
                value={subject}
                disabled={sending}
                maxLength={SUBJECT_MAX}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What's this about?"
              />
            </label>

            <label className="compose__field">
              <span className="compose__field-label">Message</span>
              <textarea
                className="compose__textarea"
                value={body}
                disabled={sending}
                maxLength={BODY_MAX}
                rows={8}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the message every recipient on this audience will see."
              />
              <span className="compose__char-count">
                {body.length} / {BODY_MAX}
              </span>
            </label>

            <div className="compose__actions">
              <PrimaryButton label="Review broadcast" onClick={openConfirm} disabled={!formValid || sending} />
            </div>
          </div>
        </DenPanel>
      )}

      {confirmOpen && criteria && (
        <Dialog
          title="Send this broadcast?"
          onClose={() => {
            if (!sending) setConfirmOpen(false);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setConfirmOpen(false)} disabled={sending} />
              <PrimaryButton
                label={sending ? 'Sending…' : 'Send now'}
                onClick={() => void confirmSend()}
                disabled={sending}
                busy={sending}
              />
            </>
          }
        >
          <p className="compose__confirm-line">
            <strong>Audience:</strong> {describeAudience(criteria)}
          </p>
          <p className="compose__confirm-line">
            <strong>Channels:</strong> {channels.map((c) => channelLabel(c)).join(', ')}
          </p>
          {trimmedSubject.length > 0 && (
            <p className="compose__confirm-line">
              <strong>Subject:</strong> {trimmedSubject}
            </p>
          )}
          <p className="compose__confirm-line">
            <strong>Message:</strong> {trimmedBody}
          </p>
          <p className="compose__confirm-note">
            This goes out to every kinfolk this audience matches, right now. The exact number reached is
            reported below once the send completes; it isn&rsquo;t known until then.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/** Maps a callable rejection to a readable message, naming the two documented backend failure codes honestly. */
function friendlySendError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Send failed';
  if (message.includes('no_recipients')) return 'No kinfolk match this audience. Nothing was sent.';
  if (message.includes('broadcast_all_failed')) {
    return 'Every attempted send failed. Nothing went out, check the email/SMS provider configuration.';
  }
  return message;
}

interface BroadcastResultPanelProps {
  result: SendBroadcastResult;
  channels: BroadcastChannel[];
  onSendAnother: () => void;
}

/**
 * The post-send result: the REAL `recipientCount` and per-channel
 * sent/skipped/failed tallies the callable returned, ported from the wasm
 * `broadcastSummary()` ("Reached N kinfolk...") but broken out per-channel
 * since this screen, unlike the reference, lets more than one channel fire
 * in the same send.
 *
 * No "Back to Recent" button here: the header's trailing button (rendered by
 * `CommunicateCompose` above, always present) already covers that, so this
 * panel doesn't grow a second, identically-labelled button next to it.
 */
function BroadcastResultPanel({ result, channels, onSendAnother }: BroadcastResultPanelProps) {
  return (
    <DenPanel title="Broadcast sent" subtitle={`Reached ${result.recipientCount} kinfolk.`}>
      <ul className="compose__result-list">
        {channels.map((ch) => {
          const counts = channelCountsOf(result.perChannel, ch);
          return (
            <li key={ch} className="compose__result-row">
              <span className="compose__result-channel">{channelLabel(ch)}</span>
              <span className="compose__result-counts">
                {counts.sent} sent · {counts.skipped} skipped · {counts.failed} failed
              </span>
            </li>
          );
        })}
      </ul>
      <div className="compose__actions">
        <PrimaryButton label="Send another" onClick={onSendAnother} />
      </div>
    </DenPanel>
  );
}
