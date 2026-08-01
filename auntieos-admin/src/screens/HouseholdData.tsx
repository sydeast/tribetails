import { useCallback, useState, type ReactNode } from 'react';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { DenPanel, DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
import { GhostButton } from '../components/Buttons';
import { MaskedValue } from '../components/MaskedValue';
import { HouseholdSectionDialog } from '../components/HouseholdSectionDialog';
import { useToast } from '../components/Toast';
import { useOneShot } from '../lib/useOneShot';
import { getTestScope } from '../lib/testScope';
import {
  HOUSEHOLD_SECTIONS,
  legacyVetLeftovers,
  sectionFilledCount,
  type HouseholdSectionSpec,
} from '../lib/householdDataSchema';
import { getKinfolkProfile, type KinfolkProfile } from '../api/kinfolkProfile';
import { useCollection } from '../lib/firestore';
import { VET_CLINICS_QUERY, type VetClinic } from '../api/vetClinics';
import {
  blankHouseholdRecord,
  getDossierHouseholdNotes,
  getHouseholdData,
  type HouseholdRecord,
} from '../api/householdData';
import './HouseholdData.css';

interface HouseholdDataProps {
  kinfolkId: string;
  /** From the household profile, so the heading names the household before the read lands. */
  kinfolkName: string;
  onBack: () => void;
}

/**
 * Household Data: the shared record behind a Kinfolk, ported from android
 * `ui/directory/HouseholdDataScreen.kt` + `HouseholdDataViewModel.kt`.
 *
 * The android screen is a single scrolling form: 30 always-editable inputs
 * across five cards, one Save button at the bottom, and a whole-document write
 * when you press it. This port keeps all five sections and all 30 fields, and
 * changes two things on purpose.
 *
 *  READ FIRST, EDIT ON REQUEST. The resting state is a legible record: what is
 *  on file, what is still blank, section by section. This screen is read at a
 *  doorstep far more often than it is written, and a page of input boxes is a
 *  poor thing to read the emergency vet's number off. Editing is per section,
 *  through a modal (see HouseholdSectionDialog).
 *
 *  BLANK IS SHOWN, NOT HIDDEN. Every field renders even when empty, marked "Not
 *  set". The Kotlin does the same job by appending "· empty" to a label; this
 *  screen's entire purpose is migrating loose dossier prose into structured
 *  fields, so the gaps ARE the content. `KinfolkProfile`'s convention of hiding
 *  blank facts is the right call there and the wrong one here.
 */
export function HouseholdData({ kinfolkId, kinfolkName, onBack }: HouseholdDataProps) {
  const household = kinfolkName.trim() === '' ? kinfolkId : kinfolkName;

  // `household_data` is `allow read, write: if isAuntie()` with no test-admin
  // branch (firestore.rules:601), so a sandbox account is denied outright and
  // there is no kinfolkId predicate that could buy the permission. Saying so is
  // truer than letting a raw "Missing or insufficient permissions" land on a
  // screen the operator cannot fix, which is the same call lib/testScope.ts
  // makes for the suppressed collections.
  const sandbox = getTestScope();

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title="Household"
        accentTail="data"
        subtitle={`The shared record behind ${household}: vet, supplies, routines, and who covers Auntie.`}
        trailing={<GhostButton label="Back to household" onClick={onBack} />}
      />

      {sandbox !== null ? (
        <Banner tone="info" title="Not available on a sandbox account">
          <p>
            Household data is operator-only, so this record stays out of the sandbox tribe. Nothing
            failed here, and nothing is hidden: sign in on the operator account to read or edit it.
          </p>
        </Banner>
      ) : (
        <HouseholdRecordView kinfolkId={kinfolkId} household={household} onOpenProfile={onBack} />
      )}
    </div>
  );
}

/**
 * Split from the exported screen so the sandbox branch above can return before
 * any read is opened, without the hooks below becoming conditional.
 */
