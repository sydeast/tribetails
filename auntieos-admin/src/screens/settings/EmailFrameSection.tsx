import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getEmailFrame,
  saveEmailFrame,
  resetEmailFrame,
  EMAIL_FRAME_COLOR_FIELDS,
  FOOTER_TEXT_MAX,
  HEADER_TEXT_MAX,
  type EmailFrameColorField,
  type EmailFrameField,
  type EmailFrameState,
} from '../../api/emailFrame';
import { uploadEmailImage } from '../../api/emailImageUpload';
import type { UploadStage } from '../../api/mediaUpload';
import { type Async } from '../../lib/async';
import { draftFrom, draftFrame, draftProblems, frameChanges, type EmailFrameDraft } from '../../lib/emailFrameDraft';
import { useEmailFramePreview } from '../../lib/useEmailFramePreview';
import { useSlowWait } from '../../lib/slowWait';
import { lastSavedLabel } from '../../lib/settingsFormat';
import { AsyncRegion } from '../../components/AsyncRegion';
import { LoadingRow } from '../../components/LoadingRow';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Dialog } from '../../components/Dialog';
import { SlowWaitNotice } from '../../components/SlowWaitNotice';
import { EmailPreviewPane } from '../../components/emailEditor/EmailPreviewPane';
import '../SettingsEdit.css';
import './EmailFrameSection.css';

/**
 * #957: the shared frame every visual email is sent in (colors, a header line,
 * a logo, the footer line), edited here instead of in a PR.
 * Spec: docs/superpowers/specs/2026-09-28-email-frame-editor-design.md
 *
 * SELF-LOADING, like Tags and Integrations: the frame is its own server-only
 * document behind `getEmailFrame`, not a field on the settings document the
 * rest of this screen shares.
 *
 * DEFAULTS ARE HINTS. A blank field is the default, shown as its placeholder
 * or as the color its swatch displays, and never sent. Save sends only what
 * changed. Reset to default clears every field after a confirm.
 *
 * THE PREVIEW IS THE SERVER'S. `previewEmailFrame` renders a sample email
 * with the real frame code, so what shows here is what an inbox gets.
 */

const COLOR_LABELS: Record<EmailFrameColorField, { label: string; tip: string }> = {
  accentColor: { label: 'Accent', tip: 'The top bar, buttons and the edge of a callout' },
  headlineColor: { label: 'Headline', tip: 'The headline at the top of each email' },
  textColor: { label: 'Text', tip: 'The body text' },
  buttonTextColor: { label: 'Button text', tip: 'The words on a button' },
  pageBackground: { label: 'Page', tip: 'Behind the email card' },
  cardBackground: { label: 'Card', tip: 'The email card itself' },
  calloutBackground: { label: 'Callout', tip: 'Behind a callout block' },
  footerBackground: { label: 'Footer', tip: 'The footer band and the bottom edge' },
  footerTextColor: { label: 'Footer text', tip: 'The footer line' },
};

function uploadStageLabel(stage: UploadStage): string {
  switch (stage) {
    case 'signing':
      return 'Getting ready to upload…';
    case 'uploading':
      return 'Uploading…';
    case 'saving':
      return 'Adding it to the library…';
  }
}

