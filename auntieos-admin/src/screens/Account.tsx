import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { getUserProfile, type UserProfile } from '../api/account';
import { saveUserProfile } from '../api/accountWrite';
import { listBusinessAdmins } from '../api/businessAdmins';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import {
  getMyNotificationPrefs,
  getNotificationMatrix,
  NOTIFICATION_CHANNELS,
  STREAM_BUSINESS,
  STREAM_STAFF,
  type AdminNotificationPrefs,
  type NotificationChannel,
  type NotificationMatrix,
} from '../api/myNotifications';
import { saveMyAdminNotificationPrefs } from '../api/myNotificationsWrite';
import { adminVisibleNotifications } from '../lib/myNotificationsFormat';
import {
  applyChannelToggle,
  channelMasterCount,
  channelMasterOn,
  type BulkToggleScope,
} from '../lib/myNotificationsEdit';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { Toggle } from '../components/Toggle';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { uploadUserPhoto } from '../api/accountPhoto';
import { type UploadStage } from '../api/mediaUpload';
import { SecurityPanel } from '../components/SecurityPanel';
import { BUSINESS_PROFILE_FIELDS, TextFieldsSection } from './settings/sections';
import {
  profileDisplayName,
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

/** The `users/{uid}` fields this screen edits inline. Matches `UserProfilePatch`. */
interface ProfileDraft {
  displayName: string;
  firstName: string;
  lastName: string;
  phone: string;
  title: string;
  bio: string;
}

const DRAFT_KEYS: readonly (keyof ProfileDraft)[] = [
  'displayName',
  'firstName',
  'lastName',
  'phone',
  'title',
  'bio',
];

function draftFrom(p: UserProfile): ProfileDraft {
  return {
    displayName: p.displayName,
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    title: p.title,
    bio: p.bio,
  };
}

/** Trimmed comparison: leading spaces the operator never meant are not an edit. */
function draftChanged(draft: ProfileDraft, stored: ProfileDraft): boolean {
  return DRAFT_KEYS.some((k) => draft[k].trim() !== stored[k].trim());
}

/**
 * Account (contextual: reachable from the AppShell topbar chip, never pinned in
 * the rail). The signed-in operator's own account, rebuilt to
 * `ui-ideas/auntieos-user-profile-2026-05-27.html` for issue #719: a hero
 * carrying the identity facts and the one Save, then two columns.
 *
 *   left   Profile (inline fields, saved by the hero button)
 *          Business profile (the SAME field list and the SAME save the Settings
 *          business panel uses, so the two surfaces cannot drift)
 *   right  Notifications (one switch per channel, over the store the
 *          /my-notifications screen edits row by row)
 *          Security (reset link, sign out, login email) and, under it, the
 *          Access and Activity facts
 *
 * What changed from the screen this replaces: the read-only `<dl>` panels and
 * the EditProfileDialog they opened are gone, the fields are edited where they
 * are read, and the hero shows the email, the role and the badges the mock
 * draws. What did NOT change: every fact the old screen displayed is still on
 * this page. The mock drew no Sign-in, Access or Activity panel, but role,
 * sandbox tribe, sign-in method, email status, user id, account created and
 * last sign-in are real data an operator can be asked for, so they moved into
 * the compact meta block under Security rather than being deleted.
 *
 * The mock's third right-column card, "Sign out all devices", is drawn there as
 * an explicit "Suggestion, not in current model". Nothing in this app revokes
 * refresh tokens, so it is not built here.
 */
export function Account({ onOpenNotifications }: AccountProps) {
  const authState = useAuth();
  const { access } = useRouteContext({ from: '/admin' });
  const user = authState.status === 'signedIn' ? authState.user : null;
  const uid = user?.uid ?? '';

  const [profile, setProfile] = useState<Async<UserProfile>>({ status: 'loading' });
  // The inline edits, null until the operator types. `null` means "show what
  // was loaded", which is why a photo upload's re-read (below) cannot wipe a
  // half-typed name: the draft lives here, outside the Async branch.
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
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
    // A RE-READ KEEPS WHAT IS ON SCREEN. Dropping back to `loading` would
    // unmount this whole region, and with it the Business profile panel's
    // in-progress edit and every sibling panel's loaded data, so a hero Save
    // would silently throw away a business address the operator had half
    // typed and re-fire four reads. Only the FIRST read shows a loading state.
    setProfile((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
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

  async function handleSaveProfile(next: ProfileDraft) {
    setSaveAttempted(true);
    if (next.displayName.trim() === '' || saving || uid === '') return;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      await saveUserProfile(uid, {
        displayName: next.displayName.trim(),
        firstName: next.firstName.trim(),
        lastName: next.lastName.trim(),
        phone: next.phone.trim(),
        title: next.title.trim(),
        bio: next.bio.trim(),
      });
      // The saved values become "what was loaded" before the draft is dropped,
      // so the fields do not flash back to the old text while the re-read is in
      // flight. `load()` below then confirms them against the document.
      setProfile((prev) =>
        prev.status === 'ready'
          ? {
              status: 'ready',
              data: {
                ...prev.data,
                displayName: next.displayName.trim(),
                firstName: next.firstName.trim(),
                lastName: next.lastName.trim(),
                phone: next.phone.trim(),
                title: next.title.trim(),
                bio: next.bio.trim(),
              },
            }
          : prev,
      );
      setDraft(null);
      setSaveAttempted(false);
      setJustSaved(true);
      load();
    } catch (err) {
      setSaveError(`saveUserProfile failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Account"
        title="Your"
        accentTail="account."
        subtitle="Your personal profile, your business details, and which notifications reach you."
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
            const stored = draftFrom(p);
            const d = draft ?? stored;
            const dirty = draftChanged(d, stored);
            const name = profileDisplayName(p, user.displayName, user.email);
            const nameError =
              saveAttempted && d.displayName.trim() === '' ? "Display name can't be blank." : null;
            // Non-assuming default: an empty providerData reads as "Unknown"
            // (via providerLabel('')), never a fabricated specific method.
            const provider = user.providerData[0]?.providerId ?? '';
            const set = (key: keyof ProfileDraft, value: string) => {
              setJustSaved(false);
              setDraft({ ...d, [key]: value });
            };
            return (
              <>
                <AccountHero
                  name={name}
                  photoUrl={p.photoUrl}
                  uid={uid}
                  email={user.email ?? ''}
                  role={[d.title.trim(), roleLabel(access)].filter((s) => s !== '').join(' · ')}
                  photoStage={photoStage}
                  photoInputRef={photoInputRef}
                  onPhotoFile={(file) => void handlePhotoFile(file)}
                  saving={saving}
                  saveDisabled={saving || !dirty}
                  onSave={() => void handleSaveProfile(d)}
                />

                {photoError !== null && (
                  <Banner tone="error" title="Couldn't change your photo">
                    {photoError}
                  </Banner>
                )}
                {saveError !== null && (
                  <Banner tone="error" title="Couldn't save your profile">
                    {saveError}
                  </Banner>
                )}
                {justSaved && !dirty && <Banner tone="success">Profile saved.</Banner>}

                <div className="account__cols">
                  <div className="account__col">
                    <DenPanel title="Profile" subtitle="What kinfolk see on your KinTales and replies.">
                      <div className="account__fields">
                        <div className="account__frow">
                          <TextField
                            id="account-first-name"
                            label="First name"
                            value={d.firstName}
                            disabled={saving}
                            onChange={(v) => set('firstName', v)}
                          />
                          <TextField
                            id="account-last-name"
                            label="Last name"
                            value={d.lastName}
                            disabled={saving}
                            onChange={(v) => set('lastName', v)}
                          />
                        </div>
                        <TextField
                          id="account-display-name"
                          label="Display name"
                          value={d.displayName}
                          disabled={saving}
                          error={nameError}
                          onChange={(v) => set('displayName', v)}
                        />
                        <div className="account__frow">
                          <TextField
                            id="account-phone"
                            label="Phone"
                            type="tel"
                            value={d.phone}
                            disabled={saving}
                            onChange={(v) => set('phone', v)}
                          />
                          <TextField
                            id="account-title"
                            label="Title"
                            value={d.title}
                            disabled={saving}
                            onChange={(v) => set('title', v)}
                          />
                        </div>
                        <div className="account__field">
                          <label className="account__label" htmlFor="account-bio">
                            Bio
                          </label>
                          <textarea
                            id="account-bio"
                            rows={3}
                            className="account__input account__textarea"
                            value={d.bio}
                            disabled={saving}
                            onChange={(e) => set('bio', e.target.value)}
                          />
                        </div>
                      </div>
                    </DenPanel>

                    <BusinessProfilePanel />
                  </div>

                  <div className="account__col">
                    <NotificationChannelsPanel
                      {...(onOpenNotifications ? { onOpenNotifications } : {})}
                    />

                    <SecurityPanel
                      email={user.email ?? ''}
                      meta={
                        <dl className="account__meta">
                          <MetaFact label="Role" value={roleLabel(access)} />
                          {access.status === 'testAdmin' && (
                            <MetaFact label="Sandbox tribe" value={access.testTribeId} mono />
                          )}
                          <MetaFact label="Sign-in method" value={providerLabel(provider)} />
                          <MetaFact
                            label="Email status"
                            value={emailVerifiedLabel(user.emailVerified)}
                          />
                          <MetaFact label="User ID" value={uid} mono />
                          <MetaFact
                            label="Account created"
                            value={authDateLabel(user.metadata.creationTime ?? '')}
                          />
                          <MetaFact
                            label="Last sign-in"
                            value={authDateLabel(user.metadata.lastSignInTime ?? '')}
                          />
                        </dl>
                      }
                    />
                  </div>
                </div>
              </>
            );
          }}
        </AsyncRegion>
      )}
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────────

interface AccountHeroProps {
  name: string;
  photoUrl: string;
  uid: string;
  email: string;
  role: string;
  photoStage: UploadStage | null;
  photoInputRef: React.RefObject<HTMLInputElement | null>;
  onPhotoFile: (file: File | null) => void;
  saving: boolean;
  saveDisabled: boolean;
  onSave: () => void;
}

/**
 * The mock's hero: avatar, name, role line, email, badges, and the two actions.
 * The "Sole admin" badge is the only one needing a round-trip, so it loads here
 * rather than in the screen: when `listBusinessAdmins` fails there is simply no
 * badge, because "you are the only admin" is a claim this screen must not make
 * without the roster that proves it.
 */
function AccountHero({
  name,
  photoUrl,
  uid,
  email,
  role,
  photoStage,
  photoInputRef,
  onPhotoFile,
  saving,
  saveDisabled,
  onSave,
}: AccountHeroProps) {
  const [soleAdmin, setSoleAdmin] = useState(false);

  useEffect(() => {
    let live = true;
    listBusinessAdmins()
      .then((roster) => {
        if (live) setSoleAdmin(roster.source !== 'none' && roster.members.length === 1);
      })
      .catch(() => {
        // No badge. See the header: an unread roster is not evidence of one admin.
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="account__hero">
      <Avatar
        label={name}
        imageUrl={photoUrl}
        initials={profileInitials(name)}
        size={72}
        shape="rounded"
        gradientSeed={uid !== '' ? uid : name}
      />
      <div className="account__heroMeta">
        <span className="account__heroName">{name}</span>
        {role !== '' && <span className="account__heroRole">{role}</span>}
        <span className="account__heroEmail">{email === '' ? 'No login email on file' : email}</span>
        <div className="account__badges">
          {/* The /admin route context only ever resolves to `admin` or
              `testAdmin` here: a denied operator never reaches this screen, so
              the account IS active by the time this renders. */}
          <span className="account__badge">Active</span>
          {soleAdmin && <span className="account__badge account__badge--sole">Sole admin</span>}
          {uid !== '' && (
            <span className="account__badge account__badge--uid">uid: {uidBadge(uid)}</span>
          )}
        </div>
      </div>
      <div className="account__heroActions">
        {/* The same control Android's AccountSettingsScreen puts on the avatar:
            pick an image, it becomes users/{uid}.photoUrl. The input carries the
            accessible name; the button is its visible face and opens the same
            picker. */}
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          aria-label="Change photo"
          className="account__photo-input"
          disabled={photoStage !== null}
          onChange={(e) => onPhotoFile(e.target.files?.[0] ?? null)}
        />
        <GhostButton
          label={photoStage === null ? 'Change photo' : photoStageLabel(photoStage)}
          onClick={() => photoInputRef.current?.click()}
          disabled={photoStage !== null}
        />
        <PrimaryButton
          label={saving ? 'Saving…' : 'Save profile'}
          onClick={onSave}
          disabled={saveDisabled}
          busy={saving}
        />
      </div>
    </div>
  );
}

/** First 10 characters of the uid, the mock's `uid: nppJN0a4x2…` badge. */
function uidBadge(uid: string): string {
  return uid.length > 10 ? `${uid.slice(0, 10)}…` : uid;
}

// ── business profile ────────────────────────────────────────────────────────

/**
 * The mock puts Business Profile on this page, so it is here, and it is the
 * SAME panel the Settings business section renders: `TextFieldsSection` over
 * `BUSINESS_PROFILE_FIELDS`, saved with `saveBusinessSettings`. Importing the
 * field list rather than retyping it is what stops the two surfaces from
 * drifting the moment a field is added on one of them.
 *
 * "Weather area" rides along because the operator moved it into that list
 * (mark 16 of the 2026-08-17 walk). The 2026-05-27 mock predates that move and
 * draws four fields; keeping the two surfaces identical is worth more than
 * matching an older field count.
 *
 * Its own Async and its own error, matching the mock's separate Save: a
 * business settings read that fails leaves the profile column, the hero and the
 * hero's Save button working.
 */
function BusinessProfilePanel() {
  const [state, setState] = useState<Async<BusinessSettings>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    getBusinessSettings()
      .then((data) => live && setState({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Load failed',
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  async function persist(patch: Partial<BusinessSettings>) {
    await saveBusinessSettings(patch);
    // TextFieldsSection's dirty check compares live values against `data`, so
    // the saved patch has to land here or its Save button stays lit forever.
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: { ...s.data, ...patch } } : s));
  }

  return (
    <AsyncRegion
      state={state}
      what="business settings"
      isEmpty={() => false}
      loading={<p className="account__hint">Loading business settings…</p>}
      empty={null}
    >
      {(data) => (
        <TextFieldsSection
          title="Business profile"
          subtitle="Identity used on invoices, emails, and KinTales."
          data={data}
          fields={BUSINESS_PROFILE_FIELDS}
          onSave={persist}
        />
      )}
    </AsyncRegion>
  );
}

// ── notifications ───────────────────────────────────────────────────────────

interface NotifData {
  matrix: NotificationMatrix;
  prefs: AdminNotificationPrefs;
}

const CHANNEL_ROWS: Readonly<Record<NotificationChannel, { title: string; detail: string }>> = {
  email: {
    title: 'Email notifications',
    detail: 'Receipts, alerts, and daily summaries by email.',
  },
  sms: {
    title: 'SMS notifications',
    detail: 'Text pings for time-sensitive booking changes.',
  },
  push: {
    title: 'Push notifications',
    detail: 'In-app and device push for live session updates.',
  },
};

/**
 * Three switches, one per channel, over the SAME store the full My Notifications
 * screen edits (`staff/{uid}.notificationPrefs`, read and written by the same
 * two callables). That store has no global per-channel bit, so each switch
 * stands for every notification the operator may decide on that channel: ON
 * when at least one would reach them there, and flipping it writes every
 * editable row. `lib/myNotificationsEdit.ts` holds that rule and its tests.
 *
 * Instant save, no draft (the `BookingBehaviorSection` pattern): the loaded
 * prefs drive `checked`, so a save that fails leaves the switch exactly where
 * it was with a banner saying why, rather than showing a flip that never
 * persisted.
 *
 * The link to the full page stays. This panel cannot express "email for
 * invoices, not for reminders", and the page that can is one click away.
 */
function NotificationChannelsPanel({ onOpenNotifications }: AccountProps) {
  const [state, setState] = useState<Async<NotifData>>({ status: 'loading' });
  const [busyChannel, setBusyChannel] = useState<NotificationChannel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    Promise.all([getNotificationMatrix(), getMyNotificationPrefs()])
      .then(([matrix, own]) => {
        if (live) setState({ status: 'ready', data: { matrix, prefs: own.prefs } });
      })
      .catch(
        (err: unknown) =>
          live &&
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Load failed',
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  const scopes: BulkToggleScope[] = useMemo(() => {
    if (state.status !== 'ready') return [];
    const m = state.data.matrix;
    return [
      { entries: adminVisibleNotifications(m, STREAM_BUSINESS), stream: STREAM_BUSINESS },
      { entries: adminVisibleNotifications(m, STREAM_STAFF), stream: STREAM_STAFF },
    ];
  }, [state]);

  async function flip(data: NotifData, channel: NotificationChannel, on: boolean) {
    if (busyChannel !== null) return;
    setBusyChannel(channel);
    setError(null);
    const next = applyChannelToggle(data.prefs, data.matrix, scopes, channel, on);
    try {
      await saveMyAdminNotificationPrefs(next);
      setState({ status: 'ready', data: { matrix: data.matrix, prefs: next } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusyChannel(null);
    }
  }

  return (
    <DenPanel
      title="Notifications"
      subtitle="Each switch covers every notification on that channel. Pick them one by one on the full page."
    >
      {error !== null && (
        <Banner tone="error" title="Couldn't save that change">
          {error}
        </Banner>
      )}
      <AsyncRegion
        state={state}
        what="notification settings"
        isEmpty={() => false}
        loading={<p className="account__hint">Loading notification settings…</p>}
        empty={null}
      >
        {(data) => (
          <div className="account__toggles">
            {NOTIFICATION_CHANNELS.map((channel) => {
              const row = CHANNEL_ROWS[channel];
              const count = channelMasterCount(data.matrix, scopes, channel);
              const on = channelMasterOn(data.prefs, data.matrix, scopes, channel);
              return (
                <div key={channel} className="account__toggleRow">
                  <div className="account__toggleText">
                    <b className="account__toggleTitle">{row.title}</b>
                    <small className="account__toggleDetail">
                      {count === 0
                        ? `${row.detail} Your business offers no notification on this channel right now.`
                        : row.detail}
                    </small>
                  </div>
                  <Toggle
                    label={row.title}
                    checked={on}
                    disabled={count === 0 || busyChannel !== null}
                    onChange={(next) => void flip(data, channel, next)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </AsyncRegion>
      <div className="account__toggleFooter">
        <GhostButton
          label="Open my notification settings"
          {...(onOpenNotifications ? { onClick: onOpenNotifications } : {})}
        />
      </div>
    </DenPanel>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

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

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  type?: 'text' | 'tel';
  error?: string | null;
}

/** One labelled inline field. The mock's `.lab` + `.fld` pair, made editable. */
function TextField({ id, label, value, onChange, disabled, type = 'text', error }: TextFieldProps) {
  const invalid = error !== null && error !== undefined;
  return (
    <div className="account__field">
      <label className="account__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="account__input"
        value={value}
        disabled={disabled === true}
        aria-invalid={invalid}
        {...(invalid ? { 'aria-describedby': `${id}-error` } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid && (
        <span id={`${id}-error`} className="account__fieldError" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface MetaFactProps {
  label: string;
  value: string;
  mono?: boolean;
}

/** One row of the compact Access and Activity block under Security. */
function MetaFact({ label, value, mono }: MetaFactProps) {
  return (
    <div className="account__metaRow">
      <dt className="account__metaLabel">{label}</dt>
      <dd className={mono ? 'account__metaValue account__metaValue--mono' : 'account__metaValue'}>
        {value}
      </dd>
    </div>
  );
}
