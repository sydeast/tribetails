import { useEffect, useState } from 'react';
import { KINTALES_QUERY, type KinTaleEntry } from '../api/kinTales';
import { SESSIONS_QUERY, type SessionEntry } from '../api/sessions';
import { saveKinTaleDraft, sendKinTale, hasKinTaleContent, type KinTaleDraft } from '../api/kinTalesWrite';
import { sessionState } from '../lib/sessionFormat';
import { useCollection } from '../lib/firestore';
import { DenScreenHeading, DenPanel, EmptyHint, ServicePill } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import { GenerateButton, type GeneratedDraft } from '../components/GenerateButton';
import { validateKinTaleDraft, type KinTaleDraftErrors } from '../lib/kinTaleDraftSchema';
import { useToast } from '../components/Toast';
import './KinTaleCompose.css';

/**
 * KinTale COMPOSE / EDIT, the create/edit surface `KinTales.tsx` deferred (its
 * own doc comment: "composing or editing a KinTale (KinTaleComposeScreen) ...
 * separate, not-yet-built surface"). Ports the wasm's `KinTaleComposeScreen.kt`
 * scoped to what it defers explicitly as IN scope for a compose surface
 * (title, recap body, the household/session it belongs to, save-draft,
 * send-with-confirm) and OUT of scope for this port (comment thread, share
 * link, photo/GPS blocks, per-item checklist, custom form_schemas, the web
 * template editor), all of which belong to the separate not-yet-built
 * KinTaleReportScreen detail view or KinTaleTemplateEditorScreen, not this
 * compose surface.
 *
 * TWO ENTRY MODES, mirroring how a real KinTale always starts:
 *  - EDIT: `kinTaleId` given. Loads the existing `kin_care_reports` row (off
 *    the same bounded `KINTALES_QUERY` stream `KinTales.tsx` already uses, so
 *    this screen opens no second listener class) and lets the auntie revise
 *    it.
 *  - NEW: `sessionId` given (or picked inline, see `SessionPicker` below).
 *    Scaffolds a blank draft off the parent `kin_care_sessions` row, mirroring
 *    the wasm's `scaffoldReport(session, template)`; unlike the wasm this port
 *    has no template system yet, so title/body simply start blank.
 *  - Neither prop given: the screen shows an inline picker over
 *    `SESSIONS_QUERY`, restricted to sessions that have actually happened
 *    (DEPARTED or COMPLETED, a positive membership test, never a negation of
 *    the four in-progress/cancelled states), matching the wasm's own entry
 *    point ("opens after a Kin Care is DEPARTED", `KinTaleComposeScreen.kt`'s
 *    doc comment). A SCHEDULED/ON_MY_WAY/ARRIVED visit has no recap to write
 *    yet.
 *
 * SEND is gated behind a confirm `Dialog`: sending is outward-facing (the
 * Kinfolk sees it), so it gets the same "are you sure" the delete-schema flow
 * in `FormSchemas.tsx` uses for its own irreversible action. Save Draft has no
 * such gate, it's the safe, reversible action.
 */

export interface KinTaleComposeProps {
  /** Edit an existing report. */
  kinTaleId?: string;
  /** Start a brand-new draft scaffolded from this Kin Care session. */
  sessionId?: string;
  /**
   * NARROW THE SESSION PICKER TO ONE HOUSEHOLD.
   *
   * The household profile's "New KinTale" (the mock's hero primary) opens this
   * screen already knowing whose KinTale it is, but not which visit it recaps.
   * Without this the operator would land on every household's eligible sessions
   * and have to find theirs. Absent means every household, which is what the
   * KinTales list's own "New" still passes.
   */
  kinfolkId?: string;
  onClose: () => void;
}

// ── pure helpers, unit-tested directly ──────────────────────────────────────

/**
 * Positive membership: only a session that has actually happened (DEPARTED or
 * COMPLETED) is eligible to start a new KinTale from, matching the wasm's own
 * entry point. A positive test against the two states that qualify, never a
 * negation of the other five (the AO-12 convention `lib/sessionFormat.ts`
 * already documents).
 */
export function isKinTaleEligibleSession(status: string): boolean {
  const state = sessionState(status);
  return state === 'departed' || state === 'completed';
}

/**
 * Send-button label bound to the REAL recipient household, ported verbatim
 * from the wasm's `kinTaleSendLabel` (`KinTaleComposeScreen.kt`): never a
 * hardcoded sample household, falls back to neutral copy when blank.
 */
