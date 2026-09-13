import { useCallback, useEffect, useState } from 'react';
import { Link, linkOptions } from '@tanstack/react-router';
import { getKin, type KinDetail } from '../api/kinView';
import { getKin411, type Kin411 } from '../api/recipientContext';
import { updateKinTags } from '../api/directoryWrite';
import { initialsOf } from '../api/directory';
import { type Async } from '../lib/async';
import {
  DenScreenHeading,
  DenPanel,
  EmptyHint,
  StatusPill,
  type Crumb,
} from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { GhostButton } from '../components/Buttons';
import { RecentKinTalesPanel, UpcomingVisitsPanel } from '../components/KinfolkProfileFeeds';
import { ProfileTagsSection } from '../components/ProfileTagsSection';
import { KinEdit } from './KinEdit';
import './KinView.css';

interface KinViewProps {
  kinId: string;
  /** From the Directory row, so the header names the pet before the doc loads. */
  kinName: string;
  /**
   * The household this pet lives in, for the middle breadcrumb step and the
   * hero's "belongs to" line. Resolved by the Directory from the streams it
   * already holds, and OMITTED when it could not be resolved: the step is
   * dropped rather than filled with a guess.
   */
  household?: { id: string; name: string };
  /**
   * Which screen swapped this view in, which is the only thing that knows where
   * closing it lands (#689). This view is not a route: it opens without touching
   * the URL, from the Directory's Kin tab OR from a kin row on a household
   * profile, and `onBack` returns to whichever of the two it was. Naming the
   * opener is what lets the Back label and the trail tell the truth about that
   * instead of both saying "Directory" from inside a household.
   */
  openedFrom: 'directory' | 'profile';
  onBack: () => void;
}

/**
 * The mock's hero line under the name: "Labrador Retriever · 5 yrs · neutered
 * male · 68 lbs". Breed leads, and species stands in only when no breed is on
 * file; blanks drop out rather than leaving a dangling dot. Colour and
 * markings ride at the end, since the mock has no other home for them and
 * they are identity in the same way the breed is.
 */
export function kinHeroLine(k: KinDetail): string {
  const parts = [
    k.breed.trim() !== '' ? k.breed : k.species,
    k.age.trim() !== '' ? `${k.age} yrs` : '',
    sexLine(k.sex, k.spayedNeutered),
    k.weight,
    k.colorMarkings,
  ];
  return parts
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join(' · ');
}

/**
 * "neutered male" / "spayed female" the way the mock says it, from the free-text
 * `sex` and the `spayedNeutered` flag. A sex the two words do not fit keeps its
 * own wording and takes the flag after it.
 */
function sexLine(sex: string, spayedNeutered: boolean): string {
  const s = sex.trim();
  if (!spayedNeutered) return s;
  const lower = s.toLowerCase();
  if (lower.startsWith('f')) return 'spayed female';
  if (lower.startsWith('m')) return 'neutered male';
  return s === '' ? 'spayed / neutered' : `${s} · spayed / neutered`;
}

/** The mock's `.field`: a dim key on the left, the value on the right. */
function Field({ label, value }: { label: string; value: string }) {
  if (value.trim() === '') return null;
  return (
    <div className="kview__field">
      <dt className="kview__field-k">{label}</dt>
      <dd className="kview__field-v">{value}</dd>
    </div>
  );
}

/** The mock's `.d11 .row`: a mono uppercase question over a prose answer. */
function Answer({ q, a }: { q: string; a: string }) {
  if (a.trim() === '') return null;
  return (
    <div className="kview__row">
      <dt className="kview__q">{q}</dt>
      <dd className="kview__a">{a}</dd>
    </div>
  );
}

function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

