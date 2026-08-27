import { useEffect, useMemo, useState } from 'react';
import { KINTALES_QUERY, type KinTaleEntry } from '../api/kinTales';
import { SESSIONS_QUERY, type SessionEntry } from '../api/sessions';
import { saveKinTaleDraft, sendKinTale, hasKinTaleContent, type KinTaleDraft } from '../api/kinTalesWrite';
import {
  KINTALE_TEMPLATES_QUERY,
  decodeKinTaleTemplate,
  pickTemplateForService,
  templateForDraft,
  templateIdForWire,
} from '../api/kinTaleTemplates';
import { getMediaFilesByIds, type MediaFile } from '../api/gallery';
import { getKin, type KinDetail } from '../api/kinView';
import { getKinfolkProfile, type KinfolkProfile } from '../api/kinfolkProfile';
import type { KinTaleTemplate } from '../lib/kinTale/model';
import {
  decodeFieldResponses,
  perPetChecklistRows,
  perVisitChecklistRows,
  setChecklistResponse,
  type ChecklistContext,
  type ChecklistRow,
} from '../lib/kinTaleChecklist';
import { kinTaleGpsBlock } from '../lib/kinTaleGps';
import { projectRoute } from '@tribetails/geo';
import { sessionState } from '../lib/sessionFormat';
import { useCollection } from '../lib/firestore';
import { DenScreenHeading, DenPanel, EmptyHint, ServicePill } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import { GenerateButton, type GeneratedDraft } from '../components/GenerateButton';
import { MediaUploadDialog } from '../components/MediaUploadDialog';
import { mediaCaption, mediaPreviewUrl } from '../lib/mediaFormat';
import { validateKinTaleDraft, type KinTaleDraftErrors } from '../lib/kinTaleDraftSchema';
import { useToast } from '../components/Toast';
import './KinTaleCompose.css';

/**
 * KinTale COMPOSE / EDIT, the create/edit surface `KinTales.tsx` deferred (its
 * own doc comment: "composing or editing a KinTale (KinTaleComposeScreen) ...
 * separate, not-yet-built surface"). Ports the wasm's `KinTaleComposeScreen.kt`
 * and Android's `KinTaleReportScreen.kt`: title, recap body, the
 * household/session it belongs to, the TEMPLATE the recap is captured under,
 * the PER-ITEM CHECKLIST that template defines, the PHOTO strip, the visit's
 * GPS route, save-draft and send-with-confirm.
 *
 * STILL OUT OF SCOPE HERE, and living on other surfaces rather than cut: the
 * comment thread and the share link (`KinTaleDetail.tsx`, the read view);
 * authoring a template (`KinTaleTemplates.tsx`, which the template block links
 * to). Per-pet mood chips and custom `form_schemas` answers are READ on the web
 * (`KinTaleDetail.tsx` renders both, issue #397 item 5) but are still AUTHORED
 * only on Android and the desktop console; `saveKinTaleDraft`'s `{ merge: true }`
 * preserves rather than erases them when another platform wrote them, which is
 * why this screen can leave them alone safely.
 *
 * TWO ENTRY MODES, mirroring how a real KinTale always starts:
 *  - EDIT: `kinTaleId` given. Loads the existing `kin_care_reports` row (off
 *    the same bounded `KINTALES_QUERY` stream `KinTales.tsx` already uses, so
 *    this screen opens no second listener class) and lets the auntie revise
 *    it.
 *  - NEW: `sessionId` given (or picked inline, see `SessionPicker` below).
 *    Scaffolds a blank draft off the parent `kin_care_sessions` row and the
 *    template that session's service type resolves to, mirroring the wasm's
 *    `scaffoldReport(session, template)`. A template supplies the checklist and
 *    the section flags, never the words: neither Kotlin composer prefills title
 *    or body from one, and a template's `defaultEmailMessage` is preview-only
 *    there (`KinTaleComposeScreen.kt:1051`), so both start blank here too.
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
 *
 * THE CHECKLIST AND THE M18 RULING. Issue #397's operator ruling of 2026-08-23
 * says a household must see an item deliberately left undone as UNTICKED rather
 * than not at all, and that the fix is to port the template condition engine to
 * the portal, NOT to stamp a resolved item list onto the report at send time.
 * That shortcut was offered and declined. This screen stamps no such list. What
 * it does write is the two things the ruling's fix needs to read: a real
 * `templateId`, so the portal can re-resolve this report's own items and
 * conditions, and an explicit `boolValue: false` on untick rather than a deleted
 * entry. See `lib/kinTaleChecklist.ts` for the full argument.
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
 * Scaffold a blank new draft off the session it will belong to and the template
 * that session resolves to. Mirrors the wasm's `scaffoldReport(session,
 * template)`.
 *
 * Every read is defaulted because `SessionEntry` is a CAST over raw Firestore
 * data, not a validation of it: `serviceType` is absent on 76 of the 99 live
 * `kin_care_sessions`. An undefined leaking into `KinTaleDraft` here would not
 * just blank the compose screen, it would be WRITTEN BACK to the report doc by
 * `saveKinTaleDraft`, so the default has to happen at the read.
 *
 * The template contributes exactly ONE field, `templateId`, and only after
 * `templateIdForWire` strips the built-in sentinel to `''`. It does not touch
 * `title` or `bodyCopy`: neither Kotlin composer prefills those from a template
 * either, and doing so would put a canned message where the story of this visit
 * belongs.
 */