export function kinTaleSendLabel(recipient: string): string {
  return recipient.trim() === '' ? 'Send KinTale' : `Send to ${recipient}`;
}

/**
 * Scaffold a blank new draft off the session it will belong to. Mirrors the
 * wasm's `scaffoldReport`.
 *
 * Every read is defaulted because `SessionEntry` is a CAST over raw Firestore
 * data, not a validation of it: `serviceType` is absent on 76 of the 99 live
 * `kin_care_sessions`. An undefined leaking into `KinTaleDraft` here would not
 * just blank the compose screen, it would be WRITTEN BACK to the report doc by
 * `saveKinTaleDraft`, so the default has to happen at the read.
 */
export function scaffoldKinTaleDraft(session: SessionEntry): KinTaleDraft {
  return {
    sessionId: session._id,
    kinfolkId: session.kinfolkId ?? '',
    kinfolkName: session.kinfolkName ?? '',
    kinIds: session.kinIds ?? [],
    serviceType: session.serviceType ?? '',
    visitDate: session.startTime ?? '',
    arrivedAt: session.arrivedAt ?? '',
    title: '',
    titleGeneratedByAi: false,
    bodyCopy: '',
    mediaFileIds: [],
  };
}

/** Rehydrate an editable draft off an already-streamed `KinTaleEntry` row. Defaulted for the same reason as `scaffoldKinTaleDraft` above. */
export function draftFromKinTaleEntry(report: KinTaleEntry): KinTaleDraft {
  return {
    _id: report._id,
    sessionId: report.sessionId ?? '',
    kinfolkId: report.kinfolkId ?? '',
    kinfolkName: report.kinfolkName ?? '',
    kinIds: report.kinIds ?? [],
    serviceType: report.serviceType ?? '',
    visitDate: report.visitDate ?? '',
    arrivedAt: report.arrivedAt ?? '',
    title: report.title ?? '',
    titleGeneratedByAi: report.titleGeneratedByAi ?? false,
    bodyCopy: report.bodyCopy ?? '',
    mediaFileIds: report.mediaFileIds ?? [],
  };
}

type Banner_ = { tone: 'error' | 'success' | 'info'; text: string };

