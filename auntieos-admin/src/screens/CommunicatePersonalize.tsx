import { useId, useState } from 'react';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  PERSONALIZE_MESSAGE_TYPES,
  PERSONALIZE_TONES,
  PERSONALIZE_LENGTHS,
  DEFAULT_MESSAGE_TYPE,
  DEFAULT_TONE,
  DEFAULT_LENGTH,
  messageTypeDef,
  filterRecipients,
  generateBlocker,
  approveBlocker,
  buildGeneratePayload,
  draftSubtitle,
  type PersonalizeFormState,
} from '../lib/personalizeCompose';
import { generateDraft, draftOpening, type GenerateDraftResult } from '../api/communicateGenerate';
import { approveGeneratedDraft, type ApproveDraftResult } from '../api/communicateApprove';
import { sendExternalMessage } from '../api/externalSend';
import { DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import './CommunicatePersonalize.css';

const NOTES_MAX = 2000;
const SUBJECT_MAX = 500;

/**
 * PERSONALIZE: the Auntie voice generator.
 *
 * This is the archived Compose app's `ComposeMode.Personalize` branch
 * (`screens/communicate/CommunicateScreen.kt`), restored as the default view of
 * Communicate. It writes brand-voice COPY through `generateAuntieCopy`. It has
 * never been text to speech.
 *
 * The form, in the archive's order: message type, recipient, subject, notes,
 * tone and length, generate, editable draft, approve.
 *
 * ── THE RECIPIENT PICKER RESOLVES AN ID ─────────────────────────────────────
 * There is deliberately no free-text recipient field. Every send names a
 * household by its real `kinfolk` doc id, which goes on the wire as
 * `kinfolk_id`. The archive picked a real Kinfolk object here too and then
 * transmitted only its display NAME, leaving the server to re-derive it with a
 * case-folded startsWith scan; two households named Dana and the wrong dossier
 * fed the model. Nothing typed can reach the generator.
 *
 * ── APPROVE ─────────────────────────────────────────────────────────────────
 * `approveGeneratedDraft` owns the ordering: the Firestore write is a gate, the
 * audit entry follows it, and the send follows that. See `api/communicateApprove.ts`
 * for why that order and no other. This screen decides only ONE thing about it,
 * whether there is a `deliver` step at all: a Text or an Email goes out through
 * `sendExternalMessage`, while a KinTale report and a Blog post are promoted and
 * recorded but sent by nothing. A deliverable approve gets a confirm dialog
 * first, because it reaches a real household and is not undoable.
 */
export function CommunicatePersonalize() {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);

  const [form, setForm] = useState<PersonalizeFormState>({
    messageType: DEFAULT_MESSAGE_TYPE,
    tone: DEFAULT_TONE,
    length: DEFAULT_LENGTH,
    subject: '',
    notes: '',
    recipientId: '',
  });
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenerateDraftResult | null>(null);
  const [draftText, setDraftText] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approved, setApproved] = useState<ApproveDraftResult | null>(null);

  const typeLegendId = useId();
  const toneLegendId = useId();
  const lengthLegendId = useId();
  const searchId = useId();
  const subjectId = useId();
  const notesId = useId();
  const draftId = useId();

  const def = messageTypeDef(form.messageType);
  const busy = generating || approving;

  function patch(next: Partial<PersonalizeFormState>) {
    setForm((f) => ({ ...f, ...next }));
  }

  /** A new draft invalidates the old one; never leave a stale approve button live. */
  function clearDraft() {
    setDraft(null);
    setDraftText('');
    setApproved(null);
    setApproveError(null);
    setFormError(null);
  }

  async function handleGenerate(kf: Kinfolk | undefined, regenerate: boolean) {
    if (busy) return;
    const blocker = generateBlocker(form);
    if (blocker !== null) {
      setFormError(blocker);
      return;
    }
    setFormError(null);
    setApproved(null);
    setApproveError(null);
    setGenerating(true);
    try {
      const result = await generateDraft(
        buildGeneratePayload(form, kf, regenerate && draftText.trim() !== '' ? draftOpening(draftText) : null),
      );
      setDraft(result);
      setDraftText(result.generated_copy);
      // Never overwrite a subject the operator typed. Same rule the KinTale
      // composer uses for its headline.
      if (def.deliverable === 'email' && !subjectTouched && result.generated_title.trim() !== '') {
        patch({ subject: result.generated_title.trim() });
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Generate failed.');
    } finally {
      setGenerating(false);
    }
  }

  async function runApprove(kf: Kinfolk | undefined) {
    if (busy) return;
    setApproving(true);
    setApproveError(null);
    try {
      // The deliver step exists only for a type that actually sends. Passing an
      // always-present callback that sometimes no-ops would make `delivered`
      // claim a send that never happened.
      const deliver =
        def.deliverable !== false && kf !== undefined
          ? async () => {
              const res = await sendExternalMessage({
                channel: def.deliverable === 'email' ? 'email' : 'sms',
                to: def.deliverable === 'email' ? str(kf.email) : str(kf.phoneNumber),
                subject: form.subject,
                body: draftText,
                transactional: true,
              });
              return res.providerMessageId;
            }
          : undefined;

      const result = await approveGeneratedDraft({
        draftId: draft?.draft_id ?? '',
        editedCopy: draftText,
        kinfolkId: draft?.kinfolk_id ?? (form.recipientId !== '' ? form.recipientId : null),
        subject: def.deliverable === 'email' ? form.subject.trim() : null,
        ...(deliver ? { deliver } : {}),
      });
      setApproved(result);
      setConfirmOpen(false);
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Approve failed.');
      setConfirmOpen(false);
    } finally {
      setApproving(false);
    }
  }

  function handleApproveClick(kf: Kinfolk | undefined) {
    if (busy) return;
    const blocker = approveBlocker(form, kf, draft?.draft_id ?? null, draftText);
    if (blocker !== null) {
      setApproveError(blocker);
      return;
    }
    setApproveError(null);
    if (def.deliverable !== false) {
      setConfirmOpen(true);
      return;
    }
    void runApprove(kf);
  }

  return (
    <AsyncRegion
      state={kinfolkState}
      what="kinfolk"
      isEmpty={(rows) => rows.length === 0}
      empty={
        <Banner tone="warning">
          No kinfolk on file yet. Add one in Directory before personalizing a message.
        </Banner>
      }
    >
      {(rows) => {
        const kf = rows.find((r) => r._id === form.recipientId);
        const matches = filterRecipients(rows, query);
        const approveLabel = def.deliverable !== false ? 'Approve and send' : 'Approve draft';

        return (
          <>
            <DenPanel
              title="Personalize"
              subtitle="A one-to-one note that uses the recipient's dossier and kin context."
            >
              <div className="personalize__form">
                <fieldset className="personalize__fieldset" aria-labelledby={typeLegendId}>
                  <legend id={typeLegendId} className="personalize__legend">
                    Message type
                  </legend>
                  <div className="personalize__chip-row" role="radiogroup" aria-labelledby={typeLegendId}>
                    {PERSONALIZE_MESSAGE_TYPES.map((t) => (
                      <label key={t.key} className="personalize__chip">
                        <input
                          type="radio"
                          name="personalizeMessageType"
                          checked={form.messageType === t.key}
                          disabled={busy}
                          onChange={() => {
                            patch({ messageType: t.key });
                            clearDraft();
                          }}
                        />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                {def.needsRecipient && (
                  <div className="personalize__field">
                    <span className="personalize__field-label">Recipient</span>
                    <div className="personalize__recipient-row">
                      <span className="personalize__recipient-name">
                        {kf ? kinfolkDisplayName(kf) : 'No recipient selected'}
                      </span>
                      <GhostButton
                        label={pickerOpen ? 'Close' : kf ? 'Change' : 'Choose'}
                        disabled={busy}
                        onClick={() => setPickerOpen((o) => !o)}
                      />
                    </div>

                    {pickerOpen && (
                      <div className="personalize__picker">
                        <label className="personalize__field" htmlFor={searchId}>
                          <span className="personalize__field-label">Search kinfolk by name or email</span>
                          <input
                            id={searchId}
                            type="search"
                            className="personalize__text-input"
                            value={query}
                            disabled={busy}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Start typing a name"
                          />
                        </label>

                        {matches.length === 0 ? (
                          <EmptyHint>No kinfolk match that search.</EmptyHint>
                        ) : (
                          <ul className="personalize__picker-list">
                            {matches.map((row) => (
                              <li key={row._id}>
                                <button
                                  type="button"
                                  className="personalize__picker-row"
                                  aria-pressed={form.recipientId === row._id}
                                  onClick={() => {
                                    patch({ recipientId: row._id });
                                    clearDraft();
                                    setPickerOpen(false);
                                    setQuery('');
                                  }}
                                >
                                  <span className="personalize__picker-name">{kinfolkDisplayName(row)}</span>
                                  <span className="personalize__picker-contact">
                                    {str(row.email) || str(row.phoneNumber) || 'no contact on file'}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <label className="personalize__field" htmlFor={subjectId}>
                  <span className="personalize__field-label">Subject</span>
                  <input
                    id={subjectId}
                    type="text"
                    className="personalize__text-input"
                    value={form.subject}
                    disabled={busy}
                    maxLength={SUBJECT_MAX}
                    onChange={(e) => {
                      patch({ subject: e.target.value });
                      setSubjectTouched(true);
                    }}
                    placeholder="What is this about?"
                  />
                </label>

                {/* The character count sits OUTSIDE the <label>. Inside it, it
                    joins the accessible name, so the field announces as "Notes
                    0 / 2000" and the name changes on every keystroke. */}
                <div className="personalize__field">
                  <label className="personalize__field-label" htmlFor={notesId}>
                    Notes
                  </label>
                  <textarea
                    id={notesId}
                    className="personalize__textarea"
                    value={form.notes}
                    disabled={busy}
                    maxLength={NOTES_MAX}
                    rows={6}
                    onChange={(e) => patch({ notes: e.target.value })}
                    placeholder="Bullets or free-form. The more honest, the warmer the draft."
                  />
                  <span className="personalize__char-count">
                    {form.notes.length} / {NOTES_MAX}
                  </span>
                </div>

                <div className="personalize__chip-columns">
                  <fieldset className="personalize__fieldset" aria-labelledby={toneLegendId}>
                    <legend id={toneLegendId} className="personalize__legend">
                      Tone
                    </legend>
                    <div className="personalize__chip-row" role="radiogroup" aria-labelledby={toneLegendId}>
                      {PERSONALIZE_TONES.map((t) => (
                        <label key={t.key} className="personalize__chip">
                          <input
                            type="radio"
                            name="personalizeTone"
                            checked={form.tone === t.key}
                            disabled={busy}
                            onChange={() => patch({ tone: t.key })}
                          />
                          {t.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="personalize__fieldset" aria-labelledby={lengthLegendId}>
                    <legend id={lengthLegendId} className="personalize__legend">
                      Length
                    </legend>
                    <div className="personalize__chip-row" role="radiogroup" aria-labelledby={lengthLegendId}>
                      {PERSONALIZE_LENGTHS.map((l) => (
                        <label key={l.key} className="personalize__chip">
                          <input
                            type="radio"
                            name="personalizeLength"
                            checked={form.length === l.key}
                            disabled={busy}
                            onChange={() => patch({ length: l.key })}
                          />
                          {l.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                {formError !== null && (
                  <Banner tone="error" title="Generate blocked">
                    {formError}
                  </Banner>
                )}

                <div className="personalize__actions">
                  <PrimaryButton
                    label={draft === null ? 'Generate draft' : 'Regenerate'}
                    busy={generating}
                    disabled={busy}
                    onClick={() => void handleGenerate(kf, draft !== null)}
                  />
                </div>
              </div>
            </DenPanel>

            {draft !== null && (
              <DenPanel title="Auntie AI draft" subtitle={draftSubtitle(draft)}>
                <div className="personalize__form">
                  {draft.draftWriteFailed && (
                    <Banner tone="warning" title="Draft not saved">
                      {draft.warnings.length > 0
                        ? draft.warnings.join(' ')
                        : 'This draft was generated but not saved, so it cannot be approved. Copy the text below before navigating away, then regenerate.'}
                    </Banner>
                  )}

                  <label className="personalize__field" htmlFor={draftId}>
                    <span className="personalize__field-label">Edit before approving</span>
                    <textarea
                      id={draftId}
                      className="personalize__textarea personalize__textarea--draft"
                      value={draftText}
                      disabled={busy}
                      rows={10}
                      onChange={(e) => setDraftText(e.target.value)}
                    />
                  </label>

                  {approveError !== null && (
                    <Banner tone="error" title="Approve blocked">
                      {approveError}
                    </Banner>
                  )}

                  {approved !== null && (
                    <Banner tone="success" title="Draft approved">
                      {approved.delivered
                        ? `Approved and sent.${approved.providerId !== null ? ` Provider id ${approved.providerId}.` : ''}`
                        : 'Approved and logged to the audit trail. Nothing was sent, this message type delivers elsewhere.'}
                      {approved.auditWarning !== null
                        ? ` The audit entry could not be written: ${approved.auditWarning}`
                        : ''}
                    </Banner>
                  )}

                  <div className="personalize__actions">
                    <PrimaryButton
                      label={approveLabel}
                      busy={approving}
                      disabled={busy}
                      onClick={() => handleApproveClick(kf)}
                    />
                  </div>
                  <p className="personalize__note">
                    Approving promotes the draft in Firestore and logs it to the audit trail. Nothing goes out until
                    that write succeeds.
                  </p>
                </div>
              </DenPanel>
            )}

            {confirmOpen && (
              <Dialog
                title="Send this message?"
                onClose={() => {
                  if (!approving) setConfirmOpen(false);
                }}
                footer={
                  <>
                    <GhostButton label="Cancel" onClick={() => setConfirmOpen(false)} disabled={approving} />
                    <PrimaryButton
                      label={approving ? 'Sending…' : 'Send now'}
                      onClick={() => void runApprove(kf)}
                      disabled={approving}
                      busy={approving}
                    />
                  </>
                }
              >
                <p className="personalize__confirm-line">
                  <strong>To:</strong> {kf ? kinfolkDisplayName(kf) : 'nobody'} (
                  {def.deliverable === 'email' ? str(kf?.email) : str(kf?.phoneNumber)})
                </p>
                <p className="personalize__confirm-line">
                  <strong>Channel:</strong> {def.deliverable === 'email' ? 'Email' : 'Text'}
                </p>
                {def.deliverable === 'email' && (
                  <p className="personalize__confirm-line">
                    <strong>Subject:</strong> {form.subject.trim()}
                  </p>
                )}
                <p className="personalize__confirm-line">
                  <strong>Message:</strong> {draftText}
                </p>
                <p className="personalize__confirm-note">
                  This reaches a real household right now. It is not undoable.
                </p>
              </Dialog>
            )}
          </>
        );
      }}
    </AsyncRegion>
  );
}
