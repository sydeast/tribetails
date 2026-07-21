import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import '../styles/signedImageUpload.css';

/**
 * Wire shape shared by every signed-Cloudinary-upload callable in this app
 * (functions/src/lib/cloudinary.ts's `CloudinarySignedUpload`, returned
 * verbatim by both signKinfolkAvatar and signKinPhotoUpload). Both existing
 * flows already return exactly this shape, so no per-call-site adapter is
 * needed for the sign step — only `confirm` (see below) varies.
 */
export interface SignedUploadParams {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  /** Signed server-side; must be echoed verbatim in the upload POST. */
  allowedFormats: string;
}

export interface SignedImageUploadProps {
  /** Requests fresh signed-upload params scoped to the caller's folder (e.g. signKinfolkAvatar, or a `() => signKinPhotoUpload(kinId, kinfolkId)` closure). */
  sign: () => Promise<SignedUploadParams>;
  /**
   * Client-side file check — pass an existing helper (validateAvatarFile,
   * validateKinPhotoFile) rather than reimplementing size/MIME rules here.
   * Return a user-facing message to reject the file, or null to proceed.
   */
  validate: (file: { size: number; type: string }) => string | null;
  /**
   * Optional finalize step for flows with a second, persisting callable
   * (e.g. confirmKinPhotoUpload) that must run after the Cloudinary POST.
   * Receives the Cloudinary secure_url and resolves the URL to treat as
   * final (normally the same value, echoed back after server-side
   * revalidation). Omit for flows like the avatar, where the secure_url IS
   * the final answer and persistence happens separately (the host screen's
   * own Save action) — this is a deliberate per-call-site adapter rather
   * than a one-size-shape, since the two backend flows only share the
   * sign+upload half, not the finalize half.
   */
  confirm?: (secureUrl: string) => Promise<string>;
  /** Called once sign -> upload -> (optional) confirm all succeed. */
  onUploaded: (url: string) => void;
  /** Called on every user-facing failure (validation, sign, network, server rejection), in addition to the inline message this component already renders. */
  onError?: (message: string) => void;
  /** Current image to preview; '' (or omitted) shows `fallback` instead. */
  imageUrl?: string;
  /** Enables the "Clear" action; omit to hide it entirely. */
  onClear?: () => void;
  /** Rendered inside the preview circle when there is no imageUrl. */
  fallback?: ReactNode;
  title?: string;
  subtitle?: string;
  pickLabel?: string;
  replaceLabel?: string;
  clearLabel?: string;
  accept?: string;
  disabled?: boolean;
  className?: string;
}

const DEFAULT_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number | null }
  | { kind: 'confirming' }
  | { kind: 'error'; message: string };

/**
 * XHR (not fetch) so upload progress is observable via `upload.onprogress` —
 * fetch has no cross-browser request-body progress event. Throws distinct,
 * user-facing errors for a network failure vs. a non-2xx/malformed response,
 * rather than collapsing both to null the way the older per-flow
 * uploadAvatarToCloudinary/uploadKinPhotoToCloudinary fetch helpers do.
 */
