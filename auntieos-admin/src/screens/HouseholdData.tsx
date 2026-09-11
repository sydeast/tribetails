import { useCallback, useState, type ReactNode } from 'react';
import { linkOptions } from '@tanstack/react-router';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { DenPanel, DenScreenHeading, EmptyHint, type Crumb } from '../components/DenScreenKit';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { MaskedValue } from '../components/MaskedValue';
import { HouseholdSectionDialog } from '../components/HouseholdSectionDialog';
import { VetSectionDialog } from '../components/VetSectionDialog';
import { useToast } from '../components/Toast';
import { useOneShot } from '../lib/useOneShot';
import { getTestScope } from '../lib/testScope';
import {
  HOUSEHOLD_SECTIONS,
  legacyVetLeftovers,
  sectionFilledCount,
  type HouseholdFields,
  type HouseholdFieldSpec,
  type HouseholdSectionSpec,
} from '../lib/householdDataSchema';
import { useCollection } from '../lib/firestore';
import { VET_CLINICS_QUERY, type VetClinic } from '../api/vetClinics';
import { resolveHouseholdVet, hasVet, type HouseholdVet } from '../lib/householdVet';
import {
  blankHouseholdRecord,
  getDossierHouseholdNotes,
  getHouseholdData,
  saveHouseholdSection,
  type HouseholdRecord,
} from '../api/householdData';
import './HouseholdData.css';

interface HouseholdDataProps {
  kinfolkId: string;
  /** From the household profile, so the heading names the household before the read lands. */
  kinfolkName: string;
  onBack: () => void;
  /**
   * The trail's "Kinfolk" step: the Directory's kinfolk tab, which is the
   * profile's own Back. The profile passes its `onBack` through; a caller with
   * no list to return to leaves it out and the trail drops that step.
   */
  onKinfolkList?: (() => void) | undefined;
}

