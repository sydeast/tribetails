import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { addKin } from '../api/portal';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { SpeciesField } from '../components/SpeciesField';
import { buildNewKinPayload, emptyKinForm, hasErrors, validateKinForm, type KinEditForm, type KinFormErrors } from '../lib/kinEditForm';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { usePortalMutation } from '../lib/mutationState';

/**
 * Add New Kin (B3, punchlist item): the create counterpart to KinEdit.tsx.
 * Same field set, same validation (mirrors the server's KinPayload zod
 * schema — see kinEditForm.ts), same section layout as
 * ui-ideas/mytribe-kin-detail-2026-05-31.html's edit chrome, just seeded
 * blank instead of from an existing kin. On success, navigates straight to
 * the new profile (addKin returns the new kinId) rather than back to the
 * roster, so the kinfolk sees what they just created.
 */
export function KinAdd() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const [form, setForm] = useState<KinEditForm>(emptyKinForm());

  // ABANDON. `addKin` is a bare `.add()` on families/{id}/kin with no
  // idempotency key and no name dedupe (functions/src/portal/kinWrites.ts), so
  // a replay is a second Kin on the household's list.
  const save = usePortalMutation({
    mutationFn: () => addKin(buildNewKinPayload(form), kinfolkId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['myKin', kinfolkId] });
      void navigate({ to: '/kin/$kinId', params: { kinId: res.kinId } });
    },
  }, { policy: 'abandon', what: 'this Kin' });

  const allErrors = validateKinForm(form);

  // An error shows once its field has been touched (changed or left) or a save
  // has been attempted, never on first paint: a blank form is not wrong yet.
  // The Add button stays live so a tap on an incomplete form explains itself
  // instead of doing nothing.
  const [touched, setTouched] = useState<Partial<Record<keyof KinEditForm, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const errors: KinFormErrors = attempted
    ? allErrors
    : Object.fromEntries(Object.entries(allErrors).filter(([k]) => touched[k as keyof KinEditForm]));
  const touch = (key: keyof KinEditForm) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));

  const set = (key: keyof KinEditForm, value: string) => {
    touch(key);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = () => {
    if (save.isPending) return;
    if (hasErrors(allErrors)) {
      setAttempted(true);
      return;
    }
    save.mutate();
  };

  const textField = (key: keyof KinEditForm, label: string, opts?: { full?: boolean; area?: boolean; required?: boolean; type?: string }) => (
    <div className={opts?.full ? 'field full' : 'field'}>
      <label htmlFor={`kin-new-${key}`}>
        {label}
        {opts?.required ? ' *' : ''}
      </label>
      {opts?.area ? (
        <textarea id={`kin-new-${key}`} className="inp" value={form[key]} onChange={(e) => set(key, e.target.value)} onBlur={() => touch(key)} />
      ) : (
        <input id={`kin-new-${key}`} className="inp" type={opts?.type ?? 'text'} value={form[key]} onChange={(e) => set(key, e.target.value)} onBlur={() => touch(key)} />
      )}
      {errors[key] && (
        <span className="hint" style={{ color: 'var(--coral)' }}>
          {errors[key]}
        </span>
      )}
    </div>
  );

  return (
    <>
      <PortalNav active="tribe" />

      <div className="wrap">
        <div className="crumbrow">
          <Link className="backlink" to="/kin">
            {'←'} Back to Kin
          </Link>
          <div className="seg">
            <span className="page">Add New Kin</span>
          </div>
        </div>

        <div className="stack">
          {/* ABOUT */}
          <section className="glass card d1">
            <div className="cardhead">
              <div className="ic orange">{'\u{1F43E}'}</div>
              <div className="htxt">
                <h3 className="title">About</h3>
              </div>
            </div>
            <div className="grid2">
              {textField('name', 'Name', { full: true, required: true })}
              <SpeciesField id="kin-new-species" value={form.species} onChange={(v) => set('species', v)} error={errors.species} />
              {textField('breed', 'Breed')}
              {textField('ageYears', 'Age (years)', { type: 'text' })}
              {textField('photoUrl', 'Photo URL', { full: true, type: 'url' })}
            </div>
          </section>

          {/* CARE */}
          <section className="glass card d2">
            <div className="cardhead">
              <div className="ic teal">{'\u{1F37D}'}</div>
              <div className="htxt">
                <h3 className="title">Care</h3>
              </div>
            </div>
            <div className="grid2">
              {textField('feedingInstructions', 'Feeding Instructions', { full: true, area: true })}
              {textField('walkingInstructions', 'Walking Instructions', { full: true, area: true })}
              {textField('medications', 'Medications', { full: true, area: true })}
              {textField('allergies', 'Allergies', { full: true, area: true })}
            </div>
          </section>

          {/* NOTES */}
          <section className="glass card d3">
            <div className="cardhead">
              <div className="ic purple">{'\u{1F4DD}'}</div>
              <div className="htxt">
                <h3 className="title">Notes</h3>
              </div>
            </div>
            <div className="grid2">
              {textField('sitterNotes', 'Sitter Notes', { full: true, area: true })}
              {textField('emergencyNotes', 'Emergency Notes', { full: true, area: true })}
            </div>
          </section>

          {/* SAVE BAR */}
          <section style={{ marginTop: 6 }}>
            <div className="savebar">
              <button className="btn grad" type="button" onClick={submit} disabled={save.isPending}>
                {'\u{1F43E}'}{' '}
                <MutationLabel mutation={save} busy="Adding…">
                  Add Kin
                </MutationLabel>
              </button>
              <Link className="btn ghost" to="/kin">
                Cancel
              </Link>
              {save.phase === 'failed' && (
                <span className="status err">
                  <span className="dot" />
                  {save.error instanceof Error ? save.error.message : 'Could not add this kin. Try again.'}
                </span>
              )}
              <OfflineMutationNotice phase={save.phase} what="this Kin" check="your Kin list" />
              {hasErrors(errors) && <span className="sub">Fix the highlighted fields to save.</span>}
            </div>
          </section>
        </div>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
