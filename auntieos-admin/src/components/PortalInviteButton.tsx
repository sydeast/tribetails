import { useEffect, useState } from 'react';
import { listHouseholdMembers } from '../api/members';
import { describePortalInviteOutcome, inviteKinfolkToPortal, INVITE_TTL_DAYS } from '../api/membersWrite';
import { Dialog } from './Dialog';
import { GhostButton, PrimaryButton } from './Buttons';
import { useToast } from './Toast';

/**
 * "Invite to portal" on the household profile (#1603).
 *
 * Operator ruling, 2026-11-05 docket: "no button on the Invites screen. Invite
 * from the kinfolk profile." This is that invite: `inviteKinfolkToPortal`,
 * which mails the household's PRIMARY claim link to the email on file. It is
 * the admin's only invite (the primary invites any secondary from MyTribe).
 *
 * It never fires on one click. It asks first and names the address it will
 * mail, and it is off, with the reason beside it, when it cannot succeed: no
 * email on file, or a primary already on the portal. Whether a primary is on
 * the portal is read from `listMembers`; if that read fails the button stays
 * on, because the server still refuses to re-invite an active household and
 * says so (`already_active`), which the dialog shows.
 */
export interface PortalInviteButtonProps {
  kinfolkId: string;
  householdName: string;
  /** The household's email on file. Blank means nobody can be invited. */
  email: string;
}

/** Why the invite cannot be sent, or null when it can. Pure, so it is tested directly. */
export function portalInviteBlocker(email: string, hasActivePrimary: boolean | null): string | null {
  if (email.trim() === '') return 'No email on file, so there is nobody to invite.';
  if (hasActivePrimary === true) return 'Already on the portal.';
  return null;
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}
export function PortalInviteButton({ kinfolkId, householdName, email }: PortalInviteButtonProps) {
  const { showToast } = useToast();
  const [hasActivePrimary, setHasActivePrimary] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listHouseholdMembers(kinfolkId)
      .then((members) => {
        if (live) setHasActivePrimary(members.some((m) => m.role === 'PRIMARY' && m.status === 'ACTIVE'));
      })
      .catch(() => {
        // Unknown, not "no primary": the button stays on and the server decides.
        if (live) setHasActivePrimary(null);
      });
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  const blocker = portalInviteBlocker(email, hasActivePrimary);
  const address = email.trim();

  async function send() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await inviteKinfolkToPortal(kinfolkId);
      const outcome = describePortalInviteOutcome(result, householdName);
      if (outcome.sent) {
        showToast(outcome.message);
        setConfirming(false);
      } else {
        setError(outcome.message);
        if (result.status === 'already_active') setHasActivePrimary(true);
      }
    } catch (err: unknown) {
      setError(`The portal invite was not sent: ${errText(err, 'inviteKinfolkToPortal failed.')}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <GhostButton
        label="Invite to portal"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        disabled={blocker !== null}
      />
      {blocker !== null && (
        <span className="kinfolk-profile__action-note" data-testid="portal-invite-blocker">
          {blocker}
        </span>
      )}
      {confirming && (
        <Dialog
          title="Invite to portal"
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setConfirming(false)} disabled={busy} />
              <PrimaryButton
                label={busy ? 'Sending…' : 'Send invite'}
                onClick={() => void send()}
                disabled={busy}
                busy={busy}
              />
            </>
          }
        >
          <p>
            Send {householdName}&rsquo;s portal claim link to <strong>{address}</strong>? The link expires in{' '}
            {INVITE_TTL_DAYS} days, and whoever opens it becomes the primary for this household.
          </p>
          {error !== null && (
            <p className="kinfolk-profile__invite-error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