function uploadToCloudinary(
  signed: SignedUploadParams,
  file: File,
  onProgress: (pct: number | null) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('api_key', signed.apiKey);
    form.append('timestamp', String(signed.timestamp));
    form.append('signature', signed.signature);
    form.append('folder', signed.folder);
    if (signed.allowedFormats) form.append('allowed_formats', signed.allowedFormats);
    form.append('file', file, file.name || 'photo');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`);

    xhr.upload.onprogress = (e) => {
      onProgress(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
    };

    xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));

    xhr.onload = () => {
      type CloudinaryResponseBody = { secure_url?: string; error?: { message?: string } };
      let body: CloudinaryResponseBody | null;
      try {
        body = JSON.parse(xhr.responseText) as CloudinaryResponseBody;
      } catch {
        body = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(body?.error?.message || 'Upload failed, try again.'));
        return;
      }
      if (!body?.secure_url) {
        reject(new Error('Upload failed, try again.'));
        return;
      }
      resolve(body.secure_url);
    };

    xhr.send(form);
  });
}

/**
 * Generic signed-direct-to-Cloudinary image upload widget: file picker
 * (click or drag-drop) + client-side validation + upload progress + preview
 * + error surfacing, built once against the shape both signKinfolkAvatar and
 * signKinPhotoUpload already share. See `confirm` above for the one place
 * the two flows actually diverge.
 */
export function SignedImageUpload({
  sign,
  validate,
  confirm,
  onUploaded,
  onError,
  imageUrl,
  onClear,
  fallback,
  title,
  subtitle,
  pickLabel = 'Pick Photo',
  replaceLabel = 'Replace Photo',
  clearLabel = 'Clear',
  accept = DEFAULT_ACCEPT,
  disabled = false,
  className,
}: SignedImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragActive, setDragActive] = useState(false);
  const busy = phase.kind === 'uploading' || phase.kind === 'confirming';
  const hasImage = Boolean(imageUrl);

  async function processFile(file: File) {
    const problem = validate(file);
    if (problem) {
      setPhase({ kind: 'error', message: problem });
      onError?.(problem);
      return;
    }

    setPhase({ kind: 'uploading', progress: null });
    try {
      const signed = await sign();
      if (!signed.cloudName) {
        throw new Error("Photo uploads aren't available right now. Try again later.");
      }
      const secureUrl = await uploadToCloudinary(signed, file, (progress) => setPhase({ kind: 'uploading', progress }));

      let finalUrl = secureUrl;
      if (confirm) {
        setPhase({ kind: 'confirming' });
        finalUrl = await confirm(secureUrl);
      }

      setPhase({ kind: 'idle' });
      onUploaded(finalUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed, try again.';
      setPhase({ kind: 'error', message });
      onError?.(message);
    }
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void processFile(file);
  }

  function openPicker() {
    if (disabled || busy) return;
    inputRef.current?.click();
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (disabled || busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (disabled || busy) return;
    setDragActive(true);
  }

  function handleDragLeave() {
    setDragActive(false);
  }

  const progressLabel =
    phase.kind === 'uploading'
      ? phase.progress !== null
        ? `Uploading… ${phase.progress}%`
        : 'Uploading…'
      : phase.kind === 'confirming'
        ? 'Saving…'
        : null;

  return (
    <div className={`siu${className ? ` ${className}` : ''}`}>
      <div className="siu-block">
        <div
          className={`siu-avatar${dragActive ? ' siu-avatar--drag' : ''}${busy ? ' siu-avatar--busy' : ''}`}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={hasImage ? replaceLabel : pickLabel}
          aria-busy={busy}
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPicker();
            }
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="siu-img" />
          ) : (
            <span className="siu-fallback">{fallback}</span>
          )}
          {busy && (
            <div className="siu-overlay">
              <span className="siu-spinner" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="siu-meta">
          {title && <b>{title}</b>}
          {subtitle && <small>{subtitle}</small>}
          <div className="siu-acts">
            <button className="btn grad siu-btn-sm" type="button" onClick={openPicker} disabled={disabled || busy}>
              {'\u{1F4F7}'} {progressLabel ?? (hasImage ? replaceLabel : pickLabel)}
            </button>
            {hasImage && onClear && (
              <button className="btn siu-link siu-btn-sm" type="button" onClick={onClear} disabled={disabled || busy}>
                {clearLabel}
              </button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              style={{ display: 'none' }}
              onChange={handleInputChange}
              aria-label={hasImage ? replaceLabel : pickLabel}
            />
          </div>
        </div>
      </div>

      {phase.kind === 'error' && (
        <p className="siu-note siu-note--err">
          <span className="siu-dot" />
          {phase.message}
        </p>
      )}
    </div>
  );
}