function HouseholdRecordView({
  kinfolkId,
  household,
  onOpenProfile,
}: {
  kinfolkId: string;
  household: string;
  /** Back to the household profile, where the vet is actually picked. */
  onOpenProfile: () => void;
}) {
  const { showToast } = useToast();

  const loaded = useOneShot(() => getHouseholdData(kinfolkId), 'getHouseholdData');
  const notes = useOneShot(() => getDossierHouseholdNotes(kinfolkId), 'getDossierHouseholdNotes');

  /**
   * The canonical vet (punchlist A2). This screen no longer authors one, it
   * reads the household profile's, and the catalog listener supplies the
   * clinic's opening hours, which live on the clinic rather than per household.
   */
  const vet = useOneShot(() => getKinfolkProfile(kinfolkId), 'getKinfolkProfile');
  const clinics = useCollection<VetClinic>(VET_CLINICS_QUERY);

  /**
   * The record as it stands after a save. `useOneShot` exposes no reload outside
   * its own error retry, and it does not need one: `saveHouseholdSection`
   * returns the merged record, so a confirmed write updates the view with the
   * data the write itself produced. Nothing here is optimistic, this state is
   * only ever set after Firestore has acknowledged the write.
   */
  const [saved, setSaved] = useState<HouseholdRecord | null>(null);
  const [editing, setEditing] = useState<HouseholdSectionSpec | null>(null);

  const handleSaved = useCallback(
    (next: HouseholdRecord, section: HouseholdSectionSpec) => {
      setSaved(next);
      setEditing(null);
      showToast(`Saved ${section.title.toLowerCase()} for ${household}.`);
    },
    [showToast, household],
  );

  /**
   * A landed save OVERRIDES the original read, rather than being merged into it.
   *
   * This is the branch that would otherwise lie: a household with no record
   * resolves `empty`, and if the empty branch merely rendered `saved` inside
   * itself, the "Nothing on file yet" banner would still be sitting above the
   * section an operator had just filled in. Replacing the state means the first
   * successful save moves the whole region into the data branch, which is what
   * actually happened.
   */
  const state: Async<HouseholdRecord | null> =
    saved !== null ? { status: 'ready', data: saved } : loaded;

  const dialogFor = (record: HouseholdRecord) =>
    editing === null ? null : (
      <HouseholdSectionDialog
        section={editing}
        kinfolkName={household}
        record={record}
        onClose={() => setEditing(null)}
        onSaved={(next) => handleSaved(next, editing)}
      />
    );

  return (
    <>
      <AsyncRegion
        state={notes}
        what="dossier notes"
        isEmpty={(text) => text.trim() === ''}
        // No card at all when the dossier has nothing to migrate. The android
        // source ALSO hides this card when the read FAILS; that half is not
        // ported, because a swallowed read is how a screen ends up quietly
        // missing the very notes it exists to help you transcribe.
        empty={null}
      >
        {(text) => (
          <DenPanel
            title="From the dossier"
            subtitle="Admin only. Internal."
            collapsible
            initiallyExpanded
          >
            <p className="hdata__notes-lede">
              Loose notes written before this record existed. Copy what belongs into the sections
              below; the dossier keeps its own copy either way.
            </p>
            <p className="hdata__notes">{text}</p>
          </DenPanel>
        )}
      </AsyncRegion>

      <AsyncRegion
        state={state}
        what="household data"
        isEmpty={(record) => record === null}
        loading={<HouseholdSkeleton />}
        empty={
          <EmptyRecord
            kinfolkId={kinfolkId}
            household={household}
            onEdit={setEditing}
            dialog={dialogFor}
            vet={vet}
            clinics={clinics}
            onOpenProfile={onOpenProfile}
          />
        }
      >
        {(record) => {
          // Non-null in this branch (isEmpty above owns the null case), but
          // AsyncRegion cannot narrow the caller's own type parameter for us.
          const current = record ?? blankHouseholdRecord(kinfolkId);
          return (
            <>
              <Sections
                record={current}
                onEdit={setEditing}
                vet={vet}
                clinics={clinics}
                onOpenProfile={onOpenProfile}
              />
              {dialogFor(current)}
            </>
          );
        }}
      </AsyncRegion>
    </>
  );
}

/**
 * The proven-empty branch: no record on file. Still renders every section, so
 * the first save can start from whichever one the operator has the answers for,
 * rather than forcing a "create record" step that writes nothing useful.
 */