/** The legacy free-text checklist, one row per line, blank lines dropped. */
function checklistLines(checklist: string): string[] {
  return checklist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Kin (pet) detail view, the screen `auntieos-kin-detail-2026-05-27.html`
 * draws: a hero band naming the pet, then two columns of panels in the mock's
 * own order. Left: Care checklist, Medical, Auntie's notes. Right: The 411, the
 * pet's KinTales, Upcoming KinCare. Every panel renders, with a quiet empty
 * line when there is nothing on file, so the page has the same shape for every
 * pet.
 *
 * Reads the FULL `kin/{id}` doc via `getKin` (a one-shot getDoc; the list
 * stream carries list fields only), the pet's 411 via `getKin411` (admin-only,
 * which this screen is), and the household's KinTale and session feeds narrowed
 * to this pet (`KinfolkProfileFeeds`).
 *
 * Rulings this screen carries: tags are pills next to the name (#686); no
 * subtitle under the name (#688); a REACTIVE pet gets a warning pill under the
 * identity block rather than a page banner (#690); there is no "New KinTale"
 * action, since a KinTale is only ever started from a KinCare (#676).
 */
export function KinView({ kinId, kinName, household, openedFrom, onBack }: KinViewProps) {
  const [kin, setKin] = useState<Async<KinDetail>>({ status: 'loading' });
  // The pet's 411, read alongside the doc rather than joined into it: a 411 that
  // fails to load must say so on its own panel while the rest of the page
  // stands, and `null` is the ordinary case for a pet nobody has written up.
  const [the411, setThe411] = useState<Async<Kin411 | null>>({ status: 'loading' });
  // The editor is a sub-view of this detail screen: Edit swaps to KinEdit, and a
  // save/archive returns here + reloads so the fresh doc renders.
  const [editing, setEditing] = useState(false);
  // The tag editor (ProfileTagsSection) stays the same component, just no
  // longer permanently on screen as its own panel: the pills next to the name
  // are the default view, and this toggle is the smaller of the two ways to
  // keep editing reachable (the alternative, moving tag editing into KinEdit,
  // would break the kinfolk profile's own rule that tags are edited on the
  // profile screen, never the edit form; see KinfolkEdit.tsx's note on the
  // same point).
  const [tagsOpen, setTagsOpen] = useState(false);

  const load = useCallback(() => {
    let live = true;
    setKin({ status: 'loading' });
    setThe411({ status: 'loading' });
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
    void (async () => {
      try {
        const data = await getKin411(kinId);
        if (live) setThe411({ status: 'ready', data });
      } catch (err) {
        if (live) {
          setThe411({
            status: 'error',
            message: err instanceof Error ? err.message : 'Load failed',
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

  // `auntieos-kin-detail-2026-05-27.html`: Directory / Lorna Wren / Biscuit.
  // WHICH STEP IS A LINK DEPENDS ON WHERE THIS VIEW OPENED, because a `<Link>`
  // to the address you are already standing on is a step that does nothing when
  // clicked (see `Crumb` in DenScreenKit). From the Kin tab the URL is
  // `/directory`, so the household profile is elsewhere and is the anchor;
  // from a household profile the URL is already `/directory/{id}`, so it is the
  // Directory that is elsewhere and the household step closes back down to the
  // profile underneath. The hero's "belongs to" line follows the same rule.
  const openedFromProfile = openedFrom === 'profile';
  const householdCrumb: Crumb[] = household
    ? [
        openedFromProfile
          ? { label: household.name, onSelect: onBack }
          : {
              label: household.name,
              link: linkOptions({
                to: '/directory/$kinfolkId',
                params: { kinfolkId: household.id },
              }),
            },
      ]
    : [];
  // Closing lands on the opener, so the button says the opener. "Back to
  // Directory" from inside a household was the complaint in #689: it named a
  // screen the click does not go to.
  const backLabel = openedFromProfile
    ? `Back to ${household ? household.name : 'the household'}`
    : 'Back to Directory';

  const loaded = kin.status === 'ready' ? kin.data : null;
  const heroLine = loaded !== null ? kinHeroLine(loaded) : '';

  // The mock's hero past the name: the photo, the "belongs to" line and the
  // tag row. They are the kit band's own slots since #780 (`leading`,
  // `children`, `badges`), which is why this screen no longer lays an
  // identity strip out under the band. Every one of them is the loaded doc's,
  // so each is `false` while the read is in flight and the band draws no
  // wrapper for it; the name, the trail and the actions stand without them.
  const loadedId = loaded !== null && loaded._id !== '' ? loaded._id : kinId;
  const homeId =
    loaded !== null && loaded.kinfolkId.trim() !== '' ? loaded.kinfolkId : (household?.id ?? '');
  const ownerLabel = household ? household.name : 'the household';
  const loadedStatus = loaded !== null ? loaded.status.trim().toLowerCase() : '';

  return (
    <div className="screen">
      <DenScreenHeading
        crumbs={[
          openedFromProfile
            ? { label: 'Directory', link: linkOptions({ to: '/directory' }) }
            : { label: 'Directory', onSelect: onBack },
          ...householdCrumb,
          { label: kinName || kinId },
        ]}
        title={kinName || kinId}
        {...(heroLine !== '' ? { detail: heroLine } : {})}
        leading={
          loaded !== null && (
            <Avatar
              label={loaded.name}
              imageUrl={loaded.profilePictureUrl}
              initials={initialsOf(loaded.name)}
              size={120}
              gradientSeed={loadedId}
            />
          )
        }
        badges={
          loaded !== null && (
            <>
              {/* The mock draws no status on a pet, because the pet it draws
                  is active. One that is not must still say so. */}
              {loadedStatus !== '' && loadedStatus !== 'active' && (
                <StatusPill label={loadedStatus} tone="neutral" />
              )}
              {loaded.tags.map((tag) => (
                <StatusPill key={tag} label={tag} tone="muted" />
              ))}
              <button
                type="button"
                className="kview__tags-edit"
                onClick={() => setTagsOpen((open) => !open)}
              >
                {tagsOpen ? 'Done' : 'Edit tags'}
              </button>
            </>
          )
        }
        trailing={
          <>
            <GhostButton label="Edit kin" onClick={() => setEditing(true)} />
            <GhostButton label={backLabel} onClick={onBack} />
          </>
        }
      >
        {loaded !== null && homeId !== '' && (
          <p className="kview__owner">
            belongs to{' '}
            {openedFromProfile ? (
              <button type="button" className="kview__owner-step" onClick={onBack}>
                {ownerLabel}
              </button>
            ) : (
              <Link to="/directory/$kinfolkId" params={{ kinfolkId: homeId }} className="kview__owner-step">
                {ownerLabel}
              </Link>
            )}
          </p>
        )}
      </DenScreenHeading>

      <AsyncRegion
        state={kin}
        what="kin"
        isEmpty={() => false}
        loading={<p className="kview__hint">Loading kin…</p>}
        empty={<EmptyHint>Nothing to show.</EmptyHint>}
      >
        {(k) => {
          const petId = k._id !== '' ? k._id : kinId;
          const lines = checklistLines(k.checklist);
          const scope = { kinId: petId, kinName: k.name };
          const hasCare = any(k.staysAs, k.routine, k.trainingCommands, k.feedingBrand);
          return (
            <>
              {/* #690: a marker under the hero band, not a page banner and not
                  a pill in the band's tag row. The operator asked for it under
                  the box rather than among the tags, and the ruling outranks
                  the mock's `.tag.alert`, so it stays out of `badges`. */}
              {k.reactive && (
                <div className="kview__flags">
                  <StatusPill label="Reactive: handle with care" tone="warning" />
                </div>
              )}

              {tagsOpen && (
                <ProfileTagsSection
                  scope="pet"
                  initialTags={k.tags}
                  onSaveTags={(next) => updateKinTags(petId, next)}
                />
              )}

              <div className="kview__cols">
                <div className="kview__col">
                  {/* The mock's checklist is the per-visit ChecklistItem template.
                      The pet doc holds the admin's own care instructions (stays
                      as, routine, training, food) and a legacy free-text
                      checklist that is read-only on both platforms, and those
                      are what a visit needs to know, so they live here. */}
                  <DenPanel title="Care checklist" meta="per visit" className="d1">
                    {hasCare && (
                      <dl className="kview__fields">
                        <Field label="Stays as" value={k.staysAs} />
                        <Field label="Routine" value={k.routine} />
                        <Field label="Training / commands" value={k.trainingCommands} />
                        <Field label="Food / brand" value={k.feedingBrand} />
                      </dl>
                    )}
                    {lines.length > 0 && (
                      <ul className="kview__checklist">
                        {lines.map((line, i) => (
                          <li key={`${i}-${line}`} className="kview__ck">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!hasCare && lines.length === 0 && (
                      <EmptyHint>No care notes for {k.name} yet.</EmptyHint>
                    )}
                  </DenPanel>

                  <DenPanel title="Medical" meta={`${k.name} only`} className="d2">
                    {any(k.vaccinations, k.medicationHealthNotes, k.vetInfo) ? (
                      <dl className="kview__fields">
                        <Field label="Vaccinations" value={k.vaccinations} />
                        <Field label="Medication / health notes" value={k.medicationHealthNotes} />
                        <Field label="Vet info" value={k.vetInfo} />
                      </dl>
                    ) : (
                      <EmptyHint>No medical notes for {k.name} yet.</EmptyHint>
                    )}
                  </DenPanel>

                  {/* Props one per line on purpose: the apostrophe in the title
                      throws off the class scan in styles/tokenUsage.test.ts
                      when it shares a line with `className`. */}
                  <DenPanel
                    title="Auntie's notes"
                    meta="admin only"
                    className="d3"
                  >
                    {k.officeNotes.trim() !== '' ? (
                      <p className="kview__notebox">{k.officeNotes}</p>
                    ) : (
                      <EmptyHint>No notes yet.</EmptyHint>
                    )}
                  </DenPanel>
                </div>

                <div className="kview__col">
                  <DenPanel title="The 411" meta="auto-generated" className="d4">
                    <AsyncRegion
                      state={the411}
                      what={`${k.name}'s 411`}
                      isEmpty={(f) =>
                        f === null ||
                        !any(
                          f.tldr,
                          f.personality,
                          f.quirksAndPreferences,
                          f.dietaryDetails,
                          f.medicalNotes,
                        )
                      }
                      empty={<EmptyHint>No 411 for {k.name} yet.</EmptyHint>}
                    >
                      {(f) =>
                        f === null ? null : (
                          <dl className="kview__rows">
                            <Answer q="In short" a={f.tldr} />
                            <Answer q="Personality" a={f.personality} />
                            <Answer q="Quirks and preferences" a={f.quirksAndPreferences} />
                            <Answer q="Diet" a={f.dietaryDetails} />
                            <Answer q="Medical notes" a={f.medicalNotes} />
                          </dl>
                        )
                      }
                    </AsyncRegion>
                  </DenPanel>

                  {homeId !== '' ? (
                    <>
                      <RecentKinTalesPanel kinfolkId={homeId} kin={scope} />
                      <UpcomingVisitsPanel kinfolkId={homeId} kin={scope} />
                    </>
                  ) : (
                    // A pet with no household on file has no feed to narrow:
                    // KinTales and visits are booked against a household. Said,
                    // rather than two panels quietly reading as "none".
                    <DenPanel title={`${k.name}'s KinTales`}>
                      <EmptyHint>
                        No household on file for {k.name}, so no KinTales or visits can be
                        matched.
                      </EmptyHint>
                    </DenPanel>
                  )}
                </div>
              </div>
            </>
          );
        }}
      </AsyncRegion>
    </div>
  );
}
