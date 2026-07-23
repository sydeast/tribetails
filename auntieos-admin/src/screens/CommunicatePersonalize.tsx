import { useId, useState } from 'react';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { KINFOLK_QUERY, kinfolkDisplayName, kinfolkSurnameSortKey, type Kinfolk } from '../api/directory';
import {
  generateDraft,
  sendPersonalizedMessage,
  draftOpening,
  type GenerateDraftArgs,
  type GenerateDraftResult,
  type PersonalizeChannel,
  type SendPersonalizedArgs,
  type SendPersonalizedResult,
} from '../api/communicateGenerate';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import './CommunicatePersonalize.css';

const NOTES_MAX = 2000;
const TONE_MAX = 200;
const LENGTH_MAX = 60;

interface CommunicatePersonalizeProps {
  /** Back to the Recent list. Wired by Communicate.tsx's "Personalize a message" toggle. */
  onClose: () => void;
}

/**
 * Communicate PERSONALIZE: the 1:1 AI-drafted note flow `Communicate.tsx`'s
 * module doc names as "not-yet-built" (see that file, and
 * `api/communicateGenerate.ts`'s header doc for the confirmed `generate` /
 * `sendMessage` backend contract this screen calls).
 *
 * Four steps, fail-loud and disabled-while-busy throughout, same shape as
 * `CommunicateCompose.tsx`'s broadcast flow:
 *   1. Pick a recipient (a live `kinfolk` listener) and a channel (email or
 *      text, gated to whichever contact method that kinfolk actually has on
 *      file), then describe what happened.
 *   2. "Generate draft" calls `generateDraft`; the result is an EDITABLE
 *      textarea, never a read-only preview, since the whole point of review
 *      is to let the operator fix it before it goes out.
 *   3. "Regenerate" re-calls with `avoid_opening` set to the current draft's
 *      opening line, so the model does not repeat an opener the operator
 *      rejected by asking again.
 *   4. "Review & send" opens a confirm Dialog naming the recipient, the
 *      channel, and the exact message body, since this goes to a real
 *      kinfolk and is not undoable. A success replaces the form with the
 *      real send result, then offers "Send another".
 */