export function scaffoldKinTaleDraft(session: SessionEntry, template: KinTaleTemplate): KinTaleDraft {
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
    templateId: templateIdForWire(template),
    fieldResponses: {},
  };
}

/**
 * Rehydrate an editable draft off an already-streamed `KinTaleEntry` row.
 * Defaulted for the same reason as `scaffoldKinTaleDraft` above.
 *
 * `templateId` is taken from the DOCUMENT, never re-resolved from the service
 * type, so reopening a draft rebuilds the checklist the operator actually
 * ticked; `api/kinTaleTemplates.ts#templateForDraft` spells out what
 * re-resolving would cost. `fieldResponses` goes through
 * `decodeFieldResponses` because it is a nested shape a cast would promise
 * without checking.
 */
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
    templateId: report.templateId ?? '',
    fieldResponses: decodeFieldResponses(report.fieldResponses),
  };
}

/**
 * Load the kin and household a checklist condition evaluates against.
 *
 * ONE-SHOT reads, not listeners: the answer only changes when a pet's record is
 * edited elsewhere mid-compose, and a live listener per kin would open a
 * listener class this screen deliberately avoids opening.
 *
 * FAIL-SOFT per kin, unlike `getKin`'s own contract. `getKin` throws on a
 * missing doc because a kin is only ever opened from an existing Directory card;
 * here the ids come from a session's denormalized `kinIds`, where a pet that has
 * since been deleted is an ordinary state. One unreadable kin costs that kin's
 * rows, never the composer. The same goes for the household: without it the
 * KINFOLK_* condition sources read blank, which the engine already handles.
 */
