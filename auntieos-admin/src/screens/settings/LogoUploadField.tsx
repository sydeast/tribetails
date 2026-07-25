import { useId, useRef, useState } from 'react';
import {
  uploadBrandAsset,
  removeBrandAsset,
  type BrandAssetKind,
  type BrandUploadStage,
  type ConfirmBrandAssetResult,
} from '../../api/brandAsset';
import { type ImageDecoder } from '../../lib/brandAssetFile';
import { logoStateLabel } from '../../lib/settingsFormat';
import { Banner } from '../../components/Banner';
import { GhostButton } from '../../components/Buttons';
import './LogoUploadField.css';

/**
 * The real logo upload, replacing the free-text "Logo URL" box that stood in
 * for it on both admin surfaces since the port. Used twice: once for the
 * operator's own brand mark (`businessLogo`) and once for the kinfolk portal's
 * header (`portalLogo`).
 *
 * It uploads on SELECTION rather than behind a second "Upload" click, matching
 * Android's picker flow, and it saves immediately rather than staging into the
 * panel's Save bar. That is a deliberate split from the text fields beside it:
 * the file has already left the browser and is sitting in Cloudinary by the
 * time the operator could press Save, so pretending it is an unsaved draft
 * would be a lie, and a Cancel that appeared to discard it would not.
 */

interface LogoUploadFieldProps {
  kind: BrandAssetKind;
  label: string;
  /** What this logo is FOR, in the operator's terms. These two logos are easy to confuse. */
  help: string;
  logoUrl: string;
  logoRemovedAt: string;
  /** Folds the server's confirmed result back into the screen's loaded settings. */
  onChanged: (result: ConfirmBrandAssetResult) => void;
  /**
   * `portal` previews the logo on the kinfolk portal's actual cream header
   * wash. A transparent logo drawn in white ink is invisible there, and no
   * validation can detect ink colour, so the honest fix is to show the operator
   * the real background BEFORE they save rather than warn them in prose.
   */
  preview: 'admin' | 'portal';
  /** Test seam, threaded to the pre-upload dimension check. */
  decode?: ImageDecoder;
}

function stageLabel(stage: BrandUploadStage): string {
  switch (stage) {
    case 'checking':
      return 'Checking the file…';
    case 'signing':
      return 'Requesting upload permission…';
    case 'uploading':
      return 'Uploading to Cloudinary…';
    case 'saving':
      return 'Saving…';
  }
}

export function LogoUploadField(props: LogoUploadFieldProps) {
  const [stage, setStage] = useState<BrandUploadStage | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const busy = stage !== null || removing;
  const hasLogo = props.logoUrl.trim() !== '';

  async function handleFile(file: File | null) {
    if (file === null || busy) return;
    setError(null);
    setImageFailed(false);
    try {
      const result = await uploadBrandAsset({
        kind: props.kind,
        file,
        onStage: setStage,
        ...(props.decode ? { decode: props.decode } : {}),
      });
      props.onChanged(result);
    } catch (err) {
      // Fail loud, and keep the existing logo exactly as it was: a rejected
      // upload must never look like a removal.
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setStage(null);
      // Or picking the same file again after a failure fires no change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleRemove() {
    if (busy) return;
    setRemoving(true);
    setError(null);
    try {
      props.onChanged(await removeBrandAsset(props.kind));
      setImageFailed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="logoField">
      <span className="settingsEdit__fieldLabel">{props.label}</span>

      {error !== null ? (
        <Banner tone="error" title="Logo not changed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <div className="logoField__row">
        <div
          className={props.preview === 'portal' ? 'logoField__plate logoField__plate--portal' : 'logoField__plate'}
        >
          {hasLogo && !imageFailed ? (
            <img
              className="logoField__img"
              src={props.logoUrl}
              alt={`${props.label} preview`}
              // A saved logo whose asset has since gone missing must read as a
              // stated problem, not as a broken-image glyph and not as "no logo
              // set", which would invite the operator to conclude the upload
              // never worked and re-do it.
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="logoField__glyph" aria-hidden="true">
              {'\u{1F43E}'}
            </span>
          )}
        </div>

        <div className="logoField__side">
          <p className="logoField__state">
            {imageFailed && hasLogo ? 'Saved, but this image will not load' : logoStateLabel(props.logoUrl, props.logoRemovedAt)}
          </p>
          <p className="settingsEdit__hint">{props.help}</p>

          {/* Input FIRST in the DOM so the visually-hidden control can hand its
              focus ring to the label that stands in for it (`:focus-visible + .logoField__pick`). */}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            className="logoField__input"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          />
          <label className="logoField__pick" htmlFor={inputId}>
            {hasLogo ? 'Replace logo' : 'Upload logo'}
          </label>

          {hasLogo ? (
            <GhostButton label="Remove logo" onClick={() => void handleRemove()} disabled={busy} />
          ) : null}
        </div>
      </div>

      {busy ? (
        <p className="logoField__stage" aria-live="polite">
          {removing ? 'Removing…' : stageLabel(stage!)}
        </p>
      ) : null}

      {imageFailed && hasLogo ? (
        <p className="settingsEdit__hint">
          The saved address still points at an image that is not loading. Upload a replacement, or remove it so
          the surface falls back to its built-in mark.
        </p>
      ) : null}

      <p className="settingsEdit__hint">
        Removing clears the logo from this app only. The uploaded file stays in Cloudinary, so a removal can be
        undone by uploading it again, and any copy already sent out keeps working.
      </p>
    </div>
  );
}
