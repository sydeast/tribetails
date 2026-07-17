import { useCallback, useEffect, useState } from 'react';
import { useRouteContext } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { getUserProfile, type UserProfile } from '../api/account';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { PrimaryButton } from '../components/Buttons';
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
   * Placeholder: My Notifications is a separate screen. Omitting this renders
   * the "Open my notification settings" control as a STATIC span (no button
   * role), via ControlShell, rather than a live no-op button (the dead-control
   * anti-pattern). Wiring the real nav later touches only the router.
   */
  onOpenNotifications?: () => void;
}

/**
 * Account (contextual: reachable by URL, never pinned in the rail). A READ-ONLY
 * overview of the signed-in operator's own account: their `users/{uid}` profile
 * (one-shot getUserProfile), their Firebase Auth sign-in facts, and the admin
 * role the AppShell already resolved. The wasm AccountSettingsScreen is an
 * editor (profile + security + notification prefs); create/edit/save is deferred.
 */
export function Account({ onOpenNotifications }: AccountProps) {
  const authState = useAuth();
  const { access } = useRouteContext({ from: '/admin' });
  const user = authState.status === 'signedIn' ? authState.user : null;
  const uid = user?.uid ?? '';

  const [profile, setProfile] = useState<Async<UserProfile>>({ status: 'loading' });
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
            const provider = user.providerData[0]?.providerId ?? 'password';
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
                  </div>
                </div>

                <DenPanel title="Profile" subtitle="Read-only. Editing lives in the profile editor.">
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
              </>
            );
          }}
        </AsyncRegion>
      )}
    </div>
  );
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
