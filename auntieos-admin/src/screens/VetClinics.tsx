import { useId, useMemo, useState, type ReactNode } from 'react';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { DenPanel, DenScreenHeading, EmptyHint, StatusPill } from '../components/DenScreenKit';
import { EntityCardGrid } from '../components/EntityCardGrid';
import { GhostButton, IconButton, PrimaryButton } from '../components/Buttons';
import { useToast } from '../components/Toast';
import { useCollection } from '../lib/firestore';
import { VET_CLINICS_QUERY, type VetClinic } from '../api/vetClinics';
import { HOUSEHOLD_DATA_QUERY } from '../api/householdData';
import {
  updateVetClinic,
  archiveVetClinic,
  submitVetClinic,
  type VetClinicEdit,
} from '../api/vetClinicsWrite';
import {
  activeClinics,
  archivedClinics,
  pendingClinics,
  filterClinics,
  clinicUsage,
  draftFromClinic,
  canSaveDraft,
  draftNameCollides,
  type ClinicDraft,
  type ClinicUsage,
  type VetLinkedHousehold,
} from '../lib/vetClinicManager';
import './VetClinics.css';

/**
 * Vet clinics: the manager for the shared `vet_clinics` bank (punchlist B4).
 *
 * THE SHAPE IS THE MOCK'S (`ui-ideas/auntieos-vet-clinics-2026-05-27.html`,
 * issue #755): the kit hero, a controls row of search box and count pill, then
 * the catalog as cards straight on the ground. The mock draws one section; this
 * screen has two more that are not in it, the approval queue and the retired
 * rows, and those sit in kit panels above and below the bank so the queue reads
 * as work and the archive reads as an archive, while the bank itself stays the
 * mock's bare grid.
 *
 * WHAT WAS MISSING. The catalog had a picker inside a household's edit screen
 * and nothing else. A clinic could be created from there and never corrected:
 * the React admin had no update path at all, and the server had no update
 * callable to offer one. A clinic entered with a wrong phone number stayed
 * wrong, and that number is what somebody reads in an emergency.
 *
 * WHY THE HOUSEHOLD COUNT IS ON EVERY CARD. Households store the clinic's
 * name, phone and address denormalized beside its id, so a save here fans the
 * correction out to every linked household. The count says how far a save will
 * travel BEFORE it is pressed, and the toast says how far it actually went.
 * `linked` and `unlinked` are shown separately and deliberately: a legacy
 * household with the clinic's name typed in and no id cannot be reached by the
 * fan-out, so folding it into one number would overstate the repair.
 *
 * RETIRE, NOT DELETE. The concept mock drew a red "Remove" trash icon. There is
 * no delete callable (`api/vetClinicsWrite.ts`, "There is no delete") and the
 * ruling on this screen is to use the callables that exist, so the control
 * archives through `archiveVetClinic`: a hard delete would strand every linked
 * household's id and drop them out of the fan-out permanently. The control is
 * named "Retire" and wears an archive glyph, and the mock is amended to match.
 */
export function VetClinics() {
  const clinics = useCollection<VetClinic>(VET_CLINICS_QUERY);
  const households = useCollection<VetLinkedHousehold>(HOUSEHOLD_DATA_QUERY);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title="Vet"
        accentTail="clinics"
        subtitle="The shared bank every household and the kinfolk portal pick from. Correcting a clinic here rewrites the copy stored on every household linked to it, so the number on file at a doorstep changes with it."
        trailing={
          <PrimaryButton
            label="Add clinic"
            leading={<PlusGlyph />}
            onClick={() => setAdding(true)}
            disabled={adding}
          />
        }
      />

      <AsyncRegion
        state={clinics}
        what="vet clinics"
        isEmpty={(rows) => rows.length === 0 && !adding}
        empty={
          <EmptyHint>
            The bank is empty. Add the first clinic, or one will be created the next time a
            household types a vet into its record.
          </EmptyHint>
        }
      >
        {(rows) => (
          <ClinicBank
            rows={rows}
            households={households.status === 'ready' ? households.data : []}
            householdsKnown={households.status === 'ready'}
            query={query}
            onQuery={setQuery}
            adding={adding}
            onAddDone={() => setAdding(false)}
          />
        )}
      </AsyncRegion>
    </div>
  );
}

/** The mock's card width (`.grid`, minmax(300px, 1fr)). */
const CARD_MIN_WIDTH = '300px';