export function KinTaleCompose({ kinTaleId, sessionId, kinfolkId, onClose }: KinTaleComposeProps) {
  const reports = useCollection<KinTaleEntry>(KINTALES_QUERY);
  const sessions = useCollection<SessionEntry>(SESSIONS_QUERY);

  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const effectiveSessionId = sessionId ?? pickedSessionId;

  const [draft, setDraft] = useState<KinTaleDraft | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [banner, setBanner] = useState<Banner_ | null>(null);
  const { showToast } = useToast();
  /**
   * Fold a generated draft into the form.
   *
   * The body is replaced: asking Auntie to write is asking for a new body, and
   * the operator asked. The TITLE is only filled when blank, because a headline
   * the operator typed is theirs and silently overwriting it is the one thing
   * this button must never do. `titleGeneratedByAi` records which happened, and
   * any keystroke in the headline field clears it.
   */
  function applyGenerated(result: GeneratedDraft) {
    setDraft((d) => {
      if (!d) return d;
      const titleIsBlank = d.title.trim() === '';
      const takeTitle = titleIsBlank && result.title.trim() !== '';
      return {
        ...d,
        bodyCopy: result.body,
        title: takeTitle ? result.title : d.title,
        titleGeneratedByAi: takeTitle ? true : d.titleGeneratedByAi,
      };
    });
    // The copy is in hand either way; the draft ROW failing to persist is a
    // separate fact and it stays on a persistent surface, not a toast.
    if (result.draftWriteFailed) {
      setBanner({
        tone: 'error',
        text: 'Auntie wrote the tale, but the draft row did not save. Copy the text somewhere safe before you navigate away.',
      });
      return;
    }
    setBanner(null);
    showToast('Auntie drafted a tale. Edit away.');
  }

  // Reset hydration whenever the identity of what we're composing changes
  // (a different kinTaleId/sessionId), so switching targets doesn't leave the
  // PREVIOUS target's draft on screen.
  useEffect(() => {
    setDraft(null);
    setHydrated(false);
    setBanner(null);
  }, [kinTaleId, effectiveSessionId]);

  // One-time hydration off whichever stream resolves the requested identity.
  // Deliberately does NOT re-run on every later snapshot once hydrated: the
  // draft afterwards is purely local edit state (mirrors the wasm's own
  // `remember(session._id, template._id) { mutableStateOf(scaffoldReport(...)) }`,
  // which also only recomputes when the identity changes, not on every stream tick).
  useEffect(() => {
    if (hydrated) return;
    if (kinTaleId) {
      if (reports.status !== 'ready') return;
      const found = reports.data.find((r) => r._id === kinTaleId);
      if (found) {
        setDraft(draftFromKinTaleEntry(found));
        setHydrated(true);
      }
      return;
    }
    if (effectiveSessionId) {
      if (sessions.status !== 'ready') return;
      const found = sessions.data.find((s) => s._id === effectiveSessionId);
      if (found) {
        setDraft(scaffoldKinTaleDraft(found));
        setHydrated(true);
      }
    }
  }, [kinTaleId, effectiveSessionId, hydrated, reports, sessions]);

  async function handleSaveDraft() {
    if (!draft || isSaving || isSending) return;
    setIsSaving(true);
    setBanner(null);
    try {
      const id = await saveKinTaleDraft(draft);
      setIsSaving(false);
      if (id === null) {
        setBanner({ tone: 'info', text: 'Nothing to save yet. Add a headline, some notes, or a photo first.' });
        return;
      }
      if (id !== draft._id) setDraft({ ...draft, _id: id });
      setBanner(null);
      showToast('Draft saved.');
    } catch (err) {
      setIsSaving(false);
      setBanner({ tone: 'error', text: `Couldn't save draft: ${err instanceof Error ? err.message : 'unknown error'}` });
    }
  }

  async function handleConfirmSend() {
    if (!draft || isSending) return;
    setIsSending(true);
    setBanner(null);
    try {
      // Send always saves first, mirrors the wasm's own onSend(): a still-new
      // draft is created on the way to being sent, never sent unsaved.
      const id = await saveKinTaleDraft(draft);
      if (id === null) {
        setIsSending(false);
        setConfirmSend(false);
        setBanner({ tone: 'error', text: 'Nothing to send yet. Add a headline, some notes, or a photo first.' });
        return;
      }
      if (id !== draft._id) setDraft({ ...draft, _id: id });
      await sendKinTale({ reportId: id, sessionId: draft.sessionId });
      setIsSending(false);
      setConfirmSend(false);
      setBanner({ tone: 'success', text: 'KinTale sent. Kinfolk will hear from you soon.' });
      onClose();
    } catch (err) {
      setIsSending(false);
      setBanner({ tone: 'error', text: `Couldn't send: ${err instanceof Error ? err.message : 'unknown error'}` });
    }
  }

  const heading = (
    <DenScreenHeading
      kicker="The Den · KinTales"
      title={kinTaleId ? 'Edit the' : 'Compose a'}
      accentTail="KinTale."
      subtitle={draft ? `Goes to ${draft.kinfolkName || 'Kinfolk'}.` : 'The recap that goes home after a visit.'}
      trailing={<GhostButton label="Close" onClick={onClose} />}
    />
  );

  if (kinTaleId) {
    return (
      <div className="screen kintale-compose">
        {heading}
        <AsyncRegion state={reports} what="the KinTale" isEmpty={() => false} empty={null}>
          {(data) => {
            const found = data.find((r) => r._id === kinTaleId);
            if (!found) {
              return <EmptyHint>No KinTale found with id &ldquo;{kinTaleId}&rdquo;.</EmptyHint>;
            }
            return draft ? (
              <ComposeForm
                draft={draft}
                onTitleChange={(v) =>
                  setDraft((d) => (d ? { ...d, title: v, titleGeneratedByAi: false } : d))
                }
                onBodyChange={(v) => setDraft((d) => (d ? { ...d, bodyCopy: v } : d))}
                onGenerated={applyGenerated}
                onGenerateError={(text) => setBanner({ tone: 'error', text })}
                isSaving={isSaving}
                isSending={isSending}
                banner={banner}
                confirmSend={confirmSend}
                onSaveDraft={() => void handleSaveDraft()}
                onOpenSendConfirm={() => setConfirmSend(true)}
                onCancelSendConfirm={() => setConfirmSend(false)}
                onConfirmSend={() => void handleConfirmSend()}
              />
            ) : (
              <p className="kintale-compose__hint">Loading…</p>
            );
          }}
        </AsyncRegion>
      </div>
    );
  }

  if (effectiveSessionId) {
    return (
      <div className="screen kintale-compose">
        {heading}
        <AsyncRegion state={sessions} what="the Kin Care session" isEmpty={() => false} empty={null}>
          {(data) => {
            const found = data.find((s) => s._id === effectiveSessionId);
            if (!found) {
              return <EmptyHint>No Kin Care session found with id &ldquo;{effectiveSessionId}&rdquo;.</EmptyHint>;
            }
            return draft ? (
              <ComposeForm
                draft={draft}
                onTitleChange={(v) =>
                  setDraft((d) => (d ? { ...d, title: v, titleGeneratedByAi: false } : d))
                }
                onBodyChange={(v) => setDraft((d) => (d ? { ...d, bodyCopy: v } : d))}
                onGenerated={applyGenerated}
                onGenerateError={(text) => setBanner({ tone: 'error', text })}
                isSaving={isSaving}
                isSending={isSending}
                banner={banner}
                confirmSend={confirmSend}
                onSaveDraft={() => void handleSaveDraft()}
                onOpenSendConfirm={() => setConfirmSend(true)}
                onCancelSendConfirm={() => setConfirmSend(false)}
                onConfirmSend={() => void handleConfirmSend()}
              />
            ) : (
              <p className="kintale-compose__hint">Loading…</p>
            );
          }}
        </AsyncRegion>
      </div>
    );
  }

  return (
    <div className="screen kintale-compose">
      {heading}
      <SessionPicker
        sessions={sessions}
        {...(kinfolkId !== undefined && kinfolkId !== '' ? { kinfolkId } : {})}
        onPick={setPickedSessionId}
      />
    </div>
  );
}

