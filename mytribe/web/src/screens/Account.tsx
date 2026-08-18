import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyHome, getMyKin } from '../api/portal';
import {
  addSecondaryContact,
  createBillingSetupSession,
  formatCard,
  getFormSchema,
  getMyAccount,
  getMyPaymentMethod,
  removeMyPaymentMethod,
  saveMyAccount,
  signKinfolkAvatar,
  syncMyPaymentMethod,
  validateAvatarFile,
} from '../api/accountApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { SignedImageUpload } from '../components/SignedImageUpload';
import { LaunchError } from './LaunchError';
import { kinVariant, speciesEmoji } from '../lib/portalFormat';
import '../styles/account.css';

type Status = { text: string; tone: 'ok' | 'err' };

/** True for a Firebase callable rejection the server raised as permission-denied. */
function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'functions/permission-denied' || code === 'permission-denied';
}

/**
 * A billing failure a household can act on.
 *
 * The raw callable message is kept when the server wrote one for a person
 * (`failed-precondition`, `permission-denied`, `unavailable` all carry a
 * sentence from `portal/billing.ts`); anything else is machinery, and naming
 * the action is more use than repeating it.
 */
function billingErrorText(err: unknown, action: string): string {
  if (isPermissionDenied(err)) return 'Only the primary kinfolk on this tribe can manage billing.';
  const message = err instanceof Error ? err.message : '';
  if (message && !/^internal$/i.test(message)) return message;
  return `We could not ${action} just now. Try again in a moment.`;
}

/**
 * Account Settings, ported from ui-ideas/mytribe-account-2026-05-31.html.
 * Data flow mirrors AccountSettingsScreen.kt (src/commonMain/kotlin/com/
 * kinfolk/portal/screens/account/AccountSettingsScreen.kt):
 *   - getMyAccount() seeds the form once on load. Never pre-fills Display
 *     Name with the email — older accounts seeded displayName = email on
 *     creation (onAuthUserCreate), and re-showing that as a "name" is
 *     confusing, so it's treated as blank.
 *   - getFormSchema('account') is a best-effort admin override: when no
 *     `formSchemas/account` doc exists yet the callable throws not-found,
 *     which this screen treats as "no schema configured" rather than a
 *     fatal error (retry: false, error ignored, static fields stay in
 *     control). No admin schema is seeded yet, so today this always falls
 *     through to the static fields below — the query exists so the screen
 *     doesn't need another code change once one is added. (The Compose
 *     screen additionally *renders* a schema-driven form when present;
 *     that dynamic-form renderer is out of scope for this port — see the
 *     final report for why.)
 *   - saveMyAccount persists, then getMyAccount is refetched to verify the
 *     write instead of trusting a silent client-side "Saved."
 *   - The photo picker is the shared <SignedImageUpload> component
 *     (components/SignedImageUpload.tsx), wired to signKinfolkAvatar +
 *     validateAvatarFile; it POSTs straight to Cloudinary itself (mirroring
 *     CloudinaryUpload.js.kt) and hands back a secure_url via onUploaded.
 *     There's no confirm step for avatars — the URL is only persisted when
 *     the kinfolk hits Save Changes below, same as before this was
 *     extracted into a reusable component.
 *   - addSecondaryContact is reachable from the mockup's "Send Invite"
 *     button under Recovery Contacts. The mockup only exposes one
 *     Backup Email/Backup Phone pair (no separate "who to invite" field),
 *     so Send Invite uses the Backup Email value as the invitee: it both
 *     saves as the kinfolk's own backup contact (via saveMyAccount, on
 *     Save Changes) and, on request, invites that same address as a
 *     secondary portal account (addSecondaryContact) — the two backend
 *     concepts the mockup visually merges into one card.
 */