interface BankProps {
  rows: readonly VetClinic[];
  households: readonly VetLinkedHousehold[];
  /**
   * False while the kinfolk listener is still loading or has failed. The count
   * is suppressed rather than shown as zero: "0 households" and "we could not
   * check" are different claims, and only one of them is safe to act on when
   * the next click retires the clinic.
   */
  householdsKnown: boolean;
  query: string;
  onQuery: (q: string) => void;
  adding: boolean;
  onAddDone: () => void;
}

function ClinicBank({
  rows,
  households,
  householdsKnown,
  query,
  onQuery,
  adding,
  onAddDone,
}: BankProps) {
  const pending = useMemo(() => pendingClinics(rows), [rows]);
  const bank = useMemo(() => activeClinics(rows), [rows]);
  const active = useMemo(() => filterClinics(bank, query), [bank, query]);
  const retired = useMemo(() => filterClinics(archivedClinics(rows), query), [rows, query]);

  const card = (c: VetClinic, flags: { pending?: boolean; retired?: boolean } = {}) => (
    <ClinicCard
      key={c._id}
      clinic={c}
      all={rows}
      usage={clinicUsage(c, households)}
      usageKnown={householdsKnown}
      {...flags}
    />
  );

  return (
    <div className="vetbank">
      {/* The queue sits above the bank: it is work, and the mock's banner slot
          is where anything that wants attention before the controls row goes. */}
      {pending.length > 0 && (
        <DenPanel
          title="Pending approval"
          subtitle="A household added these from its own record. Approving publishes a clinic to the shared bank. Rejecting retires it, which keeps who submitted it on file rather than discarding the evidence."
          meta={`${pending.length} submitted`}
        >
          <EntityCardGrid label="Clinics pending approval" minCardWidth={CARD_MIN_WIDTH}>
            {pending.map((c) => card(c, { pending: true }))}
          </EntityCardGrid>
        </DenPanel>
      )}

      {/* The mock's `.controls`: the search box and the count pill in one row. */}
      <div className="vetbank-controls">
        <label className="vetbank-search">
          <span className="vetbank-search-glyph">
            <SearchGlyph />
          </span>
          <input
            className="vetbank-search-input"
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search clinics by name, phone, or address"
            placeholder="Search clinics by name, phone, or address"
          />
        </label>
        <span className="vetbank-count">
          <span className="vetbank-count-kicker">Catalog</span>
          {query.trim() === ''
            ? `${bank.length} ${bank.length === 1 ? 'clinic' : 'clinics'}`
            : `${active.length} of ${bank.length} ${bank.length === 1 ? 'clinic' : 'clinics'}`}
        </span>
      </div>

      {adding && <AddClinicCard onDone={onAddDone} all={rows} />}
      {active.length === 0 && !adding ? (
        <EmptyHint>No clinic matches that search.</EmptyHint>
      ) : (
        <EntityCardGrid label="Clinic catalog" minCardWidth={CARD_MIN_WIDTH}>
          {active.map((c) => card(c))}
        </EntityCardGrid>
      )}

      {retired.length > 0 && (
        <DenPanel
          title="Retired"
          subtitle="Retired clinics are hidden from every picker and from the kinfolk portal. They are kept, not deleted: a household already on one still reads the name, phone and address it always did, and restoring one puts it back in the bank."
          meta={`${retired.length} out of the bank`}
        >
          <EntityCardGrid label="Retired clinics" minCardWidth={CARD_MIN_WIDTH}>
            {retired.map((c) => card(c, { retired: true }))}
          </EntityCardGrid>
        </DenPanel>
      )}
    </div>
  );
}

interface CardProps {
  clinic: VetClinic;
  all: readonly VetClinic[];
  usage: ClinicUsage;
  usageKnown: boolean;
  pending?: boolean;
  retired?: boolean;
}

