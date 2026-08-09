import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { getKinfolkProfile, type KinfolkProfile as Profile } from '../api/kinfolkProfile';
import { updateKinfolkTags } from '../api/directoryWrite';
import { kinfolkDisplayName, initialsOf, type Kin } from '../api/directory';
import { type Async } from '../lib/async';
import { str } from '../lib/coerce';
import { formatJoinDate } from '../lib/joinDate';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { HouseholdVetPanels } from '../components/HouseholdVetPanels';
import { Avatar } from '../components/Avatar';
import { GhostButton } from '../components/Buttons';
import { ProfileTagsSection } from '../components/ProfileTagsSection';
import { MaskedValue } from '../components/MaskedValue';
import { PrimaryButton } from '../components/Buttons';
import { KinfolkEdit } from './KinfolkEdit';
import { HouseholdData } from './HouseholdData';
import './KinfolkProfile.css';

interface KinfolkProfileProps {
  kinfolkId: string;
  /** From the Directory row, so the header names the household before the doc loads. */
  kinfolkName: string;
  /** The household's active kin, already streamed by the Directory (no second read). */
  kin: Kin[];
  onBack: () => void;
}

/**
 * One label/value line; renders nothing when the value is blank (never "undefined").
 * `secret` routes the value through MaskedValue, so an access code is hidden until
 * the operator asks for it; the label doubles as the toggle's spoken field name.
 */
function Fact({
  label,
  value,
  mono,
  secret,
}: {
  label: string;
  value: string;
  mono?: boolean;
  secret?: boolean;
}) {
  if (value.trim() === '') return null;
  return (
    <div className="kprofile__fact">
      <dt className="kprofile__fact-label">{label}</dt>
      <dd className={mono ? 'kprofile__fact-value kprofile__fact-value--mono' : 'kprofile__fact-value'}>
        {secret === true ? <MaskedValue value={value} field={label.toLowerCase()} /> : value}
      </dd>
    </div>
  );
}

/** True when a section has at least one non-blank field (so an all-blank section hides). */
function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

/**
 * Household profile detail view: the read-only screen Directory's onSelectKinfolk
 * opens (Directory shipped list-only). Reads the FULL `kinfolk/{id}` doc via
 * `getKinfolkProfile` (a one-shot getDoc; the list stream only carries list
 * fields). Organized into fielded sections (Contact, Home & Access, Emergency,
 * Vet, Kin) so it is not one undifferentiated scroll (AO-48); an all-blank
 * section is omitted rather than shown empty. The household's kin come from the
 * Directory's own KIN_QUERY stream, passed in, so this opens with no second read.
 */
/**
 * Sub-views this profile can swap in. Directory owns the Directory/profile
 * switch the same way, so the editor and the household record stay local state
 * rather than routes, matching `KinView`'s existing precedent.
 */
