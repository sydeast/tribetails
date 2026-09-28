import { useState } from 'react';
import { buildClaimUrl } from '../api/claimFlow';

/**
 * What `addSecondaryContact` actually did, replacing the old "Invite sent."
 * (#1018, item 3). That callable sends no email of its own —
 * `onInviteRequestCreate` is an explicit no-op — so a claim link is the only
 * thing that reaches the secondary, and today nothing hands it to them but the
 * primary. This is that link, with a copy button so the primary can pass it
 * along themselves.
 */
export function InviteCreatedNotice({ inviteId }: { inviteId: string }) {
  const [copied, setCopied] = useState(false);
  const url = buildClaimUrl(window.location.origin, inviteId);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, insecure context). The
      // link is still right there to select by hand, so this is a degraded
      // convenience, not a failure worth its own error banner.
      setCopied(false);
    }
  }

  return (
    <div className="sub" style={{ color: 'var(--teal)', marginTop: 8 }}>
      <p style={{ margin: 0 }}>Invite created. No email goes out, so share this link with them yourself:</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <code style={{ wordBreak: 'break-all' }}>{url}</code>
        <button type="button" className="btn ghost" onClick={() => void copyLink()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
