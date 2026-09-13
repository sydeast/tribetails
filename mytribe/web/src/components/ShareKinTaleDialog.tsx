import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createShareLink, revokeShareLink, type CreateShareLinkResult } from '../api/kinTalesApi';
import '../styles/shareKinTaleDialog.css';
import { BusyLabel } from '../components/Loading';

const MIN_EXPIRES_DAYS = 1;
const MAX_EXPIRES_DAYS = 90;
const DEFAULT_EXPIRES_DAYS = 7;
const MAX_PASSCODE_LENGTH = 8;
const MIN_PASSCODE_LENGTH = 4;

export interface ShareKinTaleDialogProps {
  taleId: string;
  familyId: string;
  onClose: () => void;
}

/**
 * Web counterpart of the Compose `ShareKinTaleModal`
 * (mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/kintales/ShareKinTaleModal.kt),
 * the shipped precedent for this exact flow. Two-stage: a form (Include
 * Photos toggle, expiry, optional passcode, Generate Link) then a result
 * (the URL + Copy Link, and a destructive Revoke link action once a link
 * exists). `TaleShare` in screens/KinTales.tsx owns showing/hiding this;
 * this component owns the create + revoke mutations and every error state
 * for them — fail loud, never swallow (a SECONDARY member's permission-denied
 * from the server's requirePrimary gate must reach the kinfolk verbatim).
 *
 * The portal's web tree has no existing modal/dialog component to match —
 * SignedImageUpload's `.siu-overlay` is the closest precedent, but it's an
 * absolute busy-spinner over one widget, not a page-level dialog — so this
 * is styled fresh from tokens.css/base.css's shared `.glass`/`.card`/`.btn`
 * primitives (see styles/shareKinTaleDialog.css's `.skd-*` namespace),
 * rather than porting Compose's GlassCard/KinButton visuals.
 */
export function ShareKinTaleDialog({ taleId, familyId, onClose }: ShareKinTaleDialogProps) {
  const [includePhotos, setIncludePhotos] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState(DEFAULT_EXPIRES_DAYS);
  const [passcode, setPasscode] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateShareLinkResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [revoked, setRevoked] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createShareLink(taleId, familyId, {
        includePhotos,
        expiresInDays,
        ...(passcode.trim() === '' ? {} : { passcode }),
      }),
    onSuccess: (result) => setCreated(result),
  });

  const revoke = useMutation({
    mutationFn: () => {
      if (!created) throw new Error('No link to revoke.');
      return revokeShareLink(created.shareId);
    },
    onSuccess: () => {
      setRevoked(true);
      setConfirmingRevoke(false);
    },
  });

  const busy = create.isPending || revoke.isPending;

  // Esc closes like any dialog, same "not while busy" guard as a backdrop
  // click — a create/revoke in flight shouldn't be abandoned mid-request.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  function handleSubmit() {
    setClientError(null);
    const trimmed = passcode.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_PASSCODE_LENGTH) {
      setClientError('Passcode must be at least 4 characters.');
      return;
    }
    create.mutate();
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, insecure context). The
      // link is still visible and selectable in the input, so this is a
      // degraded convenience, not a failure worth its own error banner.
      setCopied(false);
    }
  }

  function handleBackdropClose() {
    if (busy) return;
    onClose();
  }

  const formErrorMessage =
    clientError ??
    (create.isError ? (create.error instanceof Error ? create.error.message : 'Could not create a share link. Try again.') : null);

  const revokeErrorMessage = revoke.isError
    ? revoke.error instanceof Error
      ? revoke.error.message
      : 'Could not revoke the link. Try again.'
    : null;

  return (
    <div className="skd-overlay" role="presentation" onClick={handleBackdropClose}>
      <div
        className="skd-card glass card"
        role="dialog"
        aria-modal="true"
        aria-label={created ? 'Link Ready!' : 'Invite the Family'}
        onClick={(e) => e.stopPropagation()}
      >
        {!created ? (
          <div className="skd-form">
            <h3 className="skd-title">Invite the Family</h3>
            <p className="sub skd-sub">Share this story with family and friends. Choose how the link works.</p>

            <button
              type="button"
              role="switch"
              aria-checked={includePhotos}
              className={`skd-switchrow${includePhotos ? ' is-on' : ''}`}
              onClick={() => setIncludePhotos((v) => !v)}
              disabled={busy}
            >
              <span>Include Photos</span>
              <span className="skd-switch" aria-hidden="true">
                <span className="skd-thumb" />
              </span>
            </button>

            <div className="skd-expiry">
              <div className="skd-expiryhead">
                <span>Link Expiration</span>
                <span className="skd-expirypill">{expiresInDays} Days</span>
              </div>
              <input
                type="range"
                min={MIN_EXPIRES_DAYS}
                max={MAX_EXPIRES_DAYS}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
                aria-label="Link expiration in days"
                disabled={busy}
              />
              <div className="skd-expiryrange">
                <span>{MIN_EXPIRES_DAYS}</span>
                <span>{MAX_EXPIRES_DAYS}</span>
              </div>
            </div>

            <label className="skd-field">
              <span className="skd-fieldlabel">Secure with passcode</span>
              <input
                type="text"
                className="skd-inp"
                value={passcode}
                maxLength={MAX_PASSCODE_LENGTH}
                onChange={(e) => setPasscode(e.target.value.slice(0, MAX_PASSCODE_LENGTH))}
                placeholder="Optional, 4–8 characters"
                aria-label="Passcode, optional, 4 to 8 characters"
                disabled={busy}
              />
            </label>

            {formErrorMessage && <p className="skd-error">{formErrorMessage}</p>}

            <button type="button" className="btn block skd-submit" onClick={handleSubmit} disabled={busy}>
              {create.isPending ? <BusyLabel>Creating…</BusyLabel> : 'Generate Link'}
            </button>
          </div>
        ) : (
          <div className="skd-result">
            <div className="skd-resulthead">
              <span className="skd-check" aria-hidden="true">
                {'✓'}
              </span>
              <h3 className="skd-title">Link Ready!</h3>
            </div>

            {!revoked ? (
              <>
                <div className="skd-urlpill">
                  <input
                    className="skd-urlinput"
                    type="text"
                    readOnly
                    value={created.shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Share link"
                  />
                  <button type="button" className="btn grad skd-copy" onClick={() => void copyLink(created.shareUrl)}>
                    {copied ? 'Copied' : 'Copy Link'}
                  </button>
                </div>

                {passcode.trim() !== '' && (
                  <p className="skd-passnote">Send the passcode separately. We don&rsquo;t store it, so keep a copy.</p>
                )}

                {!confirmingRevoke ? (
                  <button type="button" className="skd-revokelink" onClick={() => setConfirmingRevoke(true)} disabled={busy}>
                    Revoke link
                  </button>
                ) : (
                  <div className="skd-revokeconfirm">
                    <p className="sub">Revoking makes this link stop working right away. This can&rsquo;t be undone.</p>
                    {revokeErrorMessage && <p className="skd-error">{revokeErrorMessage}</p>}
                    <button type="button" className="btn skd-revokeconfirmbtn" onClick={() => revoke.mutate()} disabled={busy}>
                      {revoke.isPending ? <BusyLabel>Revoking…</BusyLabel> : 'Yes, revoke'}
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setConfirmingRevoke(false)} disabled={busy}>
                      Keep link
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="skd-revoked">This link no longer works.</p>
            )}

            <button type="button" className="btn ghost block skd-done" onClick={onClose} disabled={busy}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