// ── session picker (NEW with no session yet) ────────────────────────────────

interface SessionPickerProps {
  sessions: ReturnType<typeof useCollection<SessionEntry>>;
  /**
   * Narrow to one household. Absent means every household, the KinTales list's
   * own "New".
   *
   * This is what `KinTaleComposeProps.kinfolkId` was added for, and until #552 it
   * did not reach here: the prop was declared on the parent and spread into this
   * component, which never took it. JSX spread is not excess-property checked, so
   * TypeScript said nothing and the profile's "New KinTale" landed the operator in
   * every household's visits. Threaded properly, with `pickableSessions` below as
   * the one place the two filters live.
   */
  kinfolkId?: string;
  onPick: (sessionId: string) => void;
}

/**
 * The sessions this picker may offer: the visits that have HAPPENED, narrowed to
 * one household when the caller named one.
 *
 * Exported so the narrowing is a testable fact rather than a prop that looks
 * plumbed. A session doc with no `status` at all classifies as 'unknown', which
 * is not DEPARTED/COMPLETED, so it stays out either way.
 */
export function pickableSessions(data: SessionEntry[], kinfolkId?: string): SessionEntry[] {
  const eligible = data.filter((s) => isKinTaleEligibleSession(s.status ?? ''));
  if (kinfolkId === undefined || kinfolkId === '') return eligible;
  return eligible.filter((s) => (s.kinfolkId ?? '') === kinfolkId);
}