export function CommunicatePersonalize({ onClose }: CommunicatePersonalizeProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);

  const [selectedId, setSelectedId] = useState('');
  const [channel, setChannel] = useState<PersonalizeChannel>('email');
  const [rawNotes, setRawNotes] = useState('');
  const [toneHint, setToneHint] = useState('');
  const [maxLength, setMaxLength] = useState('');
  // Email subject. sendExternalMessage rejects a blank subject on the email
  // channel, and an email with no subject line is bad on its own terms. Seeded
  // from the generated title (see want_title in handleGenerate) unless the
  // operator has typed their own.
  const [subject, setSubject] = useState('');
  const [subjectTouched, setSubjectTouched] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenerateDraftResult | null>(null);
  const [draftText, setDraftText] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<SendPersonalizedResult | null>(null);

  const legendId = useId();
  const recipientSelectId = useId();

  const busy = generating || sending;

  function selectedKinfolkOf(rows: Kinfolk[]): Kinfolk | undefined {
    return rows.find((kf) => kf._id === selectedId);
  }

  function pickRecipient(id: string, rows: Kinfolk[]) {
    setSelectedId(id);
    setDraft(null);
    setDraftText('');
    setGenerateError(null);
    setSendResult(null);
    setSendError(null);
    const kf = rows.find((r) => r._id === id);
    if (!kf) return;
    // Prefer email when the kinfolk has one on file; fall back to sms when
    // only a phone number is present. Neither present is left as 'email' so
    // the "no contact method" banner below has something concrete to name.
    if (str(kf.email).trim() !== '') setChannel('email');
    else if (str(kf.phoneNumber).trim() !== '') setChannel('sms');
  }

  async function handleGenerate(kf: Kinfolk, regenerate: boolean) {
    setGenerating(true);
    setGenerateError(null);
    const args: GenerateDraftArgs = {
      communication_type: channel,
      recipient: kinfolkDisplayName(kf),
      raw_notes: rawNotes.trim(),
      ...(toneHint.trim() !== '' ? { tone_hint: toneHint.trim() } : {}),
      ...(maxLength.trim() !== '' ? { max_length: maxLength.trim() } : {}),
      ...(regenerate && draftText.trim() !== '' ? { avoid_opening: draftOpening(draftText) } : {}),
      // Only email has somewhere to put a title (the subject line), which is the
      // condition want_title's own doc sets for paying for the extra model call.
      ...(channel === 'email' ? { want_title: true } : {}),
    };
    try {
      const result = await generateDraft(args);
      setDraft(result);
      setDraftText(result.generated_copy);
      // Never overwrite a subject the operator typed. Same rule the KinTale
      // composer uses for its Ask Auntie headline.
      if (channel === 'email' && !subjectTouched && result.generated_title.trim() !== '') {
        setSubject(result.generated_title.trim());
      }
      setSendResult(null);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Generate failed');
    } finally {
      setGenerating(false);
    }
  }

  /** Email needs a subject; sms does not have one. */
  const subjectMissing = channel === 'email' && subject.trim() === '';

  function openConfirm() {
    if (busy || draftText.trim() === '') return;
    if (subjectMissing) {
      // Reveal the inline error rather than opening a confirm the send would
      // only reject server-side.
      setSubjectTouched(true);
      return;
    }
    setSendError(null);
    setConfirmOpen(true);
  }

  async function confirmSend(kf: Kinfolk) {
    if (busy) return;
    setSending(true);
    setSendError(null);
    try {
      const args: SendPersonalizedArgs = {
        channel,
        message_body: draftText.trim(),
        kinfolk_id: kf._id,
        ...(channel === 'email'
          ? { recipient_email: str(kf.email), subject: subject.trim() }
          : { recipient_phone: str(kf.phoneNumber) }),
      };
      const result = await sendPersonalizedMessage(args);
      setSendResult(result);
      setConfirmOpen(false);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed');
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  }

  function sendAnother() {
    setSelectedId('');
    setChannel('email');
    setRawNotes('');
    setToneHint('');
    setMaxLength('');
    setDraft(null);
    setDraftText('');
    setGenerateError(null);
    setSendResult(null);
    setSendError(null);
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Communicate"
        title="Personalize"
        accentTail="a message"
        subtitle="Draft a one-to-one note in Auntie's voice for a single kinfolk, then review and send it."
        trailing={<GhostButton label="Back to Recent" onClick={onClose} />}
      />

      {sendResult ? (
        <SendResultPanel
          channel={channel}
          providerId={sendResult.providerId}
          onSendAnother={sendAnother}
        />
      ) : (
        <AsyncRegion
          state={kinfolkState}
          what="kinfolk"
          isEmpty={(rows) => rows.length === 0}
          empty={<Banner tone="warning">No kinfolk on file yet. Add one in Directory before personalizing a message.</Banner>}
        >
          {(rows) => {
            const sorted = [...rows].sort((a, b) => {
              const ak = kinfolkSurnameSortKey(a);
              const bk = kinfolkSurnameSortKey(b);
              return ak < bk ? -1 : ak > bk ? 1 : 0;
            });
            const kf = selectedKinfolkOf(sorted);
            const hasEmail = kf !== undefined && str(kf.email).trim() !== '';
            const hasPhone = kf !== undefined && str(kf.phoneNumber).trim() !== '';
            const noContactMethod = kf !== undefined && !hasEmail && !hasPhone;
            const channelUsable = kf !== undefined && (channel === 'email' ? hasEmail : hasPhone);
            const recipientName = kf ? kinfolkDisplayName(kf) : '';
            const formValid = kf !== undefined && rawNotes.trim() !== '' && channelUsable;

            return (
              <>
                <DenPanel title="Recipient" subtitle="Who this message is for, and how to reach them.">
                  <div className="personalize__form">
                    <label className="personalize__field" htmlFor={recipientSelectId}>
                      <span className="personalize__field-label">Recipient</span>
                      <select
                        id={recipientSelectId}
                        className="personalize__select"
                        value={selectedId}
                        disabled={busy}
                        onChange={(e) => pickRecipient(e.target.value, sorted)}
                      >
                        <option value="">Choose a kinfolk…</option>
                        {sorted.map((row) => (
                          <option key={row._id} value={row._id}>
                            {kinfolkDisplayName(row)}
                          </option>
                        ))}
                      </select>
                    </label>

                    {kf && (
                      <fieldset className="personalize__fieldset" aria-labelledby={`${legendId}-channel`}>
                        <legend id={`${legendId}-channel`} className="personalize__legend">
                          Channel
                        </legend>
                        <div className="personalize__radio-row" role="radiogroup" aria-labelledby={`${legendId}-channel`}>
                          <label className="personalize__radio">
                            <input
                              type="radio"
                              name="personalizeChannel"
                              checked={channel === 'email'}
                              disabled={!hasEmail || busy}
                              onChange={() => setChannel('email')}
                            />
                            Email{hasEmail ? ` (${kf.email})` : ' (none on file)'}
                          </label>
                          <label className="personalize__radio">
                            <input
                              type="radio"
                              name="personalizeChannel"
                              checked={channel === 'sms'}
                              disabled={!hasPhone || busy}
                              onChange={() => setChannel('sms')}
                            />
                            Text{hasPhone ? ` (${kf.phoneNumber})` : ' (none on file)'}
                          </label>
                        </div>
                      </fieldset>
                    )}

                    {noContactMethod && (
                      <Banner tone="warning" title="No contact method on file">
                        {recipientName} has no email or phone number on file. Add one in Directory before sending.
                      </Banner>
                    )}
                  </div>
                </DenPanel>

                <DenPanel title="What's this about" subtitle="A few notes; Auntie turns them into the message.">
                  <div className="personalize__form">
                    <label className="personalize__field">
                      <span className="personalize__field-label">Notes</span>
                      <textarea
                        className="personalize__textarea"
                        value={rawNotes}
                        disabled={busy}
                        maxLength={NOTES_MAX}
                        rows={5}
                        onChange={(e) => setRawNotes(e.target.value)}
                        placeholder="What happened, or what you want this message to say."
                      />
                      <span className="personalize__char-count">
                        {rawNotes.length} / {NOTES_MAX}
                      </span>
                    </label>

                    <label className="personalize__field">
                      <span className="personalize__field-label">Tone (optional)</span>
                      <input
                        type="text"
                        className="personalize__text-input"
                        value={toneHint}
                        disabled={busy}
                        maxLength={TONE_MAX}
                        onChange={(e) => setToneHint(e.target.value)}
                        placeholder="e.g. reassuring, celebratory"
                      />
                    </label>

                    <label className="personalize__field">
                      <span className="personalize__field-label">Length (optional)</span>
                      <input
                        type="text"
                        className="personalize__text-input"
                        value={maxLength}
                        disabled={busy}
                        maxLength={LENGTH_MAX}
                        onChange={(e) => setMaxLength(e.target.value)}
                        placeholder="e.g. short, 2-3 sentences"
                      />
                    </label>

                    {generateError !== null && (
                      <Banner tone="error" title="Generate failed">
                        {generateError}
                      </Banner>
                    )}

                    {/* Once a draft exists, the ONLY generate control is the Draft
                        panel's own "Regenerate" button below: two buttons both
                        reading "Regenerate" on screen at once would be a genuine
                        ambiguity, not just a test-query annoyance. Editing notes/
                        tone/length here still feeds that same regenerate call. */}
                    {!draft && (
                      <div className="personalize__actions">
                        <PrimaryButton
                          label="Generate draft"
                          busy={generating}
                          disabled={!formValid || generating}
                          onClick={() => {
                            if (kf) void handleGenerate(kf, false);
                          }}
                        />
                      </div>
                    )}
                  </div>
                </DenPanel>

                {draft && kf && (
                  <DenPanel
                    title="Draft"
                    subtitle={draft.model ? `Generated by ${draft.model}. Edit freely before sending.` : 'Edit freely before sending.'}
                  >
                    <div className="personalize__form">
                      {draft.draftWriteFailed && (
                        <Banner tone="warning" title="Draft not saved">
                          {draft.warnings.length > 0
                            ? draft.warnings.join(' ')
                            : 'This draft was generated but not saved. Copy the text below before navigating away.'}
                        </Banner>
                      )}

                      {channel === 'email' && (
                        <label className="personalize__field">
                          <span className="personalize__field-label">Subject</span>
                          <input
                            className="personalize__text-input"
                            type="text"
                            value={subject}
                            disabled={busy}
                            maxLength={500}
                            onChange={(e) => {
                              setSubject(e.target.value);
                              setSubjectTouched(true);
                            }}
                            onBlur={() => setSubjectTouched(true)}
                          />
                          {subjectTouched && subjectMissing && (
                            <span className="personalize__field-error" role="alert">
                              A subject is required for an email.
                            </span>
                          )}
                        </label>
                      )}

                      <label className="personalize__field">
                        <span className="personalize__field-label">Message</span>
                        <textarea
                          className="personalize__textarea personalize__textarea--draft"
                          value={draftText}
                          disabled={busy}
                          rows={8}
                          onChange={(e) => setDraftText(e.target.value)}
                        />
                      </label>

                      {sendError !== null && (
                        <Banner tone="error" title="Send failed">
                          {sendError}
                        </Banner>
                      )}

                      <div className="personalize__actions">
                        <GhostButton
                          label="Regenerate"
                          disabled={!formValid || generating || sending}
                          onClick={() => void handleGenerate(kf, true)}
                        />
                        <PrimaryButton
                          label="Review & send"
                          disabled={draftText.trim() === '' || busy}
                          onClick={openConfirm}
                        />
                      </div>
                    </div>
                  </DenPanel>
                )}

                {confirmOpen && kf && (
                  <Dialog
                    title="Send this message?"
                    onClose={() => {
                      if (!sending) setConfirmOpen(false);
                    }}
                    footer={
                      <>
                        <GhostButton label="Cancel" onClick={() => setConfirmOpen(false)} disabled={sending} />
                        <PrimaryButton
                          label={sending ? 'Sending…' : 'Send now'}
                          onClick={() => void confirmSend(kf)}
                          disabled={sending}
                          busy={sending}
                        />
                      </>
                    }
                  >
                    <p className="personalize__confirm-line">
                      <strong>To:</strong> {recipientName} ({channel === 'email' ? kf.email : kf.phoneNumber})
                    </p>
                    <p className="personalize__confirm-line">
                      <strong>Channel:</strong> {channel === 'email' ? 'Email' : 'Text (SMS)'}
                    </p>
                    {channel === 'email' && (
                      <p className="personalize__confirm-line">
                        <strong>Subject:</strong> {subject.trim()}
                      </p>
                    )}
                    <p className="personalize__confirm-line">
                      <strong>Message:</strong> {draftText}
                    </p>
                    <p className="personalize__confirm-note">
                      This sends to {recipientName} right now. It is not undoable.
                    </p>
                  </Dialog>
                )}
              </>
            );
          }}
        </AsyncRegion>
      )}
    </div>
  );
}

interface SendResultPanelProps {
  channel: PersonalizeChannel;
  providerId: string | null;
  onSendAnother: () => void;
}

function SendResultPanel({ channel, providerId, onSendAnother }: SendResultPanelProps) {
  return (
    <DenPanel
      title="Message sent"
      subtitle={`Sent by ${channel === 'email' ? 'email' : 'text'}.`}
    >
      {providerId !== null && <p className="personalize__result-line">Provider reference: {providerId}</p>}
      <div className="personalize__actions">
        <PrimaryButton label="Send another" onClick={onSendAnother} />
      </div>
    </DenPanel>
  );
}
