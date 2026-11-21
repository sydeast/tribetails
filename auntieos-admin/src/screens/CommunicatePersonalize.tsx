import { useEffect, useId, useRef, useState } from 'react';
import { useKinfolkRoster } from '../lib/useKinfolkRoster';
import { useDocById } from '../lib/firestore';
import { str } from '../lib/coerce';
import { kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { type GeneratedDraftRow } from '../api/drafts';
import { publishGeneratedDraft, deleteGeneratedDraft } from '../api/kinTaleDraftActions';
import { draftBody, draftKinfolkId, draftHousehold, draftTitle, isHeldPushDraft, isPublishedDraft, isUnansweredPushDraft } from '../lib/kinTaleList';
import { GENERATE_COMMUNICATION_TYPES, type GenerateCommunicationType } from '../api/communicateGenerate';
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
  auntieKinTaleBlocker,
  buildGeneratePayload,
  draftSubtitle,
  type PersonalizeFormState,
} from '../lib/personalizeCompose';
import { generateDraft, draftOpening, type GenerateDraftResult } from '../api/communicateGenerate';
import { approveGeneratedDraft, type ApproveDraftResult } from '../api/communicateApprove';
import { sendGeneratedDraft } from '../api/draftSend';
import { alreadySentText, sendRefusedUnconfirmed, sentDraftOnOpen, unconfirmedSendText } from '../lib/draftSent';
import { useBusinessZone } from '../lib/useBusinessZone';
import {
  sendHouseholdPush,
  householdPushResultText,
  householdPushRetryable,
  personalizeDraftActions,
  pushRefusalNeedsApproval,
  type HouseholdPushResult,
} from '../api/householdPush';
import { DenPanel, EmptyHint, StatusPill } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { RecipientContextPanel } from '../components/RecipientContextPanel';
import { Banner } from '../components/Banner';
import { LoadingRow } from '../components/LoadingRow';
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
 * whether there is a `deliver` step at all: a Push goes out through
 * `sendHouseholdPush`, while a Social, Blog or General draft is promoted and
 * recorded but sent by nothing. A deliverable approve gets a confirm dialog
 * first, because it reaches a real household and is not undoable.
 *
 * ── AN EMAIL OR TEXT IS SENT BY THE SERVER, ONCE (#2428) ────────────────────
 * Approving one calls `sendGeneratedDraft`, which approves the draft, sends it
 * and marks it sent in one call. Before #2428 this screen approved the draft
 * itself and then called `sendExternalMessage`, and nothing on the draft said
 * it had gone: opened again it read "needs approval", and a second approve
 * sent the household the same message twice.
 *
 * ── A DRAFT THAT ALREADY WENT OUT OPENS AS SENT (#2428) ─────────────────────
 * A sent Email or Text, and a Push that reached the household's notifications
 * list or their phone, open with what happened and neither button
 * (`lib/draftSent.ts`). The server refuses a second send and a delete of one
 * whatever a screen offers.
 *
 * ── A PUSH IS SENT BY THE SERVER, OR SAYS WHY NOT (#2061) ───────────────────
 * A Push draft's approved line goes to the household through
 * `sendHouseholdPush`, after the approve write, as the deliver step. The
 * server applies the household send gate and the household's own settings and
 * answers with what happened; the banner says exactly that. Before #2061 it
 * said "Nothing was sent, this message type delivers elsewhere" and offered no
 * way to send. A push the gate held can be tried again from the banner once
 * household notices are switched on.
 *
 * ── A KINTALE IS SENT BY THE SERVER (#1563) ─────────────────────────────────
 * A KinTale draft (`visit_report`) goes to the household's portal through the
 * `publishGeneratedDraft` callable, which writes the SENT report and marks the
 * draft sent in one transaction. Before #1563 approving one stamped the draft
 * `approved` and reached nobody.
 *
 * ── OPENING A DRAFT THAT ALREADY EXISTS (#1563) ─────────────────────────────
 * `draftId` loads a `generated_drafts` doc into the form: the household, the
 * type, the title and the copy, ready to edit and send, or to delete. This is
 * where KinTales > Drafts and Home's "KinTales pending" rows land. Before
 * #1563 a draft could only ever be the one this screen had just generated, so
 * Home's button opened a blank form and every stored draft was stranded.
 */
export interface CommunicatePersonalizeProps {
  /** A `generated_drafts` doc id (bare, never the list's namespaced row id) to open for review. */
  draftId?: string | undefined;
  /** Opens the sent KinTale. Omitted, the success banner offers no link. */
  onOpenKinTale?: ((reportId: string) => void) | undefined;
  /**
   * #2444: an Auntie is signed in. She sends a stored KinTale draft and
   * nothing else, so the generator form, the household context panel, Delete
   * and every send that is not a KinTale are not drawn. The reasons, one per
   * control, are in `Communicate.tsx`.
   */
  isAuntie?: boolean;
  /** Opens the KinTales list, where her drafts are. */
  onOpenKinTales?: (() => void) | undefined;
}
/** The composer chip a stored draft's `communication_type` selects. Blank or unknown reads as a KinTale, Home's own fallback. */
function messageTypeOfDraft(draft: GeneratedDraftRow): GenerateCommunicationType {
  const raw = (str(draft.communicationType).trim() || str(draft.communication_type).trim()).toLowerCase();
  return (GENERATE_COMMUNICATION_TYPES as readonly string[]).includes(raw)
    ? (raw as GenerateCommunicationType)
    : 'visit_report';
}
export function CommunicatePersonalize({
  draftId: openDraftId,
  onOpenKinTale,
  isAuntie = false,
  onOpenKinTales,
}: CommunicatePersonalizeProps = {}) {
  const kinfolkState = useKinfolkRoster();
  // A by-id read, not a search of Home's 50-row drafts stream: a draft from
  // May can sit outside that window and still be the one the operator clicked.
  const stored = useDocById<GeneratedDraftRow>('generated_drafts', openDraftId ?? null);

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
  // #1563: the KinTale a send produced, or the one an opened draft was already sent as.
  const [published, setPublished] = useState<{ reportId: string; alreadyPublished: boolean } | null>(null);
  // #2061: what the push send answered, for a Push draft.
  const [pushResult, setPushResult] = useState<HouseholdPushResult | null>(null);
  // #2428: an Email or Text that had already gone out: the stored draft it was
  // opened from, or `answered` when the server said so to a send from here.
  // #2452: `unconfirmed` when the server said the send from here got no
  // answer. The notice then takes the place of Approve and Delete at once, the
  // way it does when the draft is opened again.
  const [sentBefore, setSentBefore] = useState<GeneratedDraftRow | 'answered' | 'unconfirmed' | null>(null);
  // #2440: the day in a sent notice is the business's day, never the browser's.
  const businessZone = useBusinessZone();
  const [retryingPush, setRetryingPush] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // Which stored draft the form was last filled from, so a live update to the
  // same doc never overwrites what the operator is typing.
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);

  const typeLegendId = useId();
  const toneLegendId = useId();
  const lengthLegendId = useId();
  const searchId = useId();
  const subjectId = useId();
  const auntieTitleId = useId();
  const notesId = useId();
  const draftId = useId();

  const def = messageTypeDef(form.messageType);
  const busy = generating || approving || deleting || retryingPush;
  // #2389: `busy` is state, so two taps in one frame both read it false. This
  // is set before the first await and read by every send and delete.
  const inFlight = useRef(false);
  useEffect(() => {
    if (stored.status !== 'ready' || stored.data === null) return;
    const row = stored.data;
    if (row._id === loadedDraftId) return;
    const type = messageTypeOfDraft(row);
    const body = draftBody(row);
    const title = draftTitle(row);
    const kinfolkId = draftKinfolkId(row);
    const household = draftHousehold(row);
    setLoadedDraftId(row._id);
    setForm((f) => ({ ...f, messageType: type, recipientId: kinfolkId, subject: title }));
    setSubjectTouched(title !== '');
    setDraft({
      generated_copy: body,
      generated_title: title,
      communication_type: type,
      kinfolk_name: household !== '' ? household : null,
      kinfolk_id: kinfolkId !== '' ? kinfolkId : null,
      draft_id: row._id,
      model: null,
      draftWriteFailed: false,
      warnings: [],
    });
    setDraftText(body);
    // #2293: a held Push draft opens where it was left, approved with its Try
    // again, so it can be sent after the screen was closed.
    if (isHeldPushDraft(row)) {
      setApproved({ ok: true, auditWarning: null, providerId: null, delivered: true });
      setPushResult({ outcome: 'held', reason: (str(row.pushReason).trim() || null) as HouseholdPushResult['reason'] });
    } else if (isUnansweredPushDraft(row)) {
      // #2381: approved, and the send never answered. Try again finds out.
      setApproved({ ok: true, auditWarning: null, providerId: null, delivered: true });
      setPushResult({ outcome: 'unanswered', reason: null });
    } else {
      setApproved(null);
      setPushResult(null);
    }
    setApproveError(null);
    setFormError(null);
    setDeleted(false);
    setPublished(
      isPublishedDraft(row) ? { reportId: str(row.publishedReportId).trim(), alreadyPublished: true } : null,
    );
    // #2428: a draft that already went out opens as sent, with no Approve and
    // no Delete. It used to open as "needs approval", and approving an Email or
    // Text again sent it to the household a second time.
    const went = sentDraftOnOpen(row, household, businessZone);
    if (went !== null) {
      setApproved({ ok: true, auditWarning: null, providerId: null, delivered: true });
      setPushResult(went.push);
    }
    setSentBefore(went !== null && went.notice !== null ? row : null);
    // `businessZone` is read here only to tell whether the draft went out at
    // all, which no zone changes. The notice is worded again at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, loadedDraftId]);

  function patch(next: Partial<PersonalizeFormState>) {
    setForm((f) => ({ ...f, ...next }));
  }

  /** A new draft invalidates the old one; never leave a stale approve button live. */
  function clearDraft() {
    setDraft(null);
    setDraftText('');
    setApproved(null);
    setPublished(null);
    setPushResult(null);
    setSentBefore(null);
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
    setPublished(null);
    setPushResult(null);
    setSentBefore(null);
    setApproveError(null);
    setDeleted(false);
    setGenerating(true);
    try {
      const result = await generateDraft(
        buildGeneratePayload(form, kf, regenerate && draftText.trim() !== '' ? draftOpening(draftText) : null),
      );
      setDraft(result);
      setDraftText(result.generated_copy);
      // Never overwrite a subject the operator typed. Same rule the KinTale
      // composer uses for its headline.
      if (def.wantsTitle && !subjectTouched && result.generated_title.trim() !== '') {
        patch({ subject: result.generated_title.trim() });
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Generate failed.');
    } finally {
      setGenerating(false);
    }
  }

  /**
   * #2389: an approved Push that has not gone out sends its approved words and
   * no others. Editing them returns the draft to unapproved, so the next step
   * is Approve and send, which stores the new words before it sends them.
   */
  function editDraftText(next: string) {
    setDraftText(next);
    if (approved !== null && pushResult !== null && householdPushRetryable(pushResult) && next !== draftText) {
      setApproved(null);
      setPushResult(null);
      setApproveError(null);
    }
  }
  async function runApprove() {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setApproving(true);
    setApproveError(null);
    try {
      // A KinTale is sent by the server, which also marks the draft sent. No
      // client-side approve write first: that write is what used to leave a
      // KinTale `approved` and undelivered.
      if (def.deliverable === 'kintale') {
        const result = await publishGeneratedDraft({
          draftId: draft?.draft_id ?? '',
          bodyCopy: draftText,
          title: form.subject,
        });
        setPublished({ reportId: result.reportId, alreadyPublished: result.alreadyPublished });
        setConfirmOpen(false);
        return;
      }
      // #2428: an Email or Text is approved and sent by the server in one call,
      // which marks the draft sent. No client-side approve write and no
      // `sendExternalMessage`: that pair left nothing on the draft to say it
      // had gone, so it could be approved and sent again.
      if (def.deliverable === 'email' || def.deliverable === 'sms') {
        const result = await sendGeneratedDraft({
          draftId: draft?.draft_id ?? '',
          kinfolkId: draft?.kinfolk_id ?? form.recipientId,
          body: draftText,
          ...(def.deliverable === 'email' ? { subject: form.subject } : {}),
        });
        setApproved({ ok: true, auditWarning: result.auditWarning, providerId: null, delivered: true });
        setPushResult(null);
        setSentBefore(result.outcome === 'already_sent' ? 'answered' : null);
        setConfirmOpen(false);
        return;
      }
      // #2061: the push's answer, read after the approve. `delivered` only says
      // the call returned; what reached the household is in this result.
      let pushAnswer: HouseholdPushResult | null = null;
      const pushTo = draft?.kinfolk_id ?? (form.recipientId !== '' ? form.recipientId : '');
      // The deliver step exists only for a type that actually sends. Passing an
      // always-present callback that sometimes no-ops would make `delivered`
      // claim a send that never happened.
      const deliver =
        def.deliverable === 'push' && pushTo !== ''
          ? async () => {
              pushAnswer = await sendHouseholdPush({
                kinfolkId: pushTo,
                draftId: draft?.draft_id ?? '',
                body: draftText,
              });
              return null;
            }
          : undefined;

      const result = await approveGeneratedDraft({
        draftId: draft?.draft_id ?? '',
        editedCopy: draftText,
        kinfolkId: draft?.kinfolk_id ?? (form.recipientId !== '' ? form.recipientId : null),
        subject: def.wantsTitle ? form.subject.trim() : null,
        ...(deliver ? { deliver } : {}),
      });
      setApproved(result);
      setPushResult(pushAnswer);
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      // #2452: the send got no answer, and the server keeps the draft closed.
      // Told by the refusal's code, never its words. The screen stops offering
      // Approve and Delete here, and says what is and is not known.
      if (sendRefusedUnconfirmed(err)) {
        setApproved({ ok: true, auditWarning: null, providerId: null, delivered: true });
        setPushResult(null);
        setSentBefore('unconfirmed');
        return;
      }
      setApproveError(err instanceof Error ? err.message : 'Approve failed.');
    } finally {
      inFlight.current = false;
      setApproving(false);
    }
  }

  /** #2061: send a held push again, once its cause is fixed. The draft is already approved. */
  async function retryPush() {
    const kinfolkId = draft?.kinfolk_id ?? (form.recipientId !== '' ? form.recipientId : '');
    if (busy || inFlight.current || kinfolkId === '' || !draft?.draft_id) return;
    inFlight.current = true;
    setRetryingPush(true);
    setApproveError(null);
    try {
      setPushResult(await sendHouseholdPush({ kinfolkId, draftId: draft.draft_id, body: draftText }));
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'The push could not be sent.');
      // #2389: the stored words are not these. Back to unapproved.
      if (pushRefusalNeedsApproval(err)) {
        setApproved(null);
        setPushResult(null);
      }
    } finally {
      inFlight.current = false;
      setRetryingPush(false);
    }
  }

  async function runDelete() {
    const id = draft?.draft_id ?? '';
    if (busy || inFlight.current || id === '') return;
    inFlight.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteGeneratedDraft(id);
      setDeleteOpen(false);
      clearDraft();
      setDeleted(true);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  }
  function handleApproveClick(kf: Kinfolk | undefined) {
    if (busy) return;
    // #2444: an Auntie has no recipient picker, so her send is checked
    // against the household the draft itself names.
    const blocker =
      isAuntie && def.deliverable === 'kintale'
        ? auntieKinTaleBlocker(draft?.kinfolk_id ?? null, draftText)
        : approveBlocker(form, kf, draft?.draft_id ?? null, draftText);
    if (blocker !== null) {
      setApproveError(blocker);
      return;
    }
    setApproveError(null);
    if (def.deliverable !== false) {
      setConfirmOpen(true);
      return;
    }
    void runApprove();
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
        const household = kf ? kinfolkDisplayName(kf) : (draft?.kinfolk_name ?? 'the household');
        // A sent draft is finished: no second send, no delete.
        const settled = published !== null || approved !== null;
        // #2381: an approved Push that did not go out keeps its Delete.
        const actions = personalizeDraftActions({
          published: published !== null,
          approved: approved !== null,
          pushResult,
        });
        // #2444: the one send an Auntie can finish. Her rules read only
        // KinTale drafts, so any other type on her screen is a draft the server
        // will not let her act on, and it gets no button.
        const auntieMaySend = isAuntie && def.deliverable === 'kintale';

        // `.communicate__main` is the left column of the two-column grid
        // `Communicate` draws (the mock's `.cols`); the confirm Dialog is
        // `position: fixed` and takes no cell, so it sits outside the wrapper.
        return (
          <>
            <div className="communicate__main">
            {openDraftId !== undefined && openDraftId !== '' && stored.status === 'loading' && (
              <LoadingRow label="Opening the draft…" className="personalize__note" />
            )}
            {openDraftId !== undefined && openDraftId !== '' && stored.status === 'ready' && stored.data === null && !deleted && (
              <Banner tone="warning" title="Draft not found">
                This draft is no longer here. It may have been deleted.
              </Banner>
            )}
            {stored.status === 'error' && (
              <Banner tone="error" title="Draft did not open">
                {stored.message}
              </Banner>
            )}
            {deleted && <Banner tone="success">Draft deleted.</Banner>}
            {/* #2444: an Auntie with no draft open has nothing to act on here,
                so she is pointed at the list her drafts are in. */}
            {isAuntie && draft === null && stored.status !== 'loading' && (
              <DenPanel title="KinTale drafts">
                <EmptyHint>No draft is open.</EmptyHint>
                {onOpenKinTales && (
                  <div className="personalize__actions">
                    <GhostButton label="Open KinTales" onClick={onOpenKinTales} />
                  </div>
                )}
              </DenPanel>
            )}
            {!isAuntie && (
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
                  {/* The mock's `.gen`: the generator wears the purple-to-pink
                      wash, the one button on the screen that is Auntie AI
                      rather than the operator. */}
                  <PrimaryButton
                    label={draft === null ? 'Generate draft' : 'Regenerate'}
                    busy={generating}
                    disabled={busy}
                    onClick={() => void handleGenerate(kf, draft !== null)}
                    className="personalize__generate"
                  />
                </div>
              </div>
            </DenPanel>
            )}

            {/* The context Auntie reads before drafting. Rendered for the types
                that address a household; a Blog post has no recipient, so there
                is no dossier to show and the panel would be a permanent empty
                state taking up the screen. */}
            {def.needsRecipient && !isAuntie && <RecipientContextPanel kinfolkId={form.recipientId} />}
            {draft !== null && (
              // The mock's `.draft` card: purple rim and wash, "Auntie AI
              // draft" with the "needs approval" capsule on the header rule.
              // The capsule leaves once the draft is approved; it states a
              // fact about the draft, and that fact stops being true.
              <DenPanel
                title="Auntie AI draft"
                detail={draftSubtitle(draft)}
                className="personalize__draft"
                trailing={!settled ? <StatusPill label="needs approval" tone="purple" /> : undefined}
              >
                <div className="personalize__form">
                  {draft.draftWriteFailed && (
                    <Banner tone="warning" title="Draft not saved">
                      {draft.warnings.length > 0
                        ? draft.warnings.join(' ')
                        : 'This draft was generated but not saved, so it cannot be approved. Copy the text below before navigating away, then regenerate.'}
                    </Banner>
                  )}

                  {/* #2444: the owner's Subject box is in the generator
                      form, which an Auntie does not get. Her KinTale's title
                      is edited here, beside the words it heads. */}
                  {isAuntie && def.deliverable === 'kintale' && (
                    <label className="personalize__field" htmlFor={auntieTitleId}>
                      <span className="personalize__field-label">Title</span>
                      <input
                        id={auntieTitleId}
                        type="text"
                        className="personalize__text-input"
                        value={form.subject}
                        disabled={busy || settled}
                        maxLength={SUBJECT_MAX}
                        onChange={(e) => {
                          patch({ subject: e.target.value });
                          setSubjectTouched(true);
                        }}
                      />
                    </label>
                  )}
                  <label className="personalize__field" htmlFor={draftId}>
                    <span className="personalize__field-label">Edit before approving</span>
                    <textarea
                      id={draftId}
                      className="personalize__textarea personalize__textarea--draft"
                      value={draftText}
                      disabled={busy}
                      rows={10}
                      onChange={(e) => editDraftText(e.target.value)}
                    />
                  </label>

                  {approveError !== null && (
                    <Banner tone="error" title="Approve blocked">
                      {approveError}
                    </Banner>
                  )}

                  {published !== null && (
                    <Banner tone="success" title="KinTale sent">
                      {published.alreadyPublished
                        ? `This KinTale was already sent to ${household}.`
                        : `Sent to ${household}. It is on their portal now.`}
                      {onOpenKinTale && published.reportId !== '' && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="async-retry"
                            onClick={() => onOpenKinTale(published.reportId)}
                          >
                            Open the KinTale
                          </button>
                        </>
                      )}
                    </Banner>
                  )}
                  {approved !== null && pushResult !== null && (() => {
                    // #2061: the push's own answer, never a generic "sent".
                    const words = householdPushResultText(pushResult, household);
                    const tone = householdPushRetryable(pushResult) ? 'warning' : 'success';
                    return (
                      <Banner tone={tone} title={words.title}>
                        {words.body}
                        {approved.auditWarning !== null
                          ? ` The audit entry could not be written: ${approved.auditWarning}`
                          : ''}
                        {householdPushRetryable(pushResult) && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="async-retry"
                              disabled={busy}
                              onClick={() => void retryPush()}
                            >
                              {retryingPush ? 'Trying again…' : 'Try again'}
                            </button>
                          </>
                        )}
                      </Banner>
                    );
                  })()}
                  {approved !== null && pushResult === null && sentBefore !== null && (() => {
                    // #2428: this one had already gone out. Say so, in place of
                    // "Draft approved", which reads as something done just now.
                    // #2452: a send that got no answer has its own words, and
                    // the warning tone, whether it was opened that way or the
                    // server just said so.
                    const words =
                      sentBefore === 'answered'
                        ? alreadySentText(household)
                        : sentBefore === 'unconfirmed'
                          ? unconfirmedSendText(household, def.deliverable === 'email' || def.deliverable === 'sms' ? def.deliverable : null)
                          : sentDraftOnOpen(sentBefore, household, businessZone)?.notice;
                    return words ? (
                      <Banner tone={words.tone} title={words.title}>
                        {words.body}
                      </Banner>
                    ) : null;
                  })()}
                  {approved !== null && pushResult === null && sentBefore === null && (
                    <Banner tone="success" title="Draft approved">
                      {approved.delivered
                        ? // #1592: no provider message id; it is a support trace, not
                          // something the operator reads.
                          'Approved and sent.'
                        : 'Approved and saved. Nothing was sent: Social, Blog and General drafts are not sent from here, so copy the text to where it goes.'}
                      {approved.auditWarning !== null
                        ? ` The audit entry could not be written: ${approved.auditWarning}`
                        : ''}
                    </Banner>
                  )}

                  {deleteError !== null && !deleteOpen && (
                    <Banner tone="error" title="Delete failed">
                      {deleteError}
                    </Banner>
                  )}
                  {(auntieMaySend ? actions.approve : !isAuntie && (actions.approve || actions.remove)) && (
                    <div className="personalize__actions">
                      {actions.approve && (!isAuntie || auntieMaySend) && (
                        <PrimaryButton
                          label={approveLabel}
                          busy={approving}
                          disabled={busy}
                          onClick={() => handleApproveClick(kf)}
                        />
                      )}
                      {actions.remove && !isAuntie && draft.draft_id !== null && draft.draft_id !== '' && (
                        <GhostButton
                          label="Delete draft"
                          disabled={busy}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteOpen(true);
                          }}
                        />
                      )}
                    </div>
                  )}
                  {!isAuntie && (
                    <p className="personalize__note">
                      Approving saves this draft and records it in the activity log. Nothing goes out until that save
                      succeeds.
                    </p>
                  )}
                </div>
              </DenPanel>
            )}
            </div>

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
                      onClick={() => void runApprove()}
                      disabled={approving}
                      busy={approving}
                    />
                  </>
                }
              >
                {def.deliverable === 'push' ? (
                  <>
                    <p className="personalize__confirm-line">
                      <strong>To:</strong> {kf ? kinfolkDisplayName(kf) : 'nobody'}
                    </p>
                    <p className="personalize__confirm-line">
                      <strong>Channel:</strong> Push, to their phone and their notifications list
                    </p>
                  </>
                ) : def.deliverable === 'kintale' ? (
                  <>
                    <p className="personalize__confirm-line">
                      {/* The draft's own household when the roster does not
                          hold it: that is who the server sends it to. */}
                      <strong>To:</strong> {household}
                    </p>
                    <p className="personalize__confirm-line">
                      <strong>Channel:</strong> KinTale, on their portal
                    </p>
                    {form.subject.trim() !== '' && (
                      <p className="personalize__confirm-line">
                        <strong>Title:</strong> {form.subject.trim()}
                      </p>
                    )}
                  </>
                ) : (
                  <>
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
                  </>
                )}
                <p className="personalize__confirm-line">
                  <strong>Message:</strong> {draftText}
                </p>
                <p className="personalize__confirm-note">
                  This reaches a real household right now. It is not undoable.
                </p>
              </Dialog>
            )}
            {deleteOpen && (
              <Dialog
                title="Delete this draft?"
                onClose={() => {
                  if (!deleting) setDeleteOpen(false);
                }}
                footer={
                  <>
                    <GhostButton label="Cancel" onClick={() => setDeleteOpen(false)} disabled={deleting} />
                    <PrimaryButton
                      label={deleting ? 'Deleting…' : 'Delete'}
                      onClick={() => void runDelete()}
                      disabled={deleting}
                      busy={deleting}
                    />
                  </>
                }
              >
                <p className="personalize__confirm-line">
                  {/* #2381: an unanswered push may have gone out, so "not sent" is not said for it. */}
                  {pushResult?.outcome === 'unanswered'
                    ? ''
                    : household !== ''
                      ? `The draft for ${household} has not been sent. `
                      : 'This draft has not been sent. '}
                  Deleting it cannot be undone.
                </p>
                {deleteError !== null && <Banner tone="error">{deleteError}</Banner>}
              </Dialog>
            )}
          </>
        );
      }}
    </AsyncRegion>
  );
}