function SessionPicker({ sessions, kinfolkId, onPick }: SessionPickerProps) {
  const scoped = kinfolkId !== undefined && kinfolkId !== '';
  return (
    <DenPanel
      title="Pick a Kin Care session"
      subtitle={
        scoped
          ? "This household's visits that have already happened."
          : "A KinTale always starts from a visit that's already happened."
      }
    >
      <AsyncRegion
        state={sessions}
        what="Kin Care sessions"
        isEmpty={(data) => pickableSessions(data, kinfolkId).length === 0}
        empty={
          <EmptyHint>
            {scoped
              ? 'No departed or completed visits for this household yet.'
              : 'No departed or completed sessions yet.'}
          </EmptyHint>
        }
      >
        {(data) => {
          const eligible = pickableSessions(data, kinfolkId);
          return (
            <ul className="kintale-compose__picker-list">
              {eligible.map((s) => (
                <li key={s._id} className="kintale-compose__picker-row">
                  <button type="button" className="kintale-compose__picker-button" onClick={() => onPick(s._id)}>
                    <span className="kintale-compose__picker-name">{s.kinfolkName || 'Unnamed Kinfolk'}</span>
                    <ServicePill serviceType={s.serviceType ?? ''} />
                  </button>
                </li>
              ))}
            </ul>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

// ── the compose form itself ─────────────────────────────────────────────────

interface ComposeFormProps {
  draft: KinTaleDraft;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onGenerated: (result: GeneratedDraft) => void;
  onGenerateError: (message: string) => void;
  isSaving: boolean;
  isSending: boolean;
  banner: Banner_ | null;
  confirmSend: boolean;
  onSaveDraft: () => void;
  onOpenSendConfirm: () => void;
  onCancelSendConfirm: () => void;
  onConfirmSend: () => void;
}

function ComposeForm({
  draft,
  onTitleChange,
  onBodyChange,
  onGenerated,
  onGenerateError,
  isSaving,
  isSending,
  banner,
  confirmSend,
  onSaveDraft,
  onOpenSendConfirm,
  onCancelSendConfirm,
  onConfirmSend,
}: ComposeFormProps) {
  const contentReady = hasKinTaleContent(draft);
  const sendLabel = kinTaleSendLabel(draft.kinfolkName);
  // Validated on every render rather than on submit: the dash rule is about
  // something the operator is typing right now, and telling them after they hit
  // Send means retyping a paragraph they already finished.
  const errors: KinTaleDraftErrors = validateKinTaleDraft({
    title: draft.title,
    bodyCopy: draft.bodyCopy,
    sessionId: draft.sessionId,
  });
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <>
      <DenPanel title="Goes to" subtitle="Read-only: the household and visit this recap belongs to.">
        <dl className="kintale-compose__meta">
          <div className="kintale-compose__meta-row">
            <dt>Household</dt>
            <dd>{draft.kinfolkName || 'Unnamed Kinfolk'}</dd>
          </div>
          <div className="kintale-compose__meta-row">
            <dt>Service</dt>
            <dd>{draft.serviceType || 'Visit'}</dd>
          </div>
          <div className="kintale-compose__meta-row">
            <dt>Session</dt>
            <dd>
              <code>{draft.sessionId}</code>
            </dd>
          </div>
        </dl>
      </DenPanel>

      <DenPanel title="The tale">
        <label className="kintale-compose__field">
          <span className="kintale-compose__label">Headline</span>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={`Checking on ${draft.kinfolkName || 'Kinfolk'}`}
            className="kintale-compose__input"
            aria-invalid={errors.title !== undefined}
            aria-describedby={errors.title !== undefined ? 'kintale-title-error' : undefined}
          />
          {errors.title !== undefined && (
            <span id="kintale-title-error" className="kintale-compose__error" role="alert">
              {errors.title}
            </span>
          )}
          {draft.titleGeneratedByAi && errors.title === undefined && (
            <span className="kintale-compose__provenance">
              Auntie wrote this headline. Type over it to make it yours.
            </span>
          )}
        </label>
        <label className="kintale-compose__field">
          <span className="kintale-compose__label">What you&rsquo;d like the kinfolk to know</span>
          <textarea
            value={draft.bodyCopy}
            onChange={(e) => onBodyChange(e.target.value)}
            placeholder="Tell the tale. How was the visit?"
            className="kintale-compose__textarea"
            rows={8}
            aria-invalid={errors.bodyCopy !== undefined}
            aria-describedby={errors.bodyCopy !== undefined ? 'kintale-body-error' : undefined}
          />
          {errors.bodyCopy !== undefined && (
            <span id="kintale-body-error" className="kintale-compose__error" role="alert">
              {errors.bodyCopy}
            </span>
          )}
        </label>
        <GenerateButton
          communicationType="visit_report"
          recipient={draft.kinfolkName}
          rawNotes={draft.bodyCopy}
          wantTitle
          currentBody={draft.bodyCopy}
          onGenerated={onGenerated}
          onError={onGenerateError}
          disabled={isSaving || isSending}
        />
      </DenPanel>

      {!contentReady && !banner && (
        <Banner tone="info">Add a headline, some notes, or a photo to enable Send.</Banner>
      )}
      {banner && <Banner tone={banner.tone}>{banner.text}</Banner>}

      <div className="kintale-compose__actions">
        <GhostButton label={isSaving ? 'Saving…' : 'Save draft'} onClick={onSaveDraft} disabled={isSaving || isSending} />
        <PrimaryButton
          label={isSending ? 'Sending…' : sendLabel}
          onClick={onOpenSendConfirm}
          disabled={!contentReady || hasErrors || isSaving || isSending}
          busy={isSending}
        />
      </div>

      {confirmSend && (
        <Dialog
          title="Send this KinTale?"
          onClose={() => {
            if (!isSending) onCancelSendConfirm();
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={onCancelSendConfirm} disabled={isSending} />
              <PrimaryButton
                label={isSending ? 'Sending…' : 'Send KinTale'}
                onClick={onConfirmSend}
                disabled={isSending}
                busy={isSending}
              />
            </>
          }
        >
          <p className="kintale-compose__dialog-hint">
            {sendLabel}. Kinfolk will get this recap. This cannot be undone.
          </p>
        </Dialog>
      )}
    </>
  );
}
