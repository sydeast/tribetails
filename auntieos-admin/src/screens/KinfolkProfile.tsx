import { useCallback, useEffect, useState } from 'react';
import { Link, linkOptions } from '@tanstack/react-router';
import { getKinfolkProfile, type KinfolkProfile as Profile } from '../api/kinfolkProfile';
import { kinfolkDisplayName, initialsOf, type Kin } from '../api/directory';
import { getKin411 } from '../api/recipientContext';
import { type Async } from '../lib/async';
import { str } from '../lib/coerce';
import { directionsHref } from '../lib/directions';
import { formatJoinDate } from '../lib/joinDate';
import { tenureLabel } from '../lib/kinfolkProfileFeeds';
import { useHistoryBack } from '../lib/useHistoryBack';
import { DenBreadcrumbs, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { HouseholdVetPanels } from '../components/HouseholdVetPanels';
import { AuntieNotesPanel } from '../components/AuntieNotesPanel';
import {
  RecentKinTalesPanel,
  UpcomingVisitsPanel,
  HouseholdInvoicesPanel,
} from '../components/KinfolkProfileFeeds';
import { Avatar } from '../components/Avatar';
import { GhostButton } from '../components/Buttons';
import { MaskedValue } from '../components/MaskedValue';
import { KinfolkEdit } from './KinfolkEdit';
import { HouseholdData } from './HouseholdData';
import './KinfolkProfile.css';

interface KinfolkProfileProps {
  kinfolkId: string;
  /** From the Directory row, so the header names the household before the doc loads. */
  kinfolkName: string;
  /** The household's active kin, already streamed by the Directory (no second read). */
  kin: Kin[];
  /**
   * True while that stream is still in flight.
   *
   * `kin` is `[]` both when the household has no pets and when the Directory has
   * not read them yet, and the two must not render the same: "No kin on file"
   * and a "0 kin" count are CLAIMS, and this app does not make a claim out of a
   * read that has not landed (the `StatCard` rule).
   */
  kinPending?: boolean;
  /**
   * Where Back goes on a COLD arrival only (#689). This screen is its own route
   * (`/directory/{kinfolkId}`), so an operator who walked here has an entry
   * behind them and Back returns to that instead, whatever it was. This runs
   * when there is none, which is why the Directory is still right for it.
   */
  onBack: () => void;
  /**
   * Open one kin's own detail view. The mock draws every kin row as a chevroned,
   * clickable row, and the Directory already owns a `KinView` swap for exactly
   * that; without a handler the rows render as plain rows rather than as buttons
   * that would do nothing.
   */
  onOpenKin?: (kin: Kin) => void;
}

/**
 * One label/value line; renders nothing when the value is blank (never "undefined").
 * `secret` routes the value through MaskedValue, so an access code is hidden until
 * the operator asks for it; the label doubles as the toggle's spoken field name.
 * `directions` renders the value as a link that opens it in Google Maps for
 * turn-by-turn directions (issue #685), the same way Call and Text in the hero
 * are real `tel:`/`sms:` anchors rather than plain text.
 */
function Fact({
  label,
  value,
  mono,
  secret,
  directions,
}: {
  label: string;
  value: string;
  mono?: boolean;
  secret?: boolean;
  directions?: boolean;
}) {
  if (value.trim() === '') return null;
  return (
    <div className="kprofile__fact">
      <dt className="kprofile__fact-label">{label}</dt>
      <dd className={mono ? 'kprofile__fact-value kprofile__fact-value--mono' : 'kprofile__fact-value'}>
        {directions === true ? (
          <a href={directionsHref(value)} target="_blank" rel="noopener">
            {value}
          </a>
        ) : secret === true ? (
          <MaskedValue value={value} field={label.toLowerCase()} />
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** True when a section has at least one non-blank field. */
function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

function firstNonBlank(...values: string[]): string {
  return values.find((v) => v.trim() !== '') ?? '';
}

/**
 * Household profile detail view: the read-only screen Directory's onSelectKinfolk
 * opens (Directory shipped list-only). Reads the FULL `kinfolk/{id}` doc via
 * `getKinfolkProfile` (a one-shot getDoc; the list stream only carries list
 * fields). The household's kin come from the Directory's own KIN_QUERY stream,
 * passed in, so this opens with no second read.
 *
 * LAID OUT AS AN OPERATOR WALK REORDERED IT (walk `admin-2026-09-10`, issues
 * #678/#682, superseding the mock's original left/right split): a breadcrumb
 * trail, a hero carrying the household's identity and the actions that act on
 * it, then two columns. The LEFT column is the household's own facts (Contact,
 * the access panel, Emergency Contacts, the vet panels, Auntie's notes). The RIGHT
 * column is who they have and what has happened or is coming: Kin, Upcoming
 * KinCare, Recent KinTales, Invoices, in that order. Below the mock's own
 * 860px breakpoint the two columns become one, which is also what the Android
 * profile is.
 *
 * WHERE THIS DELIBERATELY CARRIES MORE THAN THE MOCK: the mock's own header says
 * its content is illustrative placeholder, so its five-row "Household" panel is a
 * sketch of a facts panel, not a list of the only five facts a household has. The
 * fielded sections (Contact / the access panel / Emergency Contacts) stay, because every
 * field in them is persisted and an Auntie standing on a doorstep needs the gate
 * code. Same for the controls the mock does not draw (Edit, Household data,
 * Members and invites, the masked secrets, the vet panels): each is a standing
 * ruling or a route decision made after this mock was drawn. Household tags
 * moved the other way (#681): they now show as read-only pills in the hero,
 * and the tag editor itself lives on the Edit form rather than on this
 * read-only screen.
 *
 * Sub-views this profile can swap in: Directory owns the Directory/profile
 * switch the same way, so the editor and the household record stay local state
 * rather than routes, matching `KinView`'s precedent. The KinTale composer used
 * to be a third one, opened from a hero "New KinTale" primary; #676 removed
 * that entry point (a KinTale is only ever started from a KinCare session, not
 * a bare household), so this profile no longer opens a composer at all.
 */
type ProfileView = 'profile' | 'edit' | 'household';

export function KinfolkProfile({
  kinfolkId,
  kinfolkName,
  kin,
  kinPending = false,
  onBack,
  onOpenKin,
}: KinfolkProfileProps) {
  const [view, setView] = useState<ProfileView>('profile');
  const [profile, setProfile] = useState<Async<Profile>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setProfile({ status: 'loading' });
    void (async () => {
      try {
        const data = await getKinfolkProfile(kinfolkId);
        if (live) setProfile({ status: 'ready', data });
      } catch (err) {
        if (live) {
          setProfile({
            status: 'error',
            message: `getKinfolkProfile failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => load(), [load]);

  // The mock's kin rows carry a line of personality ("loves sticks, hates the
  // mailman"). No field on the flat `kin` doc holds that: it lives in the pet's
  // 411, which is ADMIN-ONLY and therefore readable on this screen and on no
  // kinfolk-facing surface. One point read per kin, exactly as the Android
  // profile already does, and a read that fails is SAID rather than dropped.
  const [kinNotes, setKinNotes] = useState<Record<string, string>>({});
  const [kinNotesFailed, setKinNotesFailed] = useState(false);
  // Keyed by the ids, not the array: `kin` is a fresh array on every Directory
  // render, and depending on it directly would re-read the 411s forever.
  const kinKey = kin.map((k) => k._id).join(',');
  useEffect(() => {
    let live = true;
    setKinNotes({});
    setKinNotesFailed(false);
    const ids = kinKey === '' ? [] : kinKey.split(',');
    void (async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const f = await getKin411(id);
            const note = f === null ? '' : firstNonBlank(f.tldr, f.personality, f.quirksAndPreferences);
            return [id, note] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      if (!live) return;
      const next: Record<string, string> = {};
      let failed = false;
      for (const [id, note] of results) {
        if (note === null) failed = true;
        else if (note !== '') next[id] = note;
      }
      setKinNotes(next);
      setKinNotesFailed(failed);
    })();
    return () => {
      live = false;
    };
  }, [kinKey]);

  // #689. Above the sub-view returns because a hook cannot sit behind one.
  const back = useHistoryBack({ fallbackLabel: 'Directory', onFallback: onBack });

  if (view === 'edit') {
    return (
      <KinfolkEdit
        kinfolkId={kinfolkId}
        kinfolkName={kinfolkName}
        onDone={() => {
          setView('profile');
          // Re-read so the profile shows what was just saved, not the values it
          // loaded before the edit.
          load();
        }}
        onCancel={() => {
          setView('profile');
          // The Edit form's tag panel saves each add/remove the moment it
          // happens (ProfileTagsSection's own optimistic save), not on this
          // screen's Save button. Cancelling out still leaves those tag writes
          // in place, so this re-reads too: otherwise the hero's tag pills would
          // keep showing what was loaded before the edit, not what is now
          // actually on the household.
          load();
        }}
      />
    );
  }
  if (view === 'household') {
    return (
      <HouseholdData kinfolkId={kinfolkId} kinfolkName={kinfolkName} onBack={() => setView('profile')} />
    );
  }
  // B1, members and invites, used to be a fourth sub-view here. It is now
  // reached only through its own route (`/household-members/{kinfolkId}`), so
  // there is exactly one way to open it and the URL always says it is open.

  const loaded = profile.status === 'ready' ? profile.data : null;
  const heroName = loaded !== null ? kinfolkDisplayName(loaded) : kinfolkName || kinfolkId;
  const phone = loaded !== null ? loaded.phoneNumber.trim() : '';
  const tenure = loaded !== null ? tenureLabel(loaded.joinDate, new Date()) : null;

  return (
    <div className="screen">
      {/*
        Directory is a real anchor: this profile only ever mounts under
        `/directory/{id}`, so `/directory` is somewhere else and the step can be
        middle-clicked and copied like any link. "Kinfolk" is the LIST'S OWN
        kinfolk tab, a sibling view rather than a second route, so it is the
        button `DenBreadcrumbs` renders for exactly that case. The mock's trail
        is these three steps.
      */}
      <DenBreadcrumbs
        crumbs={[
          { label: 'Directory', link: linkOptions({ to: '/directory' }) },
          { label: 'Kinfolk', onSelect: onBack },
          { label: heroName },
        ]}
      />

      {/*
        The mock's hero, and the reason the old "Household" panel is gone: this
        screen used to print the household's name in the page heading and then
        print it again, with the avatar, in the first panel below it. One
        identity block now: avatar, name, where they stand in the relationship,
        and the actions that act on them.

        It sits OUTSIDE the AsyncRegion on purpose. The Directory hands the name
        down, so the hero can name the household before the doc lands, and Back
        stays reachable while the read is in flight or failing.
      */}
      <header className="kprofile__hero">
        <Avatar
          label={heroName}
          {...(loaded !== null ? { imageUrl: loaded.profilePictureUrl } : {})}
          initials={initialsOf(heroName)}
          size={72}
          shape="rounded"
          gradientSeed={kinfolkId}
        />
        <div className="kprofile__hero-text">
          <h1 className="kprofile__hero-name">{heroName}</h1>
          {loaded !== null && loaded.joinDate.trim() !== '' && (
            /*
              Read in the operator's locale, not in storage's. A legacy value
              `formatJoinDate` cannot read prints exactly as stored, which is
              honest, and is why this never renders "Invalid Date".
            */
            <p className="kprofile__hero-where">Joined {formatJoinDate(loaded.joinDate)}</p>
          )}
          <div className="kprofile__chips">
            {loaded !== null && (
              <span className="kprofile__chip" data-tone={loaded.status.toLowerCase()}>
                {loaded.status.trim() === '' ? 'no status' : loaded.status.toLowerCase()}
              </span>
            )}
            {/* Tenure, from the join date. Absent when the stored date is one
                nobody can read, rather than a fabricated "0 months". */}
            {tenure !== null && <span className="kprofile__chip kprofile__chip--tenure">{tenure}</span>}
            {/* Household tags, read-only pills next to the name and status
                (#681). The mock's hero draws its `.tags` row this way; editing
                them is a Kinfolk edit rather than a hero action, so it lives on
                the Edit form (`KinfolkEdit`'s own Tags panel), not here. */}
            {loaded !== null &&
              loaded.tags.map((tag) => (
                <span key={tag} className="kprofile__chip kprofile__chip--tag">
                  {tag}
                </span>
              ))}
          </div>
        </div>
        <div className="kinfolk-profile__actions">
          {/* Call and Text: `tel:` and `sms:` anchors, the same two quick actions
              the Android profile has had in its QuickContactBar. Rendered only
              once a real number has been read, never as dead controls. */}
          {phone !== '' && (
            <>
              <a href={`tel:${phone}`} className="auntie-btn auntie-btn--ghost">
                <span className="auntie-btn__label">Call</span>
              </a>
              <a href={`sms:${phone}`} className="auntie-btn auntie-btn--ghost">
                <span className="auntie-btn__label">Text</span>
              </a>
            </>
          )}
          <GhostButton label="Household data" onClick={() => setView('household')} />
          {/* B1 has its own route, so it gets a real anchor rather than a state
              swap: the operator can link it, bookmark it, and open it in a new
              tab, and browser Back returns here. It borrows GhostButton's
              classes so the row still reads as one control group. */}
          <Link
            to="/household-members/$kinfolkId"
            params={{ kinfolkId }}
            className="auntie-btn auntie-btn--ghost"
          >
            <span className="auntie-btn__label">Members and invites</span>
          </Link>
          <GhostButton label="Edit" onClick={() => setView('edit')} />
          <GhostButton label={back.label} onClick={back.goBack} />
          {/* The hero used to end with a "New KinTale" primary. Operator ruling
              (#676, walk admin-2026-09-10): a KinTale is only ever started from
              a KinCare session, so a standalone entry point on the household
              profile is gone. The KinTales list screen keeps its own "New
              KinTale" button under the same ruling; that button is unaffected
              by this change. */}
        </div>
      </header>

      <div className="kprofile__cols">
        <div className="kprofile__col">
          <AsyncRegion
            state={profile}
            what="household"
            isEmpty={() => false}
            loading={<p className="kprofile__hint">Loading household…</p>}
            empty={<EmptyHint>Nothing to show.</EmptyHint>}
          >
            {(p) => (
              <>
                {/* CONTACT FIRST under the hero (#679, holds once Kin has moved
                    to the right column, #678): the household's own facts, not
                    who lives there. The service address folded in here from its
                    own "Home & access" panel: an address is a way to reach the
                    household same as a phone number is. Gate code, parking,
                    entry notes and Wi-Fi stay in the access panel below, since
                    the issue that asked for this only named the home address.
                    The address itself opens Google Maps directions (#685), the
                    way Call and Text in the hero are real tel:/sms: anchors. */}
                <DenPanel title="Contact">
                  <dl className="kprofile__facts">
                    <Fact label="Phone" value={p.phoneNumber} mono />
                    <Fact label="Email" value={p.email} />
                    <Fact label="Secondary phone" value={p.secondaryPhone} mono />
                    <Fact label="Secondary email" value={p.secondaryEmail} />
                    <Fact label="Preferred contact" value={p.preferredContactMethod} />
                    <Fact label="Best time to reach" value={p.bestTimeToContact} />
                    <Fact label="Service address" value={p.serviceAddress} directions />
                    {!any(
                      p.phoneNumber,
                      p.email,
                      p.secondaryPhone,
                      p.secondaryEmail,
                      p.preferredContactMethod,
                      p.bestTimeToContact,
                      p.serviceAddress,
                    ) && <EmptyHint>No contact details on file.</EmptyHint>}
                  </dl>
                </DenPanel>

                {/*
                  ALWAYS RENDERED, empty or not (#407): a household with no gate
                  code and no parking note still needs to see this panel as a
                  thing it could fill in, not have it vanish. Only the address
                  moved out, into Contact above (#679); gate code, parking, entry
                  notes and Wi-Fi stay here, because they are about getting into
                  the home once an Auntie has already found it, which the
                  address answers on its own.
                */}
                <DenPanel title="Home & access">
                  <dl className="kprofile__facts">
                    <Fact label="Gate code" value={p.gateCode} mono secret />
                    <Fact label="Parking" value={p.parkingInstructions} />
                    <Fact label="Entry notes" value={p.entryNotes} />
                    {/*
                      The network name and the password are two rows now. They used to
                      be one string ending in "password on file", which hid the value
                      but still announced that a password existed; the row now carries
                      the real thing behind a toggle, and a household with no password
                      simply has no password row.
                    */}
                    <Fact label="Wi-Fi network" value={p.wifiName} />
                    <Fact label="Wi-Fi password" value={p.wifiPassword} mono secret />
                    {!any(p.gateCode, p.parkingInstructions, p.entryNotes, p.wifiName, p.wifiPassword) && (
                      <EmptyHint>No entry details on file.</EmptyHint>
                    )}
                  </dl>
                </DenPanel>

                {any(p.emergencyContactName, p.emergencyContactPhone, p.emergencyContactRelation) && (
                  <DenPanel title="Emergency Contacts">
                    <dl className="kprofile__facts">
                      <Fact label="Name" value={p.emergencyContactName} />
                      <Fact label="Phone" value={p.emergencyContactPhone} mono />
                      <Fact label="Relation" value={p.emergencyContactRelation} />
                    </dl>
                  </DenPanel>
                )}

                {/* THE VET IS READ, NOT OWNED. Operator ruling 2026-08-01:
                    "vet info lives on household data, it can be seen on the kin
                    profile". These panels used to read `p.vetClinicName` and
                    friends off the kinfolk doc, which is the copy that made the
                    vet authored in two places at once. They now resolve through
                    `household_data`'s clinic id, so what is shown here is the
                    same single record the Household Data screen edits and the
                    vet clinics manager corrects. The clinic address is a
                    directions link too (#685), for the same reason the service
                    address above is one. */}
                <HouseholdVetPanels kinfolkId={kinfolkId} />

                {/* The mock's "Auntie's notes · admin only", last in this
                    column now that household tags moved to the hero (#681).
                    Admin-only, and only ever on an admin surface: see the
                    panel's own note. */}
                <AuntieNotesPanel kinfolkId={kinfolkId} />
              </>
            )}
          </AsyncRegion>
        </div>

        {/* The right column: who they have and what has happened or is coming.
            Kin leads it now that it has moved out of the left column (#678),
            followed by the three feed cards in the order the operator asked
            for (#682). Each card owns its own household-scoped read, so one
            failing does not take the profile down with it. */}
        <div className="kprofile__col">
          <DenPanel
            title="Kin"
            {...(kinPending ? {} : { meta: kin.length === 1 ? '1 kin' : `${kin.length} kin` })}
            subtitle="Kin in this household."
          >
            {kinPending ? (
              <div role="status" aria-live="polite">
                <p className="kprofile__hint">Loading kin…</p>
              </div>
            ) : kin.length === 0 ? (
              <EmptyHint>No kin on file for this household.</EmptyHint>
            ) : (
              <ul className="kprofile__kin">
                {kin.map((k) => {
                  // These rows render `api/directory.ts#Kin`, which is a CAST over the
                  // streamed `kin` docs, not a validated merge like the `p` profile
                  // below (`mergeKinfolkProfile`). A legacy mirror doc genuinely lacks
                  // `species`/`age`/`name`, and an unguarded read would throw mid-render
                  // and blank the whole profile over one pet. Coerced to '' here, which
                  // is the same blank the filters and `initialsOf` already expect.
                  const name = str(k.name);
                  const age = str(k.age);
                  const detail = [str(k.species), str(k.breed), age !== '' ? `${age} yrs` : '']
                    .filter((s) => s !== '')
                    .join(' · ');
                  const note = kinNotes[k._id] ?? '';
                  const body = (
                    <>
                      <Avatar
                        label={name}
                        imageUrl={k.profilePictureUrl}
                        initials={initialsOf(name)}
                        size={44}
                        shape="circle"
                        gradientSeed={k._id !== '' ? k._id : name}
                      />
                      <span className="kprofile__kin-text">
                        <span className="kprofile__kin-name">{name}</span>
                        {detail !== '' && <span className="kprofile__kin-detail">{detail}</span>}
                        {note !== '' && <span className="kprofile__kin-note">{note}</span>}
                      </span>
                    </>
                  );
                  return (
                    <li key={k._id}>
                      {onOpenKin ? (
                        <button
                          type="button"
                          className="kprofile__kin-row kprofile__kin-row--open"
                          onClick={() => onOpenKin(k)}
                        >
                          {body}
                          <span className="kprofile__kin-chev" aria-hidden="true">
                            ›
                          </span>
                        </button>
                      ) : (
                        <span className="kprofile__kin-row">{body}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Fail loud, quietly: the row is still right, one line of it is
                missing, and the operator is told which half is unknown. */}
            {kinNotesFailed && (
              <p className="kprofile__hint" role="status">
                Some kin notes couldn&rsquo;t be read, so a row may be missing its
                line about the pet.
              </p>
            )}
          </DenPanel>

          <UpcomingVisitsPanel kinfolkId={kinfolkId} />
          <RecentKinTalesPanel kinfolkId={kinfolkId} />
          <HouseholdInvoicesPanel kinfolkId={kinfolkId} />
        </div>
      </div>
    </div>
  );
}