export function EmailFrameSection() {
  const [state, setState] = useState<Async<EmailFrameState>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    getEmailFrame()
      .then((data) => live && setState({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setState({
            status: 'error',
            message: `Couldn't read the email frame: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <AsyncRegion
      state={state}
      what="the email frame"
      isEmpty={() => false}
      loading={<LoadingRow label="Loading the email frame…" className="settings__hint" />}
      empty={null}
    >
      {(data) => <EmailFrameEditor loaded={data} onSaved={(next) => setState({ status: 'ready', data: next })} />}
    </AsyncRegion>
  );
}

interface EditorProps {
  loaded: EmailFrameState;
  onSaved: (next: EmailFrameState) => void;
}

export function EmailFrameEditor({ loaded, onSaved }: EditorProps) {
  const [draft, setDraft] = useState<EmailFrameDraft>(() => draftFrom(loaded.stored));
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastRequest = useRef<(() => void) | null>(null);

  const problems = useMemo(() => draftProblems(draft), [draft]);
  const hasProblems = Object.keys(problems).length > 0;
  const changes = useMemo(() => frameChanges(draft, loaded.stored), [draft, loaded.stored]);
  const dirty = Object.keys(changes).length > 0;
  const storedAnything = Object.keys(loaded.stored).length > 0;

  const previewFrame = useMemo(() => (hasProblems ? null : draftFrame(draft)), [draft, hasProblems]);
  const preview = useEmailFramePreview(previewFrame);

  // D-2026-09-12-SLOW-WAIT: a save that runs long offers to ask again. Both
  // writes are safe to repeat: a patch of the same values, or a reset, lands
  // on the same document the second time.
  const wait = useSlowWait(busy !== null, () => lastRequest.current?.());

  function edit(field: EmailFrameField, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    setSavedNote(null);
  }

  async function run(kind: 'save' | 'reset', request: () => Promise<EmailFrameState>) {
    setBusy(kind);
    setError(null);
    setSavedNote(null);
    const attempt = async () => {
      try {
        const next = await request();
        setDraft(draftFrom(next.stored));
        onSaved(next);
        setSavedNote(kind === 'reset' ? 'Back to the default frame.' : 'Saved. The next email sent uses it.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed.');
      } finally {
        setBusy(null);
      }
    };
    lastRequest.current = () => void attempt();
    await attempt();
  }

  function handleSave() {
    if (!dirty || busy || hasProblems) return;
    const patch = changes;
    void run('save', () => saveEmailFrame(patch));
  }

  function handleReset() {
    setConfirmReset(false);
    void run('reset', () => resetEmailFrame());
  }

  async function handleLogoFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    try {
      const url = await uploadEmailImage(file, setUploadStage);
      edit('logoUrl', url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setUploadStage(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const effective = (f: EmailFrameField) => draft[f] || loaded.defaults[f];
  const logo = draft.logoUrl;
  const disabled = busy !== null;

  return (
    <DenPanel
      title="Email frame"
      subtitle="The colors, header, logo and footer every email is sent in. Changes reach the next email sent."
      detail={loaded.updatedAt ? lastSavedLabel(loaded.updatedAt, loaded.updatedBy ?? '') : 'Using the default frame'}
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <div className="emailFrame__layout">
        <div className="emailFrame__fields">
          <div className="settingsEdit__subsection">
            <span className="settingsEdit__groupHeading">Colors</span>
            <ul className="emailFrame__colors">
              {EMAIL_FRAME_COLOR_FIELDS.map((f) => {
                const { label, tip } = COLOR_LABELS[f];
                const set = draft[f] !== '';
                const problem = problems[f];
                return (
                  <li key={f} className="emailFrame__colorRow" title={tip}>
                    <input
                      type="color"
                      className="emailFrame__swatch"
                      aria-label={`${label} color`}
                      value={problem ? loaded.defaults[f] : effective(f).toLowerCase()}
                      disabled={disabled}
                      onChange={(e) => edit(f, e.target.value)}
                    />
                    <span className="emailFrame__colorLabel">{label}</span>
                    <input
                      type="text"
                      className="settingsEdit__input emailFrame__hex"
                      aria-label={`${label} hex`}
                      aria-invalid={problem ? true : undefined}
                      value={draft[f]}
                      placeholder={loaded.defaults[f]}
                      maxLength={7}
                      disabled={disabled}
                      onChange={(e) => edit(f, e.target.value)}
                    />
                    {set ? (
                      <GhostButton label="Default" disabled={disabled} onClick={() => edit(f, '')} />
                    ) : null}
                    {problem ? (
                      <span className="emailFrame__problem" role="alert">
                        {problem}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="settingsEdit__subsection">
            <span className="settingsEdit__groupHeading">Header</span>
            <div className="settingsEdit__fields">
              <div className="settingsEdit__fieldGroup">
                <span className="settingsEdit__fieldLabel">Logo</span>
                <div className="emailFrame__logoRow">
                  {logo ? <img className="emailFrame__logo" src={logo} alt="Email logo" /> : <span className="settingsEdit__hint">No logo</span>}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="emailFrame__file"
                    aria-label="Choose a logo image"
                    disabled={disabled || uploadStage !== null}
                    onChange={(e) => void handleLogoFile(e.target.files?.[0])}
                  />
                  <GhostButton
                    label={logo ? 'Replace logo' : 'Upload logo'}
                    disabled={disabled || uploadStage !== null}
                    onClick={() => fileInput.current?.click()}
                  />
                  {logo ? <GhostButton label="Remove" disabled={disabled} onClick={() => edit('logoUrl', '')} /> : null}
                </div>
                {uploadStage ? <LoadingRow label={uploadStageLabel(uploadStage)} className="settingsEdit__hint" /> : null}
                {uploadError ? (
                  <span className="emailFrame__problem" role="alert">
                    {uploadError}
                  </span>
                ) : null}
              </div>
              <label className="settingsEdit__field">
                <span className="settingsEdit__fieldLabel">Header line</span>
                <input
                  type="text"
                  className="settingsEdit__input"
                  value={draft.headerText}
                  placeholder="None"
                  maxLength={HEADER_TEXT_MAX}
                  aria-invalid={problems.headerText ? true : undefined}
                  disabled={disabled}
                  onChange={(e) => edit('headerText', e.target.value)}
                />
              </label>
              {problems.headerText ? (
                <span className="emailFrame__problem" role="alert">
                  {problems.headerText}
                </span>
              ) : null}
            </div>
          </div>

          <div className="settingsEdit__subsection">
            <span className="settingsEdit__groupHeading">Footer</span>
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Footer line</span>
              <input
                type="text"
                className="settingsEdit__input"
                value={draft.footerText}
                placeholder={loaded.defaults.footerText}
                maxLength={FOOTER_TEXT_MAX}
                aria-invalid={problems.footerText ? true : undefined}
                disabled={disabled}
                onChange={(e) => edit('footerText', e.target.value)}
              />
            </label>
            {problems.footerText ? (
              <span className="emailFrame__problem" role="alert">
                {problems.footerText}
              </span>
            ) : null}
          </div>
        </div>

        <EmailPreviewPane state={preview.state} onRetry={preview.retry} />
      </div>

      {busy && wait.phase === 'slow' ? (
        <SlowWaitNotice what="the email frame" attempt={wait.attempt} onSync={wait.sync} />
      ) : null}

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Reset to default"
          disabled={disabled || !storedAnything}
          onClick={() => setConfirmReset(true)}
        />
        <GhostButton
          label="Cancel"
          disabled={disabled || !dirty}
          onClick={() => {
            setDraft(draftFrom(loaded.stored));
            setError(null);
          }}
        />
        <PrimaryButton
          label={busy === 'save' ? 'Saving…' : busy === 'reset' ? 'Resetting…' : 'Save'}
          busy={busy !== null}
          disabled={!dirty || hasProblems || busy !== null}
          onClick={handleSave}
        />
      </div>
      {savedNote ? (
        <p className="settingsEdit__savedNote" role="status">
          {savedNote}
        </p>
      ) : null}

      {confirmReset ? (
        <Dialog
          title="Reset the email frame?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <GhostButton label="Keep my frame" onClick={() => setConfirmReset(false)} />
              <PrimaryButton label="Reset" onClick={handleReset} />
            </>
          }
        >
          <p>Every color, the header, the logo and the footer go back to the default. The next email sent uses it.</p>
        </Dialog>
      ) : null}
    </DenPanel>
  );
}