type ProfileView = 'profile' | 'edit' | 'household';
export function KinfolkProfile({ kinfolkId, kinfolkName, kin, onBack }: KinfolkProfileProps) {
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
        onCancel={() => setView('profile')}
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
  // page-specs Decision 8 still puts it under Directory / Households /
  // {household} / Members, which is what that path spells.
  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title={kinfolkName || kinfolkId}
        subtitle="Household profile."
        trailing={
          <div className="kinfolk-profile__actions">
            <GhostButton label="Household data" onClick={() => setView('household')} />
            {/* B1 has its own route, so it gets a real anchor rather than a
                state swap: the operator can link it, bookmark it, and open it
                in a new tab, and browser Back returns here. It borrows
                GhostButton's classes so the row still reads as one control
                group. */}
            <Link
              to="/household-members/$kinfolkId"
              params={{ kinfolkId }}
              className="auntie-btn auntie-btn--ghost"
            >
              <span className="auntie-btn__label">Members and invites</span>
            </Link>
            <PrimaryButton label="Edit" onClick={() => setView('edit')} />
            <GhostButton label="Back to Directory" onClick={onBack} />
          </div>
        }
      />

      <AsyncRegion
        state={profile}
        what="household"
        isEmpty={() => false}
        loading={<p className="kprofile__hint">Loading household…</p>}
        empty={<EmptyHint>Nothing to show.</EmptyHint>}
      >
        {(p) => {
          const name = kinfolkDisplayName(p);
          return (
            <>
              <DenPanel title="Household">
                <div className="kprofile__head">
                  <Avatar
                    label={name}
                    imageUrl={p.profilePictureUrl}
                    initials={initialsOf(name)}
                    size={56}
                    shape="rounded"
                    gradientSeed={p._id !== '' ? p._id : name}
                  />
                  <div className="kprofile__head-text">
                    <span className="kprofile__name">{name}</span>
                    <span className="kprofile__status" data-tone={p.status.toLowerCase()}>
                      {p.status.trim() === '' ? '-' : p.status.toLowerCase()}
                    </span>
                    {/*
                      Read in the operator's locale, not in storage's. A legacy
                      value `formatJoinDate` cannot read prints exactly as stored,
                      which is honest, and is why this never renders "Invalid Date".
                    */}
                    {p.joinDate.trim() !== '' && (
                      <span className="kprofile__since">Joined {formatJoinDate(p.joinDate)}</span>
                    )}
                  </div>
                </div>
              </DenPanel>

              <ProfileTagsSection
                scope="household"
                initialTags={p.tags}
                onSaveTags={(next) => updateKinfolkTags(p._id !== '' ? p._id : kinfolkId, next)}
              />

              <DenPanel title="Contact">
                <dl className="kprofile__facts">
                  <Fact label="Phone" value={p.phoneNumber} mono />
                  <Fact label="Email" value={p.email} />
                  <Fact label="Secondary phone" value={p.secondaryPhone} mono />
                  <Fact label="Secondary email" value={p.secondaryEmail} />
                  <Fact label="Preferred contact" value={p.preferredContactMethod} />
                  <Fact label="Best time to reach" value={p.bestTimeToContact} />
                  {!any(p.phoneNumber, p.email, p.secondaryPhone, p.secondaryEmail, p.preferredContactMethod, p.bestTimeToContact) && (
                    <EmptyHint>No contact details on file.</EmptyHint>
                  )}
                </dl>
              </DenPanel>

              {any(p.serviceAddress, p.gateCode, p.parkingInstructions, p.entryNotes, p.wifiName, p.wifiPassword) && (
                <DenPanel title="Home & access">
                  <dl className="kprofile__facts">
                    <Fact label="Service address" value={p.serviceAddress} />
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
                  </dl>
                </DenPanel>
              )}

              {any(p.emergencyContactName, p.emergencyContactPhone, p.emergencyContactRelation) && (
                <DenPanel title="Emergency">
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
                  same single record the Household Data screen edits and the vet
                  clinics manager corrects. */}
              <HouseholdVetPanels kinfolkId={kinfolkId} />
              <DenPanel title={`Kin${kin.length > 0 ? ` · ${kin.length}` : ''}`} subtitle="Kin in this household.">
                {kin.length === 0 ? (
                  <EmptyHint>No kin on file for this household.</EmptyHint>
                ) : (
                  <ul className="kprofile__kin">
                    {kin.map((k) => {
                      // These rows render `api/directory.ts#Kin`, which is a CAST over the
                      // streamed `kin` docs, not a validated merge like the `p` profile
                      // above (`mergeKinfolkProfile`). A legacy mirror doc genuinely lacks
                      // `species`/`age`/`name`, and an unguarded read would throw mid-render
                      // and blank the whole profile over one pet. Coerced to '' here, which
                      // is the same blank the filters and `initialsOf` already expect.
                      const name = str(k.name);
                      const age = str(k.age);
                      const detail = [str(k.species), str(k.breed), age !== '' ? `${age} yrs` : '']
                        .filter((s) => s !== '')
                        .join(' · ');
                      return (
                        <li key={k._id} className="kprofile__kin-row">
                          <Avatar
                            label={name}
                            imageUrl={k.profilePictureUrl}
                            initials={initialsOf(name)}
                            size={36}
                            shape="rounded"
                            gradientSeed={k._id !== '' ? k._id : name}
                          />
                          <span className="kprofile__kin-text">
                            <span className="kprofile__kin-name">{name}</span>
                            {detail !== '' && <span className="kprofile__kin-detail">{detail}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </DenPanel>
            </>
          );
        }}
      </AsyncRegion>
    </div>
  );
}
