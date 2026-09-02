import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { getUserProfile, type UserProfile } from '../api/account';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { uploadUserPhoto } from '../api/accountPhoto';
import { type UploadStage } from '../api/mediaUpload';
import { EditProfileDialog } from '../components/EditProfileDialog';
import { SecurityPanel } from '../components/SecurityPanel';
import {
  profileDisplayName,
  profileFullName,
  profileInitials,
  providerLabel,
  roleLabel,
  authDateLabel,
  emailVerifiedLabel,
} from '../lib/accountFormat';
import './Account.css';

interface AccountProps {
  /**
   * My Notifications is a separate screen, so the nav lives with the caller.
   * [AccountRouteView] below is the one the router mounts and it always passes
   * this. Omitting it (a bare `<Account />`, which only tests do now) still
   * renders the "Open my notification settings" control as a STATIC span, no
   * button role, via ControlShell, rather than a live no-op button.
   */
  onOpenNotifications?: () => void;
}

/**
 * What `/account` actually mounts. A thin wrapper purely so the navigation is
 * a prop the screen receives rather than a router import the screen makes,
 * which keeps Account itself renderable in a test with no router at all, and
 * makes "does that button navigate" a unit test instead of a full route mount.
 */
export function AccountRouteView() {
  const navigate = useNavigate();
  return <Account onOpenNotifications={() => void navigate({ to: '/my-notifications' })} />;
}

/**
 * Account (contextual: reachable from the AppShell topbar chip, never pinned in
 * the rail). The signed-in operator's own account: their `users/{uid}` profile
 * (one-shot getUserProfile, edited through EditProfileDialog), their Firebase
 * Auth sign-in facts, the admin role the AppShell already resolved, and the
 * Security panel that changes the login email and password.
 */