/**
 * Household Data: the shared record behind a Kinfolk, ported from android
 * `ui/directory/HouseholdDataScreen.kt` + `HouseholdDataViewModel.kt`.
 *
 * The android screen is a single scrolling form: 30 always-editable inputs
 * across five cards, one Save button at the bottom, and a whole-document write
 * when you press it. This port originally kept all five sections and all 30
 * fields, and changed two things on purpose.
 *
 * As of 2026-08-04 this screen renders THREE sections, not five. The operator,
 * looking at this modal-edit UI: "I dont need this Emergency & Safety or
 * Service Provider boxes." Both are gone from `HOUSEHOLD_SECTIONS`
 * (lib/householdDataSchema.ts); their ten fields are untouched in Firestore
 * and in `HouseholdRecord`, just unrendered here, pending the household/
 * family-page redesign that gives emergency contacts a home of their own. See
 * the removal comment there before adding either section back or deleting
 * their fields. The mock carries the same removal (#755), so a later pass
 * against it does not draw the two panels back.
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
export function HouseholdData({ kinfolkId, kinfolkName, onBack, onKinfolkList }: HouseholdDataProps) {
  const household = kinfolkName.trim() === '' ? kinfolkId : kinfolkName;

  // The mock's trail: Directory / Kinfolk / <Name> / Household. Directory is
  // a real route and so an anchor; Kinfolk is the list's own tab, a sibling
  // view; the household's name closes this sub-view back down to the profile
  // (the same click as the Back button, see #689); Household is where you
  // are. The kicker this heading used to wear read word for word what the
  // Directory says two levels up, so it could not tell an operator which of
  // the two they had open.
  const crumbs: Crumb[] = [
    { label: 'Directory', link: linkOptions({ to: '/directory' }) },
    ...(onKinfolkList !== undefined ? [{ label: 'Kinfolk', onSelect: onKinfolkList }] : []),
    { label: household, onSelect: onBack },
    { label: 'Household' },
  ];

  // `household_data` is `allow read, write: if isAuntie()` with no test-admin
  // branch (firestore.rules:601), so a sandbox account is denied outright and
  // there is no kinfolkId predicate that could buy the permission. Saying so is
  // truer than letting a raw "Missing or insufficient permissions" land on a
  // screen the operator cannot fix, which is the same call lib/testScope.ts
  // makes for the suppressed collections.
  const sandbox = getTestScope();

  return (
    <div className="screen">
      {/*
        The mock's hero: "<Name> Household" in the title, the sentence behind
        the info button. The name used to sit on the detail line under a
        "Household data" title (#752); the mock puts it in the h1, so a screen
        reader's first announcement says whose record this is.

        The mock also leads the title with a House icon. `DenScreenHeading` has
        no leading slot until #780 lands, so the icon waits on that rather than
        being drawn beside the band by hand.
      */}
      <DenScreenHeading
        crumbs={crumbs}
        title={`${household} Household`}
        subtitle="The shared record behind this household: vet, supplies and routines, for every pet in the home."
        // Names the screen the click actually lands on (#689). This is a
        // sub-view of the household PROFILE, held in that screen's state, so
        // closing it never leaves `/directory/{id}`. "Back to household" named
        // no screen the operator could find; the household's own name does.
        trailing={<GhostButton label={`Back to ${household}`} onClick={onBack} />}
      />

      {sandbox !== null ? (
        <Banner tone="info" title="Not available on a sandbox account">
          <p>
            Household data is operator-only, so this record stays out of the sandbox tribe. Nothing
            failed here, and nothing is hidden: sign in on the operator account to read or edit it.
          </p>
        </Banner>
      ) : (
        <HouseholdRecordView kinfolkId={kinfolkId} household={household} />
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
}: {
  kinfolkId: string;
  household: string;
  /** Back to the household profile, where the vet is actually picked. */
}) {
  const { showToast } = useToast();

  const loaded = useOneShot(() => getHouseholdData(kinfolkId), 'getHouseholdData');
  const notes = useOneShot(() => getDossierHouseholdNotes(kinfolkId), 'getDossierHouseholdNotes');

  // The shared clinic catalog. The record stores a clinic id; everything shown
  // for the vet resolves through this listener, so there is one copy to correct.
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
   * The leftovers banner's "Clear old vet notes" write lands here too, so the
   * view updates from the write's own result the same way every other save
   * does (see the comment on `state` below for why that matters).
   */
  const handleClearedLegacy = useCallback(
    (next: HouseholdRecord) => {
      setSaved(next);
      showToast(`Cleared the old vet notes for ${household}.`);
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

  /**
   * Which editor a section gets, decided by the section itself.
   *
   * The veterinary section stores `vet_clinics` ids, so it goes to the picker;
   * everything else is prose an operator types. `HouseholdSectionDialog` also
   * enforces this on its own side (`EDITABLE_HOUSEHOLD_SECTIONS`), so a future
   * caller that forgets the branch gets a refusal rather than a text box holding
   * a raw document id.
   */
  const dialogFor = (record: HouseholdRecord) => {
    if (editing === null) return null;
    if (editing.editor === 'vetPicker') {
      return (
        <VetSectionDialog
          section={editing}
          kinfolkName={household}
          record={record}
          clinics={clinics}
          onClose={() => setEditing(null)}
          onSaved={(next) => handleSaved(next, editing)}
        />
      );
    }
    return (
      <HouseholdSectionDialog
        section={editing}
        kinfolkName={household}
        record={record}
        onClose={() => setEditing(null)}
        onSaved={(next) => handleSaved(next, editing)}
      />
    );
  };

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
          // "Admin only" is a statement about the panel, so it is the mock's
          // right-aligned mono note (`meta`); the sentence that used to open
          // the body is the explanation, so it is the tooltip (#758).
          <DenPanel
            title="From the dossier"
            subtitle="Loose notes written before this record existed. Copy what belongs into the sections below; the dossier keeps its own copy either way."
            meta="admin only"
            collapsible
            initiallyExpanded
          >
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
            onCleared={handleClearedLegacy}
            dialog={dialogFor}
            clinics={clinics}
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
                onCleared={handleClearedLegacy}
                clinics={clinics}
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
  onCleared,
  dialog,
  clinics,
}: {
  kinfolkId: string;
  household: string;
  onEdit: (section: HouseholdSectionSpec) => void;
  onCleared: (next: HouseholdRecord) => void;
  dialog: (record: HouseholdRecord) => ReactNode;
  clinics: Async<VetClinic[]>;
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
        onCleared={onCleared}
        clinics={clinics}
      />
      {dialog(blank)}
    </>
  );
}

/**
 * The entrance steps, literal so the stylesheet scan in
 * `styles/tokenUsage.test.ts` can see a gapless d1, d2, d3.
 */
const STAGGER: readonly ('d1' | 'd2' | 'd3')[] = ['d1', 'd2', 'd3'];

/**
 * A cell of the mock's two-column grid. A multiline field spans both columns
 * (its value is a paragraph), and so does a single-line field the mock gives
 * a full row to (`wide` on the spec).
 */
function factClass(field: HouseholdFieldSpec): string {
  return field.kind === 'multiline' || field.wide === true
    ? 'hdata__fact hdata__fact--wide'
    : 'hdata__fact';
}

function Sections({
  record,
  onEdit,
  onCleared,
  clinics,
}: {
  record: HouseholdRecord;
  onEdit: (section: HouseholdSectionSpec) => void;
  onCleared: (next: HouseholdRecord) => void;
  clinics: Async<VetClinic[]>;
}) {
  return (
    <>
      {HOUSEHOLD_SECTIONS.map((section, index) => {
        // The mock's panels enter one after another (`.panel.d1` to `.d5`).
        // Three sections remain, so three steps; the kit pins the fill mode
        // so a staggered panel is never left transformed.
        const stagger = STAGGER[index];
        // The veterinary section is read through from the household profile
        // (punchlist A2), so it renders its own panel rather than this one.
        if (section.editor === 'vetPicker') {
          return (
            <VeterinarySection
              key={section.id}
              section={section}
              record={record}
              clinics={clinics}
              onEdit={() => onEdit(section)}
              onCleared={onCleared}
              stagger={stagger}
            />
          );
        }
        const filled = sectionFilledCount(section, record);
        const total = section.fields.length;
        return (
          <DenPanel
            key={section.id}
            title={section.title}
            detail={`${filled} of ${total} on file`}
            subtitle={section.blurb}
            {...(stagger !== undefined ? { className: stagger } : {})}
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
                  <div className={factClass(field)} key={field.key}>
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
 * The veterinary section: the household's CANONICAL vet, and the only place it
 * is authored.
 *
 * Operator ruling 2026-08-01, "vet info lives on household data, it can be seen
 * on the kin profile" (page-specs 04-kinfolk-profile.md item 3). What is stored
 * is a `vet_clinics` id, never typed text: the name, phone, address and hours
 * all resolve through the clinic, so correcting a clinic in the vet clinics
 * manager corrects it here and on every other household at once. That is what
 * makes the number this screen exists to be read under pressure a number
 * somebody can actually fix.
 *
 * The vet is chosen by SEARCH, not typed (ruling 2: "Vets are not a open string
 * textbox, it is a dropdown and search feature"), which is why this section has
 * its own editor instead of the generic text dialog every other section uses.
 */
function VeterinarySection({
  section,
  record,
  clinics,
  onEdit,
  onCleared,
  stagger,
}: {
  section: HouseholdSectionSpec;
  record: HouseholdRecord;
  clinics: Async<VetClinic[]>;
  onEdit: () => void;
  onCleared: (next: HouseholdRecord) => void;
  stagger: 'd1' | 'd2' | 'd3' | undefined;
}) {
  const vet = clinics.status === 'ready' ? resolveHouseholdVet(record, clinics.data) : null;
  // Leftovers are only worth flagging when the slot is LINKED. On an unlinked
  // household the legacy text IS the vet being displayed above, so calling it
  // "older notes, not used anywhere" would be both duplicative and false.
  const supersededByLink = vet !== null && (vet.primary.linked || vet.emergency.linked);
  const leftovers = supersededByLink ? legacyVetLeftovers(record) : [];

  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  async function confirmClear() {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      const patch: Partial<HouseholdFields> = {};
      for (const field of leftovers) patch[field.key] = '';
      const next = await saveHouseholdSection(record, patch);
      setClearing(false);
      setConfirming(false);
      onCleared(next);
    } catch (err) {
      setClearing(false);
      setClearError(err instanceof Error ? err.message : 'The clear did not go through.');
    }
  }

  return (
    <DenPanel
      title={section.title}
      subtitle={section.blurb}
      {...(stagger !== undefined ? { className: stagger } : {})}
      trailing={<GhostButton label="Edit veterinary" onClick={onEdit} />}
    >
      {clinics.status === 'loading' && <p className="hdata__notes-lede">Reading the shared clinic catalog…</p>}
      {clinics.status === 'error' && (
        <Banner tone="warning" title="The shared clinic catalog didn't load">
          <p>{clinics.message} The vet on file cannot be shown until it does. It is unchanged.</p>
        </Banner>
      )}
      {vet !== null && <VetFacts vet={vet} />}
      {/* Fail loud, never silent: the record still carries the retired free
          text, so it is shown rather than dropped, and named as superseded
          rather than presented as a second opinion. */}
      {leftovers.length > 0 && (
        <Banner tone="warning" title="Older vet notes are still on this record">
          <p>
            These were typed before the vet was chosen from the shared bank. They are not used
            anywhere and are not kept up to date. The migration moves anything the record is
            missing; whatever is left below can be cleared once you have copied out anything worth
            keeping.
          </p>
          <LeftoverFacts leftovers={leftovers} record={record} />
          <GhostButton label="Clear old vet notes" onClick={() => setConfirming(true)} />
        </Banner>
      )}
      {confirming && (
        <Dialog
          title="Clear the old vet notes?"
          onClose={() => {
            if (!clearing) setConfirming(false);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setConfirming(false)} disabled={clearing} />
              <PrimaryButton
                label={clearing ? 'Clearing…' : 'Clear'}
                onClick={() => void confirmClear()}
                disabled={clearing}
                busy={clearing}
              />
            </>
          }
        >
          <p>
            This removes the {leftovers.length === 1 ? 'field' : `${leftovers.length} fields`} listed
            below from this record. The linked vet shown above is unaffected: it lives on the clinic,
            not here.
          </p>
          <LeftoverFacts leftovers={leftovers} record={record} />
          {clearError !== null && (
            <Banner tone="error" title="That did not clear">
              <p>{clearError}</p>
            </Banner>
          )}
        </Dialog>
      )}
    </DenPanel>
  );
}
/** The leftover legacy vet fields, read-only, shared by the banner and its confirm dialog. */
function LeftoverFacts({
  leftovers,
  record,
}: {
  leftovers: readonly HouseholdFieldSpec[];
  record: HouseholdRecord;
}) {
  // Stacked, not the section grid: this list sits inside a banner and inside
  // the confirm dialog, and two columns in a dialog's width crush the values.
  return (
    <dl className="hdata__facts hdata__facts--stack">
      {leftovers.map((field) => (
        <div className="hdata__fact" key={field.key}>
          <dt className="hdata__fact-label">{field.label}</dt>
          <dd className="hdata__fact-value">{record[field.key]}</dd>
        </div>
      ))}
    </dl>
  );
}
function VetFacts({ vet }: { vet: HouseholdVet }) {
  return (
    <>
      {/* The mock's rows: the name on a row of its own, phone beside hours,
          the address on its own row, for each of the two clinics. */}
      <dl className="hdata__facts">
        <VetRow label="Primary vet" value={vet.primary.name} wide />
        <VetRow label="Primary vet phone" value={vet.primary.phone} />
        <VetRow label="Primary vet hours" value={vet.primary.hours} />
        <VetRow label="Primary vet address" value={vet.primary.address} wide />
        <VetRow label="Emergency vet" value={vet.emergency.name} wide />
        <VetRow label="Emergency vet phone" value={vet.emergency.phone} />
        <VetRow label="Emergency vet hours" value={vet.emergency.hours} />
        <VetRow label="Emergency vet address" value={vet.emergency.address} wide />
      </dl>
      {vet.primary.dangling && (
        <Banner tone="warning" title="This household's vet no longer exists">
          <p>The record points at a clinic removed from the catalog. Pick the vet again.</p>
        </Banner>
      )}
      {hasVet(vet.primary) && !vet.primary.linked && (
        <Banner tone="warning" title="This vet is not linked to the catalog">
          <p>
            The name and number above are on file, but no clinic is selected, so correcting this
            clinic in the vet clinics manager will not update this household. Pick it from the
            bank to link them.
          </p>
        </Banner>
      )}
    </>
  );
}
function VetRow({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'hdata__fact hdata__fact--wide' : 'hdata__fact'}>
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