function EmptyRecord({
  kinfolkId,
  household,
  onEdit,
  dialog,
  vet,
  clinics,
  onOpenProfile,
}: {
  kinfolkId: string;
  household: string;
  onEdit: (section: HouseholdSectionSpec) => void;
  dialog: (record: HouseholdRecord) => ReactNode;
  vet: Async<KinfolkProfile>;
  clinics: Async<VetClinic[]>;
  onOpenProfile: () => void;
}) {
  const blank = blankHouseholdRecord(kinfolkId);
  return (
    <>
      <Banner tone="info" title="Nothing on file yet">
        <p>
          No household record for {household} so far. Open any section below and save it, and the
          record starts there.
        </p>
      </Banner>
      <Sections
        record={blank}
        onEdit={onEdit}
        vet={vet}
        clinics={clinics}
        onOpenProfile={onOpenProfile}
      />
      {dialog(blank)}
    </>
  );
}

function Sections({
  record,
  onEdit,
  vet,
  clinics,
  onOpenProfile,
}: {
  record: HouseholdRecord;
  onEdit: (section: HouseholdSectionSpec) => void;
  vet: Async<KinfolkProfile>;
  clinics: Async<VetClinic[]>;
  onOpenProfile: () => void;
}) {
  return (
    <>
      {HOUSEHOLD_SECTIONS.map((section) => {
        // The veterinary section is read through from the household profile
        // (punchlist A2), so it renders its own panel rather than this one.
        if (section.editor === 'vetPicker') {
          return (
            <VeterinarySection
              key={section.id}
              section={section}
              record={record}
              vet={vet}
              clinics={clinics}
              onOpenProfile={onOpenProfile}
            />
          );
        }
        const filled = sectionFilledCount(section, record);
        const total = section.fields.length;
        return (
          <DenPanel
            key={section.id}
            title={section.title}
            subtitle={`${filled} of ${total} on file · ${section.blurb}`}
            trailing={
              <GhostButton label={`Edit ${section.title.toLowerCase()}`} onClick={() => onEdit(section)} />
            }
          >
            {filled === 0 && (
              <EmptyHint>
                Nothing filled in here yet, so every field below reads &ldquo;Not set&rdquo;.
              </EmptyHint>
            )}
            <dl className="hdata__facts">
              {section.fields.map((field) => {
                const value = record[field.key];
                return (
                  <div className="hdata__fact" key={field.key}>
                    <dt className="hdata__fact-label">{field.label}</dt>
                    <dd className="hdata__fact-value">
                      {field.secret === true ? (
                        <MaskedValue value={value} field={field.label.toLowerCase()} />
                      ) : value.trim() === '' ? (
                        <span className="hdata__unset">Not set</span>
                      ) : (
                        value
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </DenPanel>
        );
      })}
    </>
  );
}

/**
 * The veterinary panel, read through from the household profile (punchlist A2).
 *
 * This screen used to author its own `primaryVet*` / `emergencyVet*` free text,
 * which meant the vet existed twice with nothing tying the copies together, and
 * the copy shown HERE, on the screen this file's own header describes as the one
 * someone reads the emergency vet's number off, was the copy that could go stale
 * without anything saying so.
 *
 * It now shows the `kinfolk` record: the regular and emergency clinics the
 * household picked from the shared catalog, each carrying the clinic's id. That
 * is the copy `updateVetClinic` can correct and fan out, which is the only
 * reason a wrong number can be fixed at all.
 *
 * Hours come from the CLINIC, not from the household. Every household using a
 * practice shares its opening hours, so one copy lives on the catalog row and
 * this reads through to it. The old per-household `primaryVetHours` is one of
 * the legacy fields below.
 */
function VeterinarySection({
  section,
  record,
  vet,
  clinics,
  onOpenProfile,
}: {
  section: HouseholdSectionSpec;
  record: HouseholdRecord;
  vet: Async<KinfolkProfile>;
  clinics: Async<VetClinic[]>;
  onOpenProfile: () => void;
}) {
  const leftovers = legacyVetLeftovers(record);
  const clinicRows = clinics.status === 'ready' ? clinics.data : [];
  const hoursFor = (clinicId: string): string => {
    if (clinicId.trim() === '') return '';
    return (clinicRows.find((c) => c._id === clinicId)?.hours ?? '').trim();
  };

  return (
    <DenPanel
      title={section.title}
      subtitle={section.blurb}
      trailing={<GhostButton label="Edit on the profile" onClick={onOpenProfile} />}
    >
      <AsyncRegion
        state={vet}
        what="the household's vet"
        // A profile always resolves to a record, blank or not, so there is no
        // empty case distinct from "every vet field is unset". The rows below
        // render those as "Not set", which is the honest shape here: on this
        // record the gaps ARE the content.
        isEmpty={() => false}
        empty={null}
      >
        {(profile) => {
          const hasRegular =
            [profile.vetClinicName, profile.vetClinicPhone, profile.vetClinicAddress].some(
              (s) => s.trim() !== '',
            );
          const hasEmergency = [
            profile.emergencyVetClinicName,
            profile.emergencyVetClinicPhone,
            profile.emergencyVetClinicAddress,
          ].some((s) => s.trim() !== '');

          return (
            <>
              {!hasRegular && !hasEmergency && (
                <EmptyHint>
                  No vet on file for this household. Pick one on the household profile and it
                  appears here.
                </EmptyHint>
              )}
              <dl className="hdata__facts">
                <VetRow label="Primary vet" value={profile.vetClinicName} />
                <VetRow label="Primary vet phone" value={profile.vetClinicPhone} />
                <VetRow label="Primary vet hours" value={hoursFor(profile.vetClinicId)} />
                <VetRow label="Primary vet address" value={profile.vetClinicAddress} />
                <VetRow label="Emergency vet" value={profile.emergencyVetClinicName} />
                <VetRow label="Emergency vet phone" value={profile.emergencyVetClinicPhone} />
                <VetRow
                  label="Emergency vet hours"
                  value={hoursFor(profile.emergencyVetClinicId)}
                />
                <VetRow label="Emergency vet address" value={profile.emergencyVetClinicAddress} />
              </dl>

              {/* An unlinked household is not an error, but it IS a fact worth
                  stating: a correction made in the vet bank cannot reach it,
                  because there is no clinic id to match on. */}
              {hasRegular && profile.vetClinicId.trim() === '' && (
                <Banner tone="warning" title="This vet is not linked to the catalog">
                  <p>
                    The name and number above are on file, but no clinic is selected, so
                    correcting this clinic in the vet bank will not update this household.
                    Re-pick it on the profile to link them.
                  </p>
                </Banner>
              )}
            </>
          );
        }}
      </AsyncRegion>

      {/* Fail loud, never silent: this record still carries the retired
          free-text copy, so it is shown rather than dropped, and named as
          superseded rather than presented as a second opinion. */}
      {leftovers.length > 0 && (
        <Banner tone="warning" title="Older vet notes are still on this record">
          <p>
            These were typed here before the vet moved to the household profile. They are not
            used anywhere and are not kept up to date. The migration moves anything the profile
            is missing; whatever is left below is a duplicate or a conflict to resolve by hand.
          </p>
          <dl className="hdata__facts">
            {leftovers.map((field) => (
              <div className="hdata__fact" key={field.key}>
                <dt className="hdata__fact-label">{field.label}</dt>
                <dd className="hdata__fact-value">{record[field.key]}</dd>
              </div>
            ))}
          </dl>
        </Banner>
      )}
    </DenPanel>
  );
}

function VetRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hdata__fact">
      <dt className="hdata__fact-label">{label}</dt>
      <dd className="hdata__fact-value">
        {value.trim() === '' ? <span className="hdata__unset">Not set</span> : value}
      </dd>
    </div>
  );
}

/** Section-shaped placeholders while the read is in flight. Claims no values, only shape. */
function HouseholdSkeleton() {
  return (
    <div className="hdata__skeleton">
      {HOUSEHOLD_SECTIONS.map((section) => (
        <div className="hdata__skeleton-panel" key={section.id}>
          <span className="hdata__skeleton-bar hdata__skeleton-bar--title" />
          <span className="hdata__skeleton-bar" />
          <span className="hdata__skeleton-bar hdata__skeleton-bar--short" />
        </div>
      ))}
      <p className="hdata__skeleton-label">Reading the household record…</p>
    </div>
  );
}
