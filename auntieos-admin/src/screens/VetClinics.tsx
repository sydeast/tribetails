import { useId, useMemo, useState } from 'react';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { DenPanel, DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { useToast } from '../components/Toast';
import { useCollection } from '../lib/firestore';
import { VET_CLINICS_QUERY, type VetClinic } from '../api/vetClinics';
import { KINFOLK_QUERY } from '../api/directory';
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
  clinicMonogram,
  type ClinicDraft,
  type ClinicUsage,
  type VetLinkedKinfolk,
} from '../lib/vetClinicManager';
import './VetClinics.css';

/**
 * Vet clinics: the manager for the shared `vet_clinics` bank (punchlist B4).
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
 * RETIRE, NOT DELETE. The mock's row action is a red "Remove" trash icon. It is
 * wired to `archiveVetClinic`, because a hard delete strands every linked
 * household's id and drops them out of the fan-out permanently. The label says
 * "Retire" rather than "Remove" so the control describes what it does.
 */
export function VetClinics() {
  const clinics = useCollection<VetClinic>(VET_CLINICS_QUERY);
  const households = useCollection<VetLinkedKinfolk>(KINFOLK_QUERY);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title="Vet"
        accentTail="clinics"
        subtitle="The shared bank every household picks from. Correcting a clinic here corrects it on every household linked to it."
        trailing={
          <PrimaryButton
            label="Add clinic"
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

interface BankProps {
  rows: readonly VetClinic[];
  households: readonly VetLinkedKinfolk[];
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
  const active = useMemo(() => filterClinics(activeClinics(rows), query), [rows, query]);
  const retired = useMemo(() => filterClinics(archivedClinics(rows), query), [rows, query]);

  return (
    <div className="vetbank">
      <Banner tone="info" title="One bank, shared with every household">
        <p>
          Households and the kinfolk portal both read these clinics. A correction here rewrites
          the copy stored on every household linked to the clinic, so the number on file at a
          doorstep changes with it.
        </p>
      </Banner>

      {pending.length > 0 && (
        <DenPanel
          title="Pending approval"
          subtitle={`${pending.length} submitted by a household`}
        >
          <p className="vetbank-blurb">
            A household added these from its own record. Approving publishes a clinic to the
            shared bank. Rejecting retires it, which keeps who submitted it on file rather than
            discarding the evidence.
          </p>
          <div className="vetbank-grid">
            {pending.map((c) => (
              <ClinicCard
                key={c._id}
                clinic={c}
                all={rows}
                usage={clinicUsage(c, households)}
                usageKnown={householdsKnown}
                pending
              />
            ))}
          </div>
        </DenPanel>
      )}

      <DenPanel
        title="Catalog"
        subtitle={`${active.length} of ${activeClinics(rows).length} clinics`}
        trailing={
          <input
            className="vetbank-search"
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search clinics by name, phone, or address"
            placeholder="Search clinics by name, phone, or address"
          />
        }
      >
        {adding && <AddClinicCard onDone={onAddDone} all={rows} />}
        {active.length === 0 && !adding ? (
          <EmptyHint>No clinic matches that search.</EmptyHint>
        ) : (
          <div className="vetbank-grid">
            {active.map((c) => (
              <ClinicCard
                key={c._id}
                clinic={c}
                all={rows}
                usage={clinicUsage(c, households)}
                usageKnown={householdsKnown}
              />
            ))}
          </div>
        )}
      </DenPanel>

      {retired.length > 0 && (
        <DenPanel title="Retired" subtitle={`${retired.length} out of the bank`}>
          <p className="vetbank-blurb">
            Retired clinics are hidden from every picker and from the kinfolk portal. They are
            kept, not deleted: a household already on one still reads the name, phone and
            address it always did, and restoring one puts it back in the bank.
          </p>
          <div className="vetbank-grid">
            {retired.map((c) => (
              <ClinicCard
                key={c._id}
                clinic={c}
                all={rows}
                usage={clinicUsage(c, households)}
                usageKnown={householdsKnown}
                retired
              />
            ))}
          </div>
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

  return (
    <article className={`vetcard${retired ? ' vetcard--retired' : ''}`}>
      <header className="vetcard-top">
        <span className="vetcard-logo" aria-hidden="true">
          {clinicMonogram(clinic.name ?? '')}
        </span>
        <span className="vetcard-name">
          <b>{clinic.name ?? 'Unnamed clinic'}</b>
          <span className="vetcard-id">vet_clinics/{clinic._id}</span>
        </span>
        {clinic.isEmergency === true && <span className="vetcard-tag">24 hour</span>}
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
          <dl className="vetcard-meta">
            <Row label="Phone" value={clinic.phone} />
            <Row label="Address" value={clinic.address} />
            <Row label="Hours" value={clinic.hours} />
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
              <GhostButton label="Edit" onClick={open} disabled={busy} />
              {retired === true ? (
                <GhostButton
                  label="Restore"
                  onClick={() => void setArchived(false)}
                  disabled={busy}
                />
              ) : (
                <GhostButton
                  // "Retire", not the mock's "Remove": the control archives, and
                  // a label promising removal would misdescribe what happens to
                  // the households still pointing at the clinic.
                  label={pending === true ? 'Reject' : 'Retire'}
                  className="vetcard-danger"
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
    </article>
  );
}

/**
 * The reference count.
 *
 * Suppressed entirely when the household listener has not landed, rather than
 * rendered as zero. The next control on this card retires the clinic, and "no
 * household uses this" is a very different thing to tell an operator than "we
 * have not been able to check".
 */
function UsageBadge({ usage, known }: { usage: ClinicUsage; known: boolean }) {
  if (!known) return <span className="vetcard-usage vetcard-usage--unknown">Households: checking…</span>;

  const parts: string[] = [];
  if (usage.linked > 0) parts.push(`${usage.linked} linked`);
  // Named rather than summed: a correction here cannot reach these, because
  // they carry the clinic's name with no id to match on.
  if (usage.unlinked > 0) parts.push(`${usage.unlinked} by name only`);
  if (parts.length === 0) return <span className="vetcard-usage">No households</span>;

  return (
    <span className="vetcard-usage">
      {parts.join(' · ')}
      {usage.unlinked > 0 && (
        <span className="vetcard-usage-note">
          {' '}
          (name-only households are not updated by a save)
        </span>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value?: string | undefined }) {
  const shown = (value ?? '').trim();
  return (
    <div className="vetcard-row">
      <dt>{label}</dt>
      {/* Blank is shown, not hidden: this is a record whose gaps are content. */}
      <dd className={shown === '' ? 'vetcard-blank' : undefined}>
        {shown === '' ? 'Not set' : shown}
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
