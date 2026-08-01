import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { addKin } from '../api/portal';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { buildNewKinPayload, emptyKinForm, hasErrors, validateKinForm, type KinEditForm } from '../lib/kinEditForm';

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

  const save = useMutation({
    mutationFn: () => addKin(buildNewKinPayload(form), kinfolkId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['myKin', kinfolkId] });
      void navigate({ to: '/kin/$kinId', params: { kinId: res.kinId } });
    },
  });

  const errors = validateKinForm(form);
  const canSave = !hasErrors(errors) && !save.isPending;

  const set = (key: keyof KinEditForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    if (!canSave) return;
    save.mutate();
  };

  const textField = (key: keyof KinEditForm, label: string, opts?: { full?: boolean; area?: boolean; required?: boolean; type?: string }) => (
    <div className={opts?.full ? 'field full' : 'field'}>
      <label htmlFor={`kin-new-${key}`}>
        {label}
        {opts?.required ? ' *' : ''}
      </label>
      {opts?.area ? (
        <textarea id={`kin-new-${key}`} className="inp" value={form[key]} onChange={(e) => set(key, e.target.value)} />
      ) : (
        <input id={`kin-new-${key}`} className="inp" type={opts?.type ?? 'text'} value={form[key]} onChange={(e) => set(key, e.target.value)} />
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
                <p className="sub">The basics your Aunties see first.</p>
              </div>
            </div>
            <div className="grid2">
              {textField('name', 'Name', { full: true, required: true })}
              {textField('species', 'Species')}
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
                <p className="sub">Daily routine and needs.</p>
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
                <p className="sub">Good-to-know details and emergencies.</p>
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
              <button className="btn grad" type="button" onClick={submit} disabled={!canSave}>
                {'\u{1F43E}'} {save.isPending ? 'Adding…' : 'Add Kin'}
              </button>
              <Link className="btn ghost" to="/kin">
                Cancel
              </Link>
              {save.isError && (
                <span className="status err">
                  <span className="dot" />
                  {save.error instanceof Error ? save.error.message : 'Could not add this kin. Try again.'}
                </span>
              )}
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