function ClinicCard({ clinic, all, usage, usageKnown, pending, retired }: CardProps) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ClinicDraft>(() => draftFromClinic(clinic));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collides = draftNameCollides(clinic._id, draft, all);
  const canSave = canSaveDraft(clinic, draft) && !collides && !busy;
  const name = clinic.name ?? 'Unnamed clinic';

  function open() {
    setDraft(draftFromClinic(clinic));
    setError(null);
    setEditing(true);
  }

  async function run(what: string, fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      showToast(await fn());
      setEditing(false);
    } catch (err) {
      // Fail loud: the message reaches the card, never a swallowed console line.
      setError(`${what} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  const save = (extra?: Partial<VetClinicEdit>) =>
    run('Save', async () => {
      const res = await updateVetClinic({ clinicId: clinic._id, ...draft, ...extra });
      // The fan-out count is reported, not hidden. On the screen whose whole
      // purpose is correcting a number people dial, "saved" is a weaker claim
      // than "saved, and 3 households now read the new number".
      return res.householdsUpdated > 0
        ? `Saved ${draft.name.trim()}. ${res.householdsUpdated} household${
            res.householdsUpdated === 1 ? '' : 's'
          } now read the corrected details.`
        : `Saved ${draft.name.trim()}.`;
    });

  const setArchived = (archived: boolean) =>
    run(archived ? 'Retire' : 'Restore', async () => {
      const res = await archiveVetClinic(clinic._id, archived);
      if (!archived) return `${clinic.name ?? 'Clinic'} is back in the bank.`;
      return res.householdCount > 0
        ? `${clinic.name ?? 'Clinic'} retired. ${res.householdCount} household${
            res.householdCount === 1 ? '' : 's'
          } keep the details already on file.`
        : `${clinic.name ?? 'Clinic'} retired.`;
    });

  const website = (clinic.website ?? '').trim();
  const notes = (clinic.notes ?? '').trim();

  // An `<li>`, not an `<article>`: this card is an item of an `EntityCardGrid`,
  // and the grid's list semantics are only true if its children are list items.
  // AddClinicCard below stays an `<article>` because it is rendered ABOVE the
  // grid, not inside it.
  return (
    <li className={`vetcard${retired ? ' vetcard--retired' : ''}`}>
      <header className="vetcard-top">
        {/* The mock's `.logo`: a 50px tile on a gradient that differs card to
            card, with the same glyph on each. The kit avatar's seeded gradient
            is that variation; the seed is the id so a rename keeps its colour. */}
        <Avatar
          label={name}
          glyph={<ClinicGlyph />}
          size={50}
          shape="rounded"
          ring={false}
          gradientSeed={clinic._id}
          className="vetcard-logo"
        />
        <span className="vetcard-name">
          <b>{name}</b>
          <span className="vetcard-id">vet_clinics/{clinic._id}</span>
        </span>
        {clinic.isEmergency === true && (
          <span className="vetcard-tag">
            <StatusPill label="24 hour" tone="orange" size="compact" />
          </span>
        )}
      </header>

      {editing ? (
        <div className="vetcard-form">
          <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
          <Field
            label="Phone"
            value={draft.phone}
            onChange={(v) => setDraft({ ...draft, phone: v })}
          />
          <Field
            label="Address"
            value={draft.address}
            onChange={(v) => setDraft({ ...draft, address: v })}
          />
          {/* Hours live on the clinic, not on the household that picked it:
              every household using this practice shares its opening hours. */}
          <Field
            label="Hours"
            value={draft.hours}
            onChange={(v) => setDraft({ ...draft, hours: v })}
            hint="Shown on every household using this clinic."
          />
          <Field
            label="Website"
            value={draft.website}
            onChange={(v) => setDraft({ ...draft, website: v })}
          />
          <Field
            label="Notes"
            value={draft.notes}
            onChange={(v) => setDraft({ ...draft, notes: v })}
          />
          <label className="vetcard-check">
            <input
              type="checkbox"
              checked={draft.isEmergency}
              onChange={(e) => setDraft({ ...draft, isEmergency: e.target.checked })}
            />
            <span>Open 24 hours / emergency clinic</span>
          </label>

          {collides && (
            <p className="vetcard-error" role="alert">
              Another clinic is already called that. Edit that one instead of creating a second
              copy of it.
            </p>
          )}
          {usage.linked > 0 && (
            <p className="vetcard-warn">
              Saving rewrites the vet on {usage.linked} household
              {usage.linked === 1 ? '' : 's'}.
            </p>
          )}

          <div className="vetcard-actions">
            <PrimaryButton
              label={busy ? 'Saving…' : 'Save'}
              onClick={() => void save()}
              disabled={!canSave}
            />
            <GhostButton label="Cancel" onClick={() => setEditing(false)} disabled={busy} />
          </div>
        </div>
      ) : (
        <>
          {/* The mock's `.vmeta`: a teal glyph then the value. The label is
              kept for assistive tech, since a phone glyph is not a word. */}
          <dl className="vetcard-meta">
            <Row label="Phone" glyph={<PhoneGlyph />} value={clinic.phone} />
            <Row label="Address" glyph={<PinGlyph />} value={clinic.address} />
            <Row label="Hours" glyph={<ClockGlyph />} value={clinic.hours} />
            {website !== '' && <Row label="Website" glyph={<GlobeGlyph />} value={website} />}
            {notes !== '' && <Row label="Notes" glyph={<NoteGlyph />} value={notes} />}
          </dl>

          <footer className="vetcard-base">
            <UsageBadge usage={usage} known={usageKnown} />
            <div className="vetcard-actions">
              {pending === true && (
                <PrimaryButton
                  label="Approve"
                  onClick={() => void save({ verified: true })}
                  disabled={busy}
                />
              )}
              <IconButton
                icon={<PencilGlyph />}
                label="Edit"
                size={32}
                onClick={open}
                disabled={busy}
              />
              {retired === true ? (
                <GhostButton
                  label="Restore"
                  onClick={() => void setArchived(false)}
                  disabled={busy}
                />
              ) : pending === true ? (
                <GhostButton
                  label="Reject"
                  className="vetcard-danger"
                  onClick={() => void setArchived(true)}
                  disabled={busy}
                />
              ) : (
                // "Retire" on an archive glyph, not the concept's "Remove" on a
                // trash can: the control archives, and a label or a glyph
                // promising removal would misdescribe what happens to the
                // households still pointing at the clinic.
                <IconButton
                  icon={<ArchiveGlyph />}
                  label="Retire"
                  size={32}
                  destructive
                  onClick={() => void setArchived(true)}
                  disabled={busy}
                />
              )}
            </div>
          </footer>
        </>
      )}

      {error !== null && (
        <p className="vetcard-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The reference count, the mock's `.linked`: a lock glyph, the number in teal,
 * the noun in mono.
 *
 * Suppressed entirely when the household listener has not landed, rather than
 * rendered as zero. The next control on this card retires the clinic, and "no
 * household uses this" is a very different thing to tell an operator than "we
 * have not been able to check".
 */
function UsageBadge({ usage, known }: { usage: ClinicUsage; known: boolean }) {
  if (!known) {
    return (
      <span className="vetcard-usage vetcard-usage--unknown">
        <LockGlyph /> Households: checking…
      </span>
    );
  }

  if (usage.linked === 0 && usage.unlinked === 0) {
    return (
      <span className="vetcard-usage">
        <LockGlyph /> No households
      </span>
    );
  }

  return (
    <span className="vetcard-usage">
      <LockGlyph />
      {usage.linked > 0 && (
        <span className="vetcard-usage-part">
          <b>{usage.linked}</b> linked
        </span>
      )}
      {/* Named rather than summed: a correction here cannot reach these,
          because they carry the clinic's name with no id to match on. */}
      {usage.unlinked > 0 && (
        <span className="vetcard-usage-part">
          <b>{usage.unlinked}</b> by name only
        </span>
      )}
      {usage.unlinked > 0 && (
        <span className="vetcard-usage-note">(name-only households are not updated by a save)</span>
      )}
    </span>
  );
}

function Row({
  label,
  glyph,
  value,
}: {
  label: string;
  glyph: ReactNode;
  value?: string | undefined;
}) {
  const shown = (value ?? '').trim();
  return (
    <div className="vetcard-row">
      <dt className="vetcard-row-label">{label}</dt>
      {/* Blank is shown, not hidden: this is a record whose gaps are content. */}
      <dd className={shown === '' ? 'vetcard-blank' : undefined}>
        <span className="vetcard-row-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span>{shown === '' ? 'Not set' : shown}</span>
      </dd>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}

function Field({ label, value, onChange, hint }: FieldProps) {
  // Explicit htmlFor/id, with the hint on `aria-describedby` rather than nested
  // inside the label. A wrapping label folds the hint into the ACCESSIBLE NAME,
  // so the Hours field would announce as "Hours Shown on every household using
  // this clinic". A name and a description are different jobs.
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="vetcard-field">
      <label className="vetcard-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
      />
      {hint !== undefined && (
        <span className="vetcard-field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * Add a clinic straight into the bank.
 *
 * Routes through `submitVetClinic`, the same callable the household picker's
 * inline create uses, so the normalized-name dedupe is one rule for the whole
 * product. A staff caller lands `verified: true`, so an operator's clinic is
 * live immediately rather than queued for the operator's own approval.
 *
 * Hours are deliberately absent here: a brand new row is added from a phone
 * call or a card, and the hours get curated on the clinic afterwards through
 * Edit. `submitVetClinic` has no `hours` field for the same reason.
 */
function AddClinicCard({ onDone, all }: { onDone: () => void; all: readonly VetClinic[] }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState({ name: '', phone: '', address: '', website: '' });
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collides = draftNameCollides(
    '',
    { ...draft, hours: '', notes: '', isEmergency: emergency },
    all,
  );

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await submitVetClinic({ ...draft, isEmergency: emergency });
      showToast(
        res.created
          ? `Added ${draft.name.trim()}.`
          : `${draft.name.trim()} was already in the bank, so nothing was duplicated.`,
      );
      onDone();
    } catch (err) {
      setError(`Add failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="vetcard vetcard--new">
      <header className="vetcard-top">
        <span className="vetcard-name">
          <b>New clinic</b>
        </span>
      </header>
      <div className="vetcard-form">
        <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
        <Field
          label="Phone"
          value={draft.phone}
          onChange={(v) => setDraft({ ...draft, phone: v })}
        />
        <Field
          label="Address"
          value={draft.address}
          onChange={(v) => setDraft({ ...draft, address: v })}
        />
        <Field
          label="Website"
          value={draft.website}
          onChange={(v) => setDraft({ ...draft, website: v })}
        />
        <label className="vetcard-check">
          <input
            type="checkbox"
            checked={emergency}
            onChange={(e) => setEmergency(e.target.checked)}
          />
          <span>Open 24 hours / emergency clinic</span>
        </label>

        {collides && (
          <p className="vetcard-warn">
            A clinic with this name is already in the bank. Adding it again will link to the
            existing record rather than create a second copy.
          </p>
        )}

        <div className="vetcard-actions">
          <PrimaryButton
            label={busy ? 'Adding…' : 'Add to bank'}
            onClick={() => void add()}
            disabled={draft.name.trim() === '' || busy}
          />
          <GhostButton label="Cancel" onClick={onDone} disabled={busy} />
        </div>

        {error !== null && (
          <p className="vetcard-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}

// ── glyphs ──────────────────────────────────────────────────────────────────
// The mock's inline SVGs, kept inline for the same reason as Directory's: no
// icon package is installed here and eight strokes are not worth a dependency.

function glyph(paths: ReactNode, strokeWidth = 1.8) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

/** The mock's `.add` plus. */
function PlusGlyph() {
  return glyph(<path d="M12 5v14M5 12h14" />, 2);
}

/** The mock's `.search svg`. */
function SearchGlyph() {
  return glyph(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </>,
    2,
  );
}

/** The mock's `.logo svg`: a plus in a circle, the same mark on every tile. */
function ClinicGlyph() {
  return glyph(
    <>
      <path d="M12 5v14M5 12h14" />
      <circle cx="12" cy="12" r="9" />
    </>,
  );
}

function PhoneGlyph() {
  return glyph(<path d="M4 5c0 9 6 15 15 15l2-3-4-2-2 2c-3-1-6-4-7-7l2-2-2-4z" />);
}

function PinGlyph() {
  return glyph(
    <>
      <path d="M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>,
  );
}

function ClockGlyph() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  );
}

function GlobeGlyph() {
  return glyph(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>,
  );
}

function NoteGlyph() {
  return glyph(
    <>
      <path d="M5 4h14v11l-5 5H5z" />
      <path d="M14 20v-5h5" />
    </>,
  );
}

/** The mock's `.linked svg`, a padlock. */
function LockGlyph() {
  return glyph(
    <>
      <path d="M9 11V7a3 3 0 0 1 6 0v4" />
      <rect x="5" y="11" width="14" height="9" rx="2" />
    </>,
  );
}

/** The mock's Edit pencil. */
function PencilGlyph() {
  return glyph(
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M14 5l4 4" />
    </>,
  );
}

/** An archive box, in place of the concept's trash can. See the file header. */
function ArchiveGlyph() {
  return glyph(
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>,
  );
}