export function Account() {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  // Thread the active household so an operator who stepped into another tribe
  // sees THAT household's profile, not their own admin account (impersonated).
  const account = useQuery({ queryKey: ['myAccount', kinfolkId], queryFn: () => getMyAccount(kinfolkId) });
  // Best-effort: getFormSchema('account') 404s until an admin seeds a
  // schema. retry:false keeps that from hammering the callable; the error
  // itself is never surfaced (see block comment above).
  useQuery({ queryKey: ['formSchema', 'account'], queryFn: () => getFormSchema('account'), retry: false });
  const home = useQuery({ queryKey: ['myHome', kinfolkId], queryFn: () => getMyHome(kinfolkId), enabled: account.isSuccess });
  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId), enabled: account.isSuccess });

  const [hydrated, setHydrated] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [backupEmail, setBackupEmail] = useState('');
  const [backupPhone, setBackupPhone] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [inviteStatus, setInviteStatus] = useState<Status | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [managingBilling, setManagingBilling] = useState(false);
  const [confirmingCardRemoval, setConfirmingCardRemoval] = useState(false);
  const [billingStatus, setBillingStatus] = useState<Status | null>(null);

  // Seed the editable fields once from the loaded account, same as the
  // Compose screen's LaunchedEffect(Unit) — never re-clobbers in-progress
  // edits on a background refetch.
  useEffect(() => {
    if (hydrated || !account.data) return;
    const a = account.data;
    setDisplayName(a.displayName && a.displayName !== a.email ? a.displayName : '');
    setPhone(a.phone ?? '');
    setPhotoUrl(a.photoUrl ?? '');
    setBackupEmail(a.backupEmail ?? '');
    setBackupPhone(a.backupPhone ?? '');
    setHydrated(true);
  }, [account.data, hydrated]);

  const save = useMutation({
    mutationFn: () =>
      saveMyAccount({
        displayName: displayName.trim(),
        phone: phone.trim() || null,
        photoUrl: photoUrl.trim() || null,
        backupEmail: backupEmail.trim() || null,
        backupPhone: backupPhone.trim() || null,
      }),
    onSuccess: async () => {
      setStatus({ text: 'Saved.', tone: 'ok' });
      // Verify persistence by reloading from the server rather than trusting
      // the optimistic local state (matches the Compose screen).
      const fresh = await queryClient.fetchQuery({ queryKey: ['myAccount', kinfolkId], queryFn: () => getMyAccount(kinfolkId) });
      queryClient.setQueryData(['myAccount', kinfolkId], fresh);
      setDisplayName(fresh.displayName && fresh.displayName !== fresh.email ? fresh.displayName : '');
      setPhone(fresh.phone ?? '');
      setPhotoUrl(fresh.photoUrl ?? '');
      setBackupEmail(fresh.backupEmail ?? '');
      setBackupPhone(fresh.backupPhone ?? '');
    },
    onError: (err: unknown) => {
      setStatus({ text: `Save failed: ${err instanceof Error ? err.message : 'try again'}`, tone: 'err' });
    },
  });

  const invite = useMutation({
    mutationFn: () => addSecondaryContact(backupEmail.trim(), kinfolkId !== undefined ? { kinfolkId } : {}),
    onSuccess: () => setInviteStatus({ text: 'Invite sent.', tone: 'ok' }),
    onError: (err: unknown) =>
      setInviteStatus({ text: `Invite failed: ${err instanceof Error ? err.message : 'try again'}`, tone: 'err' }),
  });

  // ── Card management ────────────────────────────────────────────────────────
  //
  // `getMyPaymentMethod` rather than the `hasPaymentMethod` boolean already on
  // the account DTO: that boolean can say a card exists but never which one,
  // and "Payment method on file" with nothing else on the row is exactly the
  // state a household writes in to ask about.
  const paymentMethod = useQuery({
    queryKey: ['myPaymentMethod', kinfolkId],
    queryFn: () => getMyPaymentMethod(kinfolkId),
    enabled: account.isSuccess && account.data?.impersonated !== true,
    retry: false,
  });

  const startCardSetup = useMutation({
    mutationFn: async () => {
      const returnTo = `${window.location.origin}${window.location.pathname}`;
      return createBillingSetupSession(`${returnTo}?billing=saved`, returnTo, kinfolkId);
    },
    onSuccess: (res) => {
      setBillingStatus(null);
      // A full navigation, not a popup: Stripe's hosted page is the whole
      // point of the redirect, and `?billing=saved` on the way back is what
      // triggers the sync below.
      window.location.href = res.checkoutUrl;
    },
    onError: (err: unknown) => setBillingStatus({ text: billingErrorText(err, 'add a card'), tone: 'err' }),
  });

  const removeCard = useMutation({
    mutationFn: () => removeMyPaymentMethod(kinfolkId),
    onSuccess: async (res) => {
      setConfirmingCardRemoval(false);
      setBillingStatus({ text: res.alreadyEmpty ? 'There was no card on file.' : 'Card removed.', tone: 'ok' });
      await queryClient.invalidateQueries({ queryKey: ['myPaymentMethod', kinfolkId] });
      await queryClient.invalidateQueries({ queryKey: ['myAccount', kinfolkId] });
    },
    onError: (err: unknown) => setBillingStatus({ text: billingErrorText(err, 'remove the card'), tone: 'err' }),
  });

  // Coming back from Stripe. The webhook stores the card too, but it can arrive
  // after this screen has already rendered, so the browser asks for the answer
  // itself rather than showing a stale "no payment method" to a household that
  // just entered one.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') !== 'saved') return;
    params.delete('billing');
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    setManagingBilling(true);
    void (async () => {
      try {
        const synced = await syncMyPaymentMethod(kinfolkId);
        queryClient.setQueryData(['myPaymentMethod', kinfolkId], synced);
        await queryClient.invalidateQueries({ queryKey: ['myAccount', kinfolkId] });
        setBillingStatus(
          synced.hasPaymentMethod
            ? { text: synced.changed ? 'Card saved.' : 'Card is already on file.', tone: 'ok' }
            : { text: 'Stripe did not report a card. Try adding it again.', tone: 'err' },
        );
      } catch (err) {
        setBillingStatus({ text: billingErrorText(err, 'confirm the card'), tone: 'err' });
      }
    })();
  }, [kinfolkId, queryClient]);

  const { signOut, signingOut } = useSignOut();

  if (account.isError) {
    return <LaunchError onRetry={() => void account.refetch()} retrying={account.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  if (account.isLoading || !account.data) {
    return (
      <>
        <PortalNav active="account" />
        <div className="wrap acct">
          <p className="sub">Loading your account…</p>
        </div>
      </>
    );
  }

  const data = account.data;
  // When an operator has stepped into another tribe, this DTO is the household's
  // account, not theirs: the profile becomes a read-only view of that household.
  const readOnly = data.impersonated;
  const householdName = home.data?.displayName || data.displayName || 'this tribe';
  const initial = (data.displayName || data.email || householdName || 'M').charAt(0).toUpperCase();
  const roster = (kin.data?.kin ?? []).filter((k) => k.status === 'active').slice(0, 4);
  const businessName = home.data?.businessName || 'Tribe Tails Pet Care';
  const nameValid = displayName.trim().length > 0;

  // The card query is the authority once it has answered; the account DTO's
  // boolean covers the moment before that, and the operator view where the card
  // query never runs at all.
  const cardOnFile = paymentMethod.data?.hasPaymentMethod ?? data.hasPaymentMethod;
  const card = paymentMethod.data?.card ?? null;
  const cardSubtitle = card
    ? formatCard(card)
    : cardOnFile
      ? 'Charges run through your care team'
      : 'Settle up directly with your Auntie for now';
  const billingReadError = isPermissionDenied(paymentMethod.error)
    ? 'Only the primary kinfolk on this tribe can manage billing.'
    : 'We could not read your billing details just now.';

  return (
    <>
      <PortalNav active="account" displayName={(readOnly ? householdName : data.displayName) ?? ''} />

      <div className="wrap acct">
        <header className="hero-greet">
          <div className="kick">
            {readOnly ? `Viewing ${householdName}'s profile` : `Signed in as ${data.displayName || data.email || 'you'}`}
          </div>
          <h1>
            Account <span>Settings</span>
          </h1>
        </header>

        {readOnly && (
          <div className="note" role="status" style={{ marginBottom: 14 }}>
            <span className="dot" />
            Operator view. You are looking at {householdName}'s profile because you stepped into their tribe. It is read-only here; switch tribes from the picker to change who you are viewing.
          </div>
        )}

        <div className="cols">
          <div className="stack">
            {/* PROFILE */}
            <section className="glass card d1">
              <div className="sectlabel">Profile</div>

              <div style={readOnly ? { pointerEvents: 'none', opacity: 0.65 } : undefined}>
                <SignedImageUpload
                  sign={signKinfolkAvatar}
                  validate={validateAvatarFile}
                  onUploaded={(url) => setPhotoUrl(url)}
                  imageUrl={photoUrl}
                  onClear={() => setPhotoUrl('')}
                  fallback={initial}
                  title="Profile photo"
                  subtitle="Avatar"
                />
              </div>

              <div className="divider" />

              <div className="field">
                <label htmlFor="dname">Display Name</label>
                <input className="input" id="dname" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={readOnly} />
                {!nameValid && !readOnly && <p className="sub">Add your name to save.</p>}
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input
                    className="input"
                    id="email"
                    type="email"
                    value={data.email ?? ''}
                    disabled
                    title="Contact your Auntie to change your sign-in email."
                  />
                </div>
                <div className="field">
                  <label htmlFor="phone">Phone</label>
                  <input className="input" id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 014 2298" disabled={readOnly} />
                </div>
              </div>
            </section>

            {/* RECOVERY CONTACTS */}
            <section className="glass card d2">
              <div className="sectlabel">Recovery Contacts</div>
              <h3 className="title">Secondary Contact</h3>
              <p className="sub">A backup person we can reach if we cannot reach you during a visit.</p>

              <div style={{ marginTop: 18 }}>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="bemail">Backup Email</label>
                    <input
                      className="input"
                      id="bemail"
                      type="email"
                      value={backupEmail}
                      onChange={(e) => setBackupEmail(e.target.value)}
                      placeholder="name@example.com"
                      disabled={readOnly}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="bphone">Backup Phone</label>
                    <input
                      className="input"
                      id="bphone"
                      type="tel"
                      value={backupPhone}
                      onChange={(e) => setBackupPhone(e.target.value)}
                      placeholder="(555) 000 0000"
                      disabled={readOnly}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => invite.mutate()}
                    disabled={invite.isPending || !backupEmail.trim().includes('@') || readOnly}
                  >
                    {'✉️'} {invite.isPending ? 'Sending…' : 'Send Invite'}
                  </button>
                  {inviteStatus && (
                    <span className={`note${inviteStatus.tone === 'err' ? ' err' : ''}`}>
                      <span className="dot" />
                      {inviteStatus.text}
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* BILLING */}
            <section className="glass card d3">
              <div className="sectlabel">Billing Details</div>
              <div className="billrow">
                <div className="ico">{'\u{1F4B3}'}</div>
                <div className="bt">
                  <b>{cardOnFile ? 'Payment method on file' : 'No payment method on file'}</b>
                  <small>{cardSubtitle}</small>
                </div>
                {readOnly ? (
                  <span className="btn ghost sm navlink-inert" title="Operator view is read-only">
                    Manage
                  </span>
                ) : (
                  <button
                    className="btn ghost sm"
                    type="button"
                    onClick={() => setManagingBilling((open) => !open)}
                    aria-expanded={managingBilling}
                    aria-controls="billing-manage"
                  >
                    {managingBilling ? 'Close' : 'Manage'}
                  </button>
                )}
              </div>

              {managingBilling && !readOnly && (
                <div className="billing-manage" id="billing-manage" data-testid="billing-manage">
                  {paymentMethod.isLoading ? (
                    <p className="sub">Checking what is on file…</p>
                  ) : paymentMethod.isError ? (
                    <div className="note err" role="alert">
                      <span className="dot" />
                      {billingReadError}
                      <button
                        className="btn ghost sm"
                        type="button"
                        style={{ marginLeft: 10 }}
                        onClick={() => void paymentMethod.refetch()}
                      >
                        Try again
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="sub" style={{ marginTop: 0 }}>
                        {cardOnFile
                          ? 'Cards are held by Stripe. Tribe Tails never sees the full number.'
                          : 'Adding a card sends you to Stripe. Nothing is charged when you save it.'}
                      </p>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <button
                          className="btn grad sm"
                          type="button"
                          onClick={() => startCardSetup.mutate()}
                          disabled={startCardSetup.isPending || removeCard.isPending}
                        >
                          {startCardSetup.isPending
                            ? 'Opening Stripe…'
                            : cardOnFile
                              ? 'Replace card'
                              : 'Add a card'}
                        </button>
                        {cardOnFile &&
                          (confirmingCardRemoval ? (
                            <>
                              <button
                                className="btn purple sm"
                                type="button"
                                onClick={() => removeCard.mutate()}
                                disabled={removeCard.isPending}
                              >
                                {removeCard.isPending ? 'Removing…' : 'Yes, take it off'}
                              </button>
                              <button
                                className="btn ghost sm"
                                type="button"
                                onClick={() => setConfirmingCardRemoval(false)}
                                disabled={removeCard.isPending}
                              >
                                Never mind
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn ghost sm"
                              type="button"
                              onClick={() => setConfirmingCardRemoval(true)}
                              disabled={startCardSetup.isPending}
                            >
                              Remove card
                            </button>
                          ))}
                      </div>
                      {confirmingCardRemoval && (
                        <p className="sub">
                          Removing the card leaves any unpaid invoices exactly as they are. You will settle them
                          another way until a new card is added.
                        </p>
                      )}
                      {billingStatus && (
                        <span className={`note${billingStatus.tone === 'err' ? ' err' : ''}`} role="status">
                          <span className="dot" />
                          {billingStatus.text}
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              <p className="sub" style={{ marginTop: 12 }}>
                No payment method on file means visits cannot be charged automatically.
              </p>
            </section>
          </div>

          {/* aside */}
          <div className="stack">
            <section className="glass card d4">
              <div className="sectlabel">
                Your tribe <Link to="/kin">The Kin</Link>
              </div>
              {kin.isLoading ? (
                <p className="sub">Loading your kin…</p>
              ) : (
                roster.map((k, i) => (
                  <Link className={`kinrow ${kinVariant(i)}`} to="/kin/$kinId" params={{ kinId: k.id }} key={k.id}>
                    <div className="pic">
                      {k.photoUrl ? <img src={k.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : speciesEmoji(k.species)}
                    </div>
                    <div>
                      <b>{k.name ?? 'Unnamed Kin'}</b>
                      <small>{[k.breed, k.ageYears !== null ? `${k.ageYears} yrs` : null].filter(Boolean).join(', ').toUpperCase()}</small>
                    </div>
                  </Link>
                ))
              )}
            </section>

            <section className="glass card d4">
              <div className="sectlabel">Cared for by</div>
              <h3 className="title">{businessName}</h3>
              <p className="sub">Your care team can see your profile name and contact details to reach you about visits.</p>
              <div style={{ marginTop: 14 }}>
                <Link className="btn ghost block" to="/messages">
                  {'\u{1F4AC}'} Message your Auntie
                </Link>
              </div>
            </section>
          </div>
        </div>

        {/* sticky save bar */}
        <div className="savebar">
          {status && (
            <span className={`note${status.tone === 'err' ? ' err' : ''}`}>
              <span className="dot" />
              {status.text}
            </span>
          )}
          <span className="grow" />
          {confirmingSignOut ? (
            <>
              <span className="sub">Sign out of MyTribe?</span>
              <button className="btn ghost" type="button" onClick={() => setConfirmingSignOut(false)}>
                Cancel
              </button>
              <button className="btn coral" type="button" onClick={signOut} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Yes, Sign Out'}
              </button>
            </>
          ) : (
            <button className="btn coral" type="button" onClick={() => setConfirmingSignOut(true)}>
              Sign Out
            </button>
          )}
          {!readOnly && (
            <button className="btn grad" type="button" onClick={() => save.mutate()} disabled={save.isPending || !nameValid}>
              {save.isPending ? 'Saving…' : <>{'✓'} Save Changes</>}
            </button>
          )}
        </div>

        <p className="footnote">
          Cared for by <b>{businessName}</b>
        </p>
      </div>
    </>
  );
}