function useChecklistContext(draft: KinTaleDraft | null): ChecklistContext {
  const kinIdsKey = draft ? draft.kinIds.join(',') : '';
  const kinfolkId = draft?.kinfolkId ?? '';
  const serviceType = draft?.serviceType ?? '';

  const [kinList, setKinList] = useState<KinDetail[]>([]);
  const [kinfolk, setKinfolk] = useState<KinfolkProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ids = kinIdsKey === '' ? [] : kinIdsKey.split(',');
    if (ids.length === 0) {
      setKinList([]);
      return;
    }
    void Promise.all(ids.map((id) => getKin(id).catch(() => null))).then((loaded) => {
      if (cancelled) return;
      setKinList(loaded.filter((k): k is KinDetail => k !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [kinIdsKey]);

  useEffect(() => {
    let cancelled = false;
    if (kinfolkId === '') {
      setKinfolk(null);
      return;
    }
    void getKinfolkProfile(kinfolkId)
      .catch(() => null)
      .then((p) => {
        if (!cancelled) setKinfolk(p);
      });
    return () => {
      cancelled = true;
    };
  }, [kinfolkId]);

  return useMemo(
    () => ({ session: { serviceType }, kinList, kinfolk }),
    [serviceType, kinList, kinfolk],
  );
}

/**
 * The `media_files` docs behind a draft's `mediaFileIds`, refreshed whenever
 * that list changes. Reading by id rather than by session is argued in
 * `api/gallery.ts#getMediaFilesByIds`.
 *
 * A failed read leaves the strip empty rather than raising a banner: the ids are
 * still on the draft and still send correctly, so a thumbnail that will not load
 * is not worth telling the operator their tale is broken. The upload path's own
 * failures DO surface, in the dialog that owns them.
 */
function useAttachedMedia(mediaFileIds: readonly string[]): MediaFile[] {
  const key = mediaFileIds.join(',');
  const [media, setMedia] = useState<MediaFile[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) {
      setMedia([]);
      return;
    }
    void getMediaFilesByIds(ids)
      .catch(() => [])
      .then((rows) => {
        if (!cancelled) setMedia(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return media;
}

type Banner_ = { tone: 'error' | 'success' | 'info'; text: string };

/**
 * One sentence for "this draft has nothing in it yet", named once so the empty
 * banner, the save refusal and the send refusal cannot drift apart and list
 * different ways to fill it in. It enumerates every input `hasKinTaleContent`
 * actually counts, ticking a moment included.
 */
const NOTHING_YET_HINT = 'Nothing here yet. Add a headline, some notes, a photo, or tick a moment.';

export function KinTaleCompose({ kinTaleId, sessionId, kinfolkId, onClose }: KinTaleComposeProps) {
  const reports = useCollection<KinTaleEntry>(KINTALES_QUERY);
  const sessions = useCollection<SessionEntry>(SESSIONS_QUERY);
  /**
   * The Den's KinTale templates. Streamed rather than fetched because
   * `KinTaleTemplates.tsx` already subscribes to the same bounded query, so an
   * operator who edits a template in another tab sees this screen's checklist
   * follow, and because `useCollection` is where the sandbox scoping and the
   * bounded-listener discipline live.
   */
  const templateRows = useCollection<Record<string, unknown>>(KINTALE_TEMPLATES_QUERY);
  const templates = useMemo(
    () => (templateRows.status === 'ready' ? templateRows.data.map(decodeKinTaleTemplate) : []),
    [templateRows],
  );
  /**
   * Templates are OPTIONAL to compose against, so a screen must not sit at
   * "Loading…" waiting for them: the built-in default is a complete answer, and
   * `pickTemplateForService` returns it when the list is empty. This flag only
   * gates the moment of SCAFFOLDING, where reading an empty list too early
   * would stamp `templateId: ''` on a draft that should have carried a real id.
   */
  const templatesSettled = templateRows.status === 'ready' || templateRows.status === 'error';

  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const effectiveSessionId = sessionId ?? pickedSessionId;

  const [draft, setDraft] = useState<KinTaleDraft | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [banner, setBanner] = useState<Banner_ | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const { showToast } = useToast();

  /**
   * The template this draft is composed against. Resolved from the draft's own
   * stored `templateId` once a draft exists, which covers both modes: a
   * scaffolded draft already carries the id `pickTemplateForService` chose, and
   * a reopened one carries the id it was saved with. Deriving it in one place
   * means the block the operator reads and the checklist they tick can never
   * disagree.
   */
  const template = useMemo(
    () => (draft ? templateForDraft(templates, draft.templateId) : null),
    [templates, draft],
  );
  const checklistCtx = useChecklistContext(draft);
  const attachedMedia = useAttachedMedia(draft?.mediaFileIds ?? []);
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
      // Scaffolding waits for the template list to SETTLE, because the
      // `templateId` it stamps is written to Firestore on the first save and
      // never re-derived afterwards. Scaffolding against a still-loading list
      // would silently pin the draft to the built-in default forever. An ERROR
      // settles it too: the built-in default is then the honest answer, and
      // refusing to let the operator write a recap because a template listener
      // failed would be the worse trade.
      if (!templatesSettled) return;
      const found = sessions.data.find((s) => s._id === effectiveSessionId);
      if (found) {
        setDraft(scaffoldKinTaleDraft(found, pickTemplateForService(templates, found.serviceType ?? '')));
        setHydrated(true);
      }
    }
  }, [kinTaleId, effectiveSessionId, hydrated, reports, sessions, templates, templatesSettled]);

  /** Tick or untick one checklist row. Persists immediately, mirroring the desktop's `setChecklistChecked`, which saves on every toggle rather than waiting for a debounce. */
  function handleChecklistToggle(fieldKey: string, kinId: string, checked: boolean) {
    setDraft((d) => (d ? { ...d, fieldResponses: setChecklistResponse(d.fieldResponses, fieldKey, kinId, checked) } : d));
  }

  /**
   * Attach a freshly-uploaded photo. Appends, and de-duplicates defensively:
   * the id came straight from an `addDoc`, so a repeat is not expected, but a
   * duplicated id in `mediaFileIds` would render the same photo twice and count
   * twice against nothing.
   */
  function handleMediaUploaded(mediaFileId: string) {
    setUploadOpen(false);
    if (mediaFileId.trim() === '') return;
    setDraft((d) =>
      d && !d.mediaFileIds.includes(mediaFileId)
        ? { ...d, mediaFileIds: [...d.mediaFileIds, mediaFileId] }
        : d,
    );
    showToast('Photo attached. Save the draft to keep it.');
  }

  /**
   * Detach a photo from this tale. Filters the id out of `mediaFileIds` and
   * deliberately does NOT delete the `media_files` doc, matching Android's
   * `removeMedia` (`KinTaleReportViewModel.kt:674-682`): the photo was uploaded
   * to the Den's gallery and removing it from one recap is not a request to
   * destroy it. Deleting a photo is the Gallery's own affordance.
   */
  function handleMediaRemove(mediaFileId: string) {
    setDraft((d) => (d ? { ...d, mediaFileIds: d.mediaFileIds.filter((id) => id !== mediaFileId) } : d));
  }

  async function handleSaveDraft() {
    if (!draft || isSaving || isSending) return;
    setIsSaving(true);
    setBanner(null);
    try {
      const id = await saveKinTaleDraft(draft);
      setIsSaving(false);
      if (id === null) {
        setBanner({ tone: 'info', text: NOTHING_YET_HINT });
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
        setBanner({ tone: 'error', text: NOTHING_YET_HINT });
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

  /**
   * The parent visit, for the GPS block. Found on the sessions stream this
   * screen already holds rather than fetched, and looked up by the DRAFT's
   * `sessionId` so it resolves in edit mode too, where `effectiveSessionId` is
   * undefined. Absent when the visit predates the stream's cap or the draft has
   * no session, and the block simply does not render.
   */
  const parentSession =
    draft && sessions.status === 'ready'
      ? (sessions.data.find((s) => s._id === draft.sessionId) ?? null)
      : null;

  /**
   * Everything both entry modes hand `ComposeForm`, built once. The two modes
   * differ only in which stream they wait on, never in what the form does, and
   * spelling the props out twice is how the `kinfolkId` prop went missing until
   * #552.
   *
   * ALSO GATED ON `templatesSettled`, which matters most in EDIT mode. A
   * reopened draft hydrates off the reports stream alone, so without this gate
   * the form would render for the moment before the template list arrives, and
   * `templateForDraft` over an empty list returns the built-in. A tick landed in
   * that window would be keyed against the BUILT-IN's item list rather than the
   * draft's real template, and the portal drops a key the resolved template does
   * not contain. Scaffolding is gated for the same reason in the hydration
   * effect above; this closes the read side of it.
   */
  const formProps = draft && templatesSettled
    ? {
        draft,
        template,
        checklistCtx,
        attachedMedia,
        gps: kinTaleGpsBlock(parentSession?.gpsSummary),
        onTitleChange: (v: string) =>
          setDraft((d) => (d ? { ...d, title: v, titleGeneratedByAi: false } : d)),
        onBodyChange: (v: string) => setDraft((d) => (d ? { ...d, bodyCopy: v } : d)),
        onChecklistToggle: handleChecklistToggle,
        onOpenUpload: () => setUploadOpen(true),
        onRemoveMedia: handleMediaRemove,
        onGenerated: applyGenerated,
        onGenerateError: (text: string) => setBanner({ tone: 'error' as const, text }),
        isSaving,
        isSending,
        banner,
        confirmSend,
        onSaveDraft: () => void handleSaveDraft(),
        onOpenSendConfirm: () => setConfirmSend(true),
        onCancelSendConfirm: () => setConfirmSend(false),
        onConfirmSend: () => void handleConfirmSend(),
      }
    : null;

  /**
   * The photo picker, rendered once beside whichever branch is on screen. It is
   * `MediaUploadDialog` with a FIXED target rather than a second uploader: the
   * signing, the 50MB and mime-type refusals, the per-stage progress and, most
   * importantly, the signed `fl_force_strip` transformation from #583 all live
   * in that one pipeline, and a KinTale-only copy of it would be a second place
   * for the metadata strip to be forgotten.
   */
  const uploadDialog =
    uploadOpen && draft ? (
      <MediaUploadDialog
        fixedTarget={{ entityType: 'VISIT_LOG', entityId: draft.sessionId, label: 'this visit' }}
        onClose={() => setUploadOpen(false)}
        onUploaded={handleMediaUploaded}
      />
    ) : null;

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
            return formProps ? (
              <>
                <ComposeForm {...formProps} />
                {uploadDialog}
              </>
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
            return formProps ? (
              <>
                <ComposeForm {...formProps} />
                {uploadDialog}
              </>
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
  /** The resolved template, or null while the draft has not hydrated. */
  template: KinTaleTemplate | null;
  checklistCtx: ChecklistContext;
  attachedMedia: MediaFile[];
  gps: ReturnType<typeof kinTaleGpsBlock>;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onChecklistToggle: (fieldKey: string, kinId: string, checked: boolean) => void;
  onOpenUpload: () => void;
  onRemoveMedia: (mediaFileId: string) => void;
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
  template,
  checklistCtx,
  attachedMedia,
  gps,
  onTitleChange,
  onBodyChange,
  onChecklistToggle,
  onOpenUpload,
  onRemoveMedia,
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
          {/*
            WHICH TEMPLATE, named rather than assumed. It decides which moments
            the operator is offered below, so a checklist that looks wrong for
            the visit is explained by this row rather than being a mystery. It is
            shown, not chosen: both Kotlin composers resolve the template from
            the service type and offer no override, and the way to change what a
            Dog Walk asks for is to edit the Dog Walk template, which is a
            durable fix rather than a per-tale one.
          */}
          <div className="kintale-compose__meta-row">
            <dt>Template</dt>
            <dd>
              {template === null ? (
                'Resolving…'
              ) : (
                <>
                  {template.name || 'Untitled template'}
                  {draft.templateId === '' && (
                    <span className="kintale-compose__provenance">
                      {' '}
                      Built in. Nothing in the Template Bank matches
                      {draft.serviceType ? ` ${draft.serviceType}` : ' this visit'} yet.
                    </span>
                  )}
                </>
              )}
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

      {template && (
        <>
          <ChecklistBlock
            template={template}
            ctx={checklistCtx}
            draft={draft}
            onToggle={onChecklistToggle}
            disabled={isSending}
          />
          {template.photoShowcaseEnabled && (
            <PhotoBlock
              draft={draft}
              attached={attachedMedia}
              onOpenUpload={onOpenUpload}
              onRemove={onRemoveMedia}
              disabled={isSaving || isSending}
            />
          )}
        </>
      )}

      <GpsBlock gps={gps} />

      {!contentReady && !banner && <Banner tone="info">{NOTHING_YET_HINT}</Banner>}
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
// ── moments: the per-item checklist ─────────────────────────────────────────
interface ChecklistBlockProps {
  template: KinTaleTemplate;
  ctx: ChecklistContext;
  draft: KinTaleDraft;
  onToggle: (fieldKey: string, kinId: string, checked: boolean) => void;
  disabled: boolean;
}
/**
 * "Moments": the template's checklist, rendered per kin and once for the visit,
 * as tap-to-toggle chips. Ports the Kotlin composers' `MomentsBlock` /
 * `ChecklistCheckPill` sections.
 *
 * WHICH ITEMS APPEAR is the condition engine's answer, not this component's:
 * a per-pet item only appears on the kin it applies to, so the cat's litter box
 * is never asked about on the dog's row. `lib/kinTaleChecklist.ts` holds that
 * logic and is tested directly.
 *
 * `required` is rendered as a mark and enforces NOTHING, matching both
 * platforms exactly (the desktop appends " *", `KinTaleComposeScreen.kt:890`;
 * neither `send()` path consults the flag). Blocking a send on an unticked
 * "required" moment would be a new rule invented on one platform, and the
 * operator has never been asked for it.
 *
 * The block renders nothing at all when the template has the checklist off, or
 * when no item survives its conditions. An empty panel headed "Moments" tells
 * the operator a feature is broken when it is in fact working.
 */
function ChecklistBlock({ template, ctx, draft, onToggle, disabled }: ChecklistBlockProps) {
  if (!template.checklistEnabled) return null;
  const perVisit = perVisitChecklistRows(template, ctx, draft.fieldResponses);
  const perKin = ctx.kinList.map((kin) => ({
    kin,
    rows: perPetChecklistRows(template, kin, ctx, draft.fieldResponses),
  }));
  const anyRows = perVisit.length > 0 || perKin.some((g) => g.rows.length > 0);
  if (!anyRows) return null;
  return (
    <DenPanel title="Moments" subtitle="Tick what happened. Only what you tick is a claim.">
      {perKin.map(
        ({ kin, rows }) =>
          rows.length > 0 && (
            <fieldset key={kin._id} className="kintale-compose__moments" disabled={disabled}>
              <legend className="kintale-compose__moments-legend">{kin.name || 'This Kin'}</legend>
              <ChecklistChips rows={rows} onToggle={onToggle} />
            </fieldset>
          ),
      )}
      {perVisit.length > 0 && (
        <fieldset className="kintale-compose__moments" disabled={disabled}>
          <legend className="kintale-compose__moments-legend">The visit</legend>
          <ChecklistChips rows={perVisit} onToggle={onToggle} />
        </fieldset>
      )}
    </DenPanel>
  );
}
/**
 * The chips themselves. Real `<input type="checkbox">` elements rather than
 * styled buttons: a checkbox carries its own checked state to a screen reader
 * and to a test, where `aria-pressed` on a button has to be maintained by hand
 * and silently rots.
 */
function ChecklistChips({
  rows,
  onToggle,
}: {
  rows: ChecklistRow[];
  onToggle: (fieldKey: string, kinId: string, checked: boolean) => void;
}) {
  return (
    <ul className="kintale-compose__chips">
      {rows.map((row) => (
        <li key={row.key}>
          <label className="kintale-compose__chip">
            <input
              type="checkbox"
              checked={row.checked}
              onChange={(e) => onToggle(row.item.key, row.kinId, e.target.checked)}
            />
            <span>
              {row.item.text || row.item.key}
              {row.item.required && <span aria-hidden="true"> *</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
// ── photos ──────────────────────────────────────────────────────────────────
interface PhotoBlockProps {
  draft: KinTaleDraft;
  attached: MediaFile[];
  onOpenUpload: () => void;
  onRemove: (mediaFileId: string) => void;
  disabled: boolean;
}
/**
 * The photo strip. Adding goes through `MediaUploadDialog` (opened by the
 * parent), so this component only shows what is attached and offers to detach
 * it.
 *
 * REMOVE means detach, never delete, and the copy says so. Android behaves the
 * same way (`removeMedia` filters `mediaFileIds` and leaves the `media_files`
 * doc alone); the desktop soft-deletes the doc as well, which quietly destroys
 * a gallery photo because someone changed their mind about one recap.
 *
 * A thumbnail that will not resolve renders its caption alone rather than a
 * broken-image glyph, the pattern `BrandLogo.tsx` established.
 */
function PhotoBlock({ draft, attached, onOpenUpload, onRemove, disabled }: PhotoBlockProps) {
  // `attached` is loaded asynchronously from the ids, so during that window the
  // draft holds more ids than there are rows. Counting the IDS keeps the header
  // honest about what will actually be sent.
  const count = draft.mediaFileIds.length;
  return (
    <DenPanel
      title="Photos"
      subtitle={count === 0 ? 'Nothing attached yet.' : `${count} attached to this tale.`}
    >
      <ul className="kintale-compose__photos">
        {attached.map((media) => {
          const preview = mediaPreviewUrl(media);
          return (
            <li key={media._id} className="kintale-compose__photo">
              {preview !== undefined && (
                <img src={preview} alt={mediaCaption(media)} className="kintale-compose__photo-img" />
              )}
              <span className="kintale-compose__photo-caption">{mediaCaption(media)}</span>
              <GhostButton
                label="Remove from tale"
                onClick={() => onRemove(media._id)}
                disabled={disabled}
              />
            </li>
          );
        })}
      </ul>
      <GhostButton label="Add a photo" onClick={onOpenUpload} disabled={disabled} />
    </DenPanel>
  );
}
// ── GPS ─────────────────────────────────────────────────────────────────────
const GPS_WIDTH = 400;
const GPS_HEIGHT = 160;
/**
 * The visit's GPS route, read off the parent session and drawn as a plain SVG
 * polyline through `@tribetails/geo`'s `projectRoute`, the same shared math the
 * portal's own map falls back to. No map SDK: `mapbox-gl` is a portal
 * dependency, and pulling a tile renderer into the admin bundle to show a
 * captured trail the operator was present for would be a poor trade.
 *
 * READ-ONLY, matching both Kotlin composers. `lib/kinTaleGps.ts` documents what
 * that means for the household, and why writing coordinates onto the report is
 * an operator decision rather than a parity gap to close quietly.
 *
 * Renders nothing when there is no usable route, exactly as the desktop's
 * `GpsRouteBlock` returns early on empty breadcrumbs. Most visits have no GPS.
 */
function GpsBlock({ gps }: { gps: ReturnType<typeof kinTaleGpsBlock> }) {
  if (gps === null) return null;
  const points = projectRoute(gps.route, GPS_WIDTH, GPS_HEIGHT);
  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <DenPanel title="Visit route" subtitle="Captured by the phone while the visit was happening.">
      <svg
        className="kintale-compose__route"
        viewBox={`0 0 ${GPS_WIDTH} ${GPS_HEIGHT}`}
        role="img"
        aria-label={`Route of ${gps.distanceLabel} over ${gps.durationLabel}`}
      >
        <polyline points={path} fill="none" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        {points[0] && <circle cx={points[0].x} cy={points[0].y} r={5} className="kintale-compose__route-start" />}
        {last && <circle cx={last.x} cy={last.y} r={5} className="kintale-compose__route-end" />}
      </svg>
      <dl className="kintale-compose__meta">
        <div className="kintale-compose__meta-row">
          <dt>Distance</dt>
          <dd>{gps.distanceLabel}</dd>
        </div>
        <div className="kintale-compose__meta-row">
          <dt>Duration</dt>
          <dd>{gps.durationLabel}</dd>
        </div>
      </dl>
    </DenPanel>
  );
}
