import { useCallback, useEffect, useState } from 'react';
import { getKinfolkProfile, type KinfolkProfile as Profile } from '../api/kinfolkProfile';
import { updateKinfolkTags } from '../api/directoryWrite';
import { kinfolkDisplayName, initialsOf, type Kin } from '../api/directory';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { GhostButton } from '../components/Buttons';
import { ProfileTagsSection } from '../components/ProfileTagsSection';
import './KinfolkProfile.css';

interface KinfolkProfileProps {
  kinfolkId: string;
  /** From the Directory row, so the header names the household before the doc loads. */
  kinfolkName: string;
  /** The household's active kin, already streamed by the Directory (no second read). */
  kin: Kin[];
  onBack: () => void;
}

/** One label/value line; renders nothing when the value is blank (never "undefined"). */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (value.trim() === '') return null;
  return (
    <div className="kprofile__fact">
      <dt className="kprofile__fact-label">{label}</dt>
      <dd className={mono ? 'kprofile__fact-value kprofile__fact-value--mono' : 'kprofile__fact-value'}>{value}</dd>
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
export function KinfolkProfile({ kinfolkId, kinfolkName, kin, onBack }: KinfolkProfileProps) {
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

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title={kinfolkName || kinfolkId}
        subtitle="Household profile."
        trailing={<GhostButton label="Back to Directory" onClick={onBack} />}
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
          const wifi =
            p.wifiName.trim() === '' && p.wifiPassword.trim() === ''
              ? ''
              : `${p.wifiName.trim() || '(unnamed)'}${p.wifiPassword.trim() !== '' ? ' · password on file' : ''}`;
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
                    {p.joinDate.trim() !== '' && (
                      <span className="kprofile__since">Joined {p.joinDate}</span>
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

              {any(p.serviceAddress, p.gateCode, p.parkingInstructions, p.entryNotes, wifi) && (
                <DenPanel title="Home & access">
                  <dl className="kprofile__facts">
                    <Fact label="Service address" value={p.serviceAddress} />
                    <Fact label="Gate code" value={p.gateCode} mono />
                    <Fact label="Parking" value={p.parkingInstructions} />
                    <Fact label="Entry notes" value={p.entryNotes} />
                    <Fact label="Wi-Fi" value={wifi} />
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

              {any(p.vetClinicName, p.vetClinicAddress, p.vetClinicPhone) && (
                <DenPanel title="Vet clinic">
                  <dl className="kprofile__facts">
                    <Fact label="Clinic" value={p.vetClinicName} />
                    <Fact label="Address" value={p.vetClinicAddress} />
                    <Fact label="Phone" value={p.vetClinicPhone} mono />
                  </dl>
                </DenPanel>
              )}

              <DenPanel title={`Kin${kin.length > 0 ? ` · ${kin.length}` : ''}`} subtitle="Pets in this household.">
                {kin.length === 0 ? (
                  <EmptyHint>No kin on file for this household.</EmptyHint>
                ) : (
                  <ul className="kprofile__kin">
                    {kin.map((k) => {
                      const detail = [k.species, k.breed, k.age !== '' ? `${k.age} yrs` : '']
                        .filter((s) => s !== '')
                        .join(' · ');
                      return (
                        <li key={k._id} className="kprofile__kin-row">
                          <Avatar
                            label={k.name}
                            imageUrl={k.profilePictureUrl}
                            initials={initialsOf(k.name)}
                            size={36}
                            shape="rounded"
                            gradientSeed={k._id !== '' ? k._id : k.name}
                          />
                          <span className="kprofile__kin-text">
                            <span className="kprofile__kin-name">{k.name}</span>
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