export function Account({ onOpenNotifications }: AccountProps) {
  const authState = useAuth();
  const { access } = useRouteContext({ from: '/admin' });
  const user = authState.status === 'signedIn' ? authState.user : null;
  const uid = user?.uid ?? '';

  const [profile, setProfile] = useState<Async<UserProfile>>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  // The photo control's own state. Kept off the profile's Async state on
  // purpose: a failed upload must leave the loaded profile (and its current
  // photo) exactly where it was, with a banner next to it, never a reload
  // into a loading state that blanks the avatar.
  const [photoStage, setPhotoStage] = useState<UploadStage | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    if (uid === '') return;
    let live = true;
    setProfile({ status: 'loading' });
    getUserProfile(uid)
      .then((data) => live && setProfile({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setProfile({
            status: 'error',
            message: `Couldn't read your profile: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, [uid]);
  useEffect(() => load(), [load]);

  async function handlePhotoFile(file: File | null) {
    if (file === null || photoStage !== null || uid === '') return;
    setPhotoError(null);
    setPhotoStage('signing');
    try {
      await uploadUserPhoto(uid, file, setPhotoStage);
      // Re-read rather than trust the returned URL: the screen shows what
      // `users/{uid}` holds, which is the only thing the next visit will show.
      load();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setPhotoStage(null);
      // Or picking the same file again after a failure fires no change event.
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Account"
        title="Your"
        accentTail="account."
        subtitle="Your personal profile and sign-in. Business settings live under Settings."
      />

      {user === null ? (
        <Banner tone="warning" title="Not signed in">
          This account view needs a signed-in operator.
        </Banner>
      ) : (
        <AsyncRegion
          state={profile}
          what="profile"
          isEmpty={() => false}
          loading={<p className="account__hint">Loading your profile…</p>}
          empty={null}
        >
          {(p) => {
            const name = profileDisplayName(p, user.displayName, user.email);
            const full = profileFullName(p);
            // Non-assuming default: an empty providerData reads as "Unknown"
            // (via providerLabel('')), never a fabricated specific method.
            const provider = user.providerData[0]?.providerId ?? '';
            return (
              <>
                <div className="account__identity">
                  <Avatar
                    label={name}
                    imageUrl={p.photoUrl}
                    initials={profileInitials(name)}
                    size={64}
                    shape="rounded"
                    gradientSeed={uid !== '' ? uid : name}
                  />
                  <div className="account__identity-text">
                    <span className="account__identity-name">{name}</span>
                    {p.title.trim() !== '' && <span className="account__identity-title">{p.title}</span>}
                    {/* The same control Android's AccountSettingsScreen puts on the
                        avatar: pick an image, it becomes users/{uid}.photoUrl. The
                        input carries the accessible name; the button is its
                        visible face and opens the same picker. */}
                    <div className="account__photo">
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        aria-label="Change photo"
                        className="account__photo-input"
                        disabled={photoStage !== null}
                        onChange={(e) => void handlePhotoFile(e.target.files?.[0] ?? null)}
                      />
                      <GhostButton
                        label={photoStage === null ? 'Change photo' : photoStageLabel(photoStage)}
                        onClick={() => photoInputRef.current?.click()}
                        disabled={photoStage !== null}
                      />
                    </div>
                  </div>
                  {photoError !== null && (
                    <Banner tone="error" title="Couldn't change your photo">
                      {photoError}
                    </Banner>
                  )}
                </div>

                <DenPanel
                  title="Profile"
                  subtitle="Your personal profile."
                  trailing={<PrimaryButton label="Edit profile" onClick={() => setEditing(true)} />}
                >
                  <dl className="account__fields">
                    <Field label="Display name" value={p.displayName || '(not set)'} />
                    <Field label="Full name" value={full || '(not set)'} />
                    <Field label="Title" value={p.title || '(not set)'} />
                    <Field label="Phone" value={p.phone || '(not set)'} />
                    <Field label="Bio" value={p.bio || '(not set)'} />
                  </dl>
                </DenPanel>

                <DenPanel title="Sign-in">
                  <dl className="account__fields">
                    <Field label="Email" value={user.email || '(none)'} />
                    <Field label="Email status" value={emailVerifiedLabel(user.emailVerified)} />
                    <Field label="Sign-in method" value={providerLabel(provider)} />
                    <Field label="User ID" value={uid} mono />
                  </dl>
                </DenPanel>

                <SecurityPanel email={user.email ?? ''} />

                <DenPanel title="Access">
                  <dl className="account__fields">
                    <Field label="Role" value={roleLabel(access)} />
                    {access.status === 'testAdmin' && (
                      <Field label="Sandbox tribe" value={access.testTribeId} mono />
                    )}
                  </dl>
                </DenPanel>

                <DenPanel title="Activity">
                  <dl className="account__fields">
                    <Field label="Account created" value={authDateLabel(user.metadata.creationTime ?? '')} />
                    <Field label="Last sign-in" value={authDateLabel(user.metadata.lastSignInTime ?? '')} />
                  </dl>
                </DenPanel>

                <DenPanel
                  title="Notifications"
                  subtitle="Your business sets which channels each notification can use; you pick what you actually receive."
                >
                  <PrimaryButton
                    label="Open my notification settings"
                    {...(onOpenNotifications ? { onClick: onOpenNotifications } : {})}
                  />
                </DenPanel>

                {editing && (
                  <EditProfileDialog
                    uid={uid}
                    profile={p}
                    onClose={() => setEditing(false)}
                    onSaved={() => {
                      setEditing(false);
                      load();
                    }}
                  />
                )}
              </>
            );
          }}
        </AsyncRegion>
      )}
    </div>
  );
}

/** Button copy while an upload is in flight; the stages are `api/mediaUpload`'s. */
function photoStageLabel(stage: UploadStage): string {
  switch (stage) {
    case 'signing':
      return 'Preparing…';
    case 'uploading':
      return 'Uploading…';
    case 'saving':
      return 'Saving…';
  }
}

interface FieldProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Field({ label, value, mono }: FieldProps) {
  return (
    <div className="account__field">
      <dt className="account__field-label">{label}</dt>
      <dd className={mono ? 'account__field-value account__field-value--mono' : 'account__field-value'}>
        {value}
      </dd>
    </div>
  );
}
