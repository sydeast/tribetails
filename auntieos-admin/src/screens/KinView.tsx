import { useCallback, useEffect, useState } from 'react';
import { linkOptions } from '@tanstack/react-router';
import { getKin, type KinDetail } from '../api/kinView';
import { updateKinTags } from '../api/directoryWrite';
import { initialsOf } from '../api/directory';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { Banner } from '../components/Banner';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { ProfileTagsSection } from '../components/ProfileTagsSection';
import { KinEdit } from './KinEdit';
import './KinView.css';

interface KinViewProps {
  kinId: string;
  /** From the Directory row, so the header names the pet before the doc loads. */
  kinName: string;
  /**
   * The household this pet lives in, for the middle breadcrumb step. Resolved
   * by the Directory from the streams it already holds, and OMITTED when it
   * could not be resolved: the step is dropped rather than filled with a guess.
   */
  household?: { id: string; name: string };
  onBack: () => void;
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (value.trim() === '') return null;
  return (
    <div className="kview__fact">
      <dt className="kview__fact-label">{label}</dt>
      <dd className={mono ? 'kview__fact-value kview__fact-value--mono' : 'kview__fact-value'}>{value}</dd>
    </div>
  );
}

function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

/**
 * Kin (pet) detail view: the read-only screen Directory's onSelectKin opens
 * (Directory shipped list-only). Reads the FULL `kin/{id}` doc via `getKin` (a
 * one-shot getDoc; the list stream carries list fields only). Organized into
 * fielded sections (Basics, Behavior & care, Feeding, Health, Owner contact,
 * Notes); an all-blank section is omitted. A REACTIVE pet is flagged loudly up
 * top, since that is a handle-with-care safety signal, not just another field.
 */
export function KinView({ kinId, kinName, household, onBack }: KinViewProps) {
  const [kin, setKin] = useState<Async<KinDetail>>({ status: 'loading' });
  // The editor is a sub-view of this detail screen: Edit swaps to KinEdit, and a
  // save/archive returns here + reloads so the fresh doc renders.
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    let live = true;
    setKin({ status: 'loading' });
    void (async () => {
      try {
        const data = await getKin(kinId);
        if (live) setKin({ status: 'ready', data });
      } catch (err) {
        if (live) {
          setKin({
            status: 'error',
            message: `getKin failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [kinId]);

  useEffect(() => load(), [load]);

  if (editing) {
    return (
      <KinEdit
        kinId={kinId}
        kinName={kinName}
        onDone={() => {
          setEditing(false);
          load();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="screen">
      <DenScreenHeading
        // `auntieos-kin-detail-2026-05-27.html`: Directory / Lorna Wren / Biscuit.
        // The household step is a real route link (this view sits on
        // `/directory`, so `/directory/{id}` is somewhere else); the Directory
        // step is not, because this view opened without changing the URL.
        crumbs={[
          { label: 'Directory', onSelect: onBack },
          ...(household
            ? [
                {
                  label: household.name,
                  link: linkOptions({
                    to: '/directory/$kinfolkId',
                    params: { kinfolkId: household.id },
                  }),
                },
              ]
            : []),
          { label: kinName || kinId },
        ]}
        title={kinName || kinId}
        subtitle="Kin profile."
        trailing={
          <>
            <GhostButton label="Back to Directory" onClick={onBack} />
            <PrimaryButton label="Edit" onClick={() => setEditing(true)} />
          </>
        }
      />

      <AsyncRegion
        state={kin}
        what="kin"
        isEmpty={() => false}
        loading={<p className="kview__hint">Loading kin…</p>}
        empty={<EmptyHint>Nothing to show.</EmptyHint>}
      >
        {(k) => {
          const detail = [k.species, k.breed, k.age !== '' ? `${k.age} yrs` : '']
            .filter((s) => s !== '')
            .join(' · ');
          const spayed = k.spayedNeutered ? 'Yes' : '';
          return (
            <>
              {k.reactive && (
                <Banner tone="warning" title="Reactive: handle with care">
                  This pet is flagged reactive. Review the behavior notes below before the visit.
                </Banner>
              )}

              <DenPanel title="Kin">
                <div className="kview__head">
                  <Avatar
                    label={k.name}
                    imageUrl={k.profilePictureUrl}
                    initials={initialsOf(k.name)}
                    size={56}
                    shape="rounded"
                    gradientSeed={k._id !== '' ? k._id : k.name}
                  />
                  <div className="kview__head-text">
                    <span className="kview__name">{k.name}</span>
                    {detail !== '' && <span className="kview__detail">{detail}</span>}
                    <span className="kview__status" data-tone={k.status.toLowerCase()}>
                      {k.status.trim() === '' ? '-' : k.status.toLowerCase()}
                    </span>
                  </div>
                </div>
              </DenPanel>

              <ProfileTagsSection scope="pet" initialTags={k.tags} onSaveTags={(next) => updateKinTags(k._id !== '' ? k._id : kinId, next)} />

              <DenPanel title="Basics">
                <dl className="kview__facts">
                  <Fact label="Species" value={k.species} />
                  <Fact label="Breed" value={k.breed} />
                  <Fact label="Age" value={k.age} />
                  <Fact label="Sex" value={k.sex} />
                  <Fact label="Weight" value={k.weight} />
                  <Fact label="Color / markings" value={k.colorMarkings} />
                  <Fact label="Spayed / neutered" value={spayed} />
                  {!any(k.species, k.breed, k.age, k.sex, k.weight, k.colorMarkings, spayed) && (
                    <EmptyHint>No basics on file.</EmptyHint>
                  )}
                </dl>
              </DenPanel>

              {any(k.staysAs, k.routine, k.trainingCommands) && (
                <DenPanel title="Behavior & care">
                  <dl className="kview__facts">
                    <Fact label="Stays as" value={k.staysAs} />
                    <Fact label="Routine" value={k.routine} />
                    <Fact label="Training / commands" value={k.trainingCommands} />
                  </dl>
                </DenPanel>
              )}

              {any(k.feedingBrand) && (
                <DenPanel title="Feeding">
                  <dl className="kview__facts">
                    <Fact label="Food / brand" value={k.feedingBrand} />
                  </dl>
                </DenPanel>
              )}

              {any(k.vaccinations, k.medicationHealthNotes, k.vetInfo) && (
                <DenPanel title="Health">
                  <dl className="kview__facts">
                    <Fact label="Vaccinations" value={k.vaccinations} />
                    <Fact label="Medication / health notes" value={k.medicationHealthNotes} />
                    <Fact label="Vet info" value={k.vetInfo} />
                  </dl>
                </DenPanel>
              )}

              {any(k.ownerEmail, k.ownerPhone) && (
                <DenPanel title="Owner contact">
                  <dl className="kview__facts">
                    <Fact label="Email" value={k.ownerEmail} />
                    <Fact label="Phone" value={k.ownerPhone} mono />
                  </dl>
                </DenPanel>
              )}

              {any(k.officeNotes) && (
                <DenPanel title="Office notes" subtitle="Staff-only.">
                  <p className="kview__notes">{k.officeNotes}</p>
                </DenPanel>
              )}
            </>
          );
        }}
      </AsyncRegion>
    </div>
  );
}
