import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { addKin } from '../api/portal';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { SpeciesField } from '../components/SpeciesField';
import { FixedField, SexField } from '../components/KinFactsFields';
import { buildNewKinPayload, emptyKinForm, hasErrors, validateKinForm, type KinEditForm, type KinFormErrors, type KinTextKey } from '../lib/kinEditForm';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { usePortalMutation } from '../lib/mutationState';
import { SignedImageUpload } from '../components/SignedImageUpload';
import { uploadKinPhotoSigned, validateKinPhotoFile } from '../api/kinPhotoApi';
import { refreshAfterSave } from '../lib/refreshAfterSave';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

/**
 * Add New Kin (B3, punchlist item): the create counterpart to KinEdit.tsx.
 * Same field set, same validation (mirrors the server's KinPayload zod
 * schema — see kinEditForm.ts), same section layout as
 * ui-ideas/mytribe-kin-detail-2026-05-31.html's edit chrome, just seeded
 * blank instead of from an existing kin. On success, navigates straight to
 * the new profile (addKin returns the new kinId) rather than back to the
 * roster, so the kinfolk sees what they just created.
 *
 * #1291: the photo is picked here and previewed locally, but it can only be
 * uploaded once addKin has returned a kinId (signKinPhotoUpload signs a
 * folder for one existing kin). So Add runs addKin, then the signed upload.
 * A failed upload never fails the add, since the Kin already exists and a
 * retry would create a second one: the household goes to the new Kin's edit
 * screen with `?photo=failed`, which says so and offers the picker again.
 */
export function KinAdd() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const [form, setForm] = useState<KinEditForm>(emptyKinForm());
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  useEffect(() => {
    if (!photoFile) {
      setPhotoPreview('');
      return;
    }
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  // ABANDON. `addKin` is a bare `.add()` on families/{id}/kin with no
  // idempotency key and no name dedupe (functions/src/portal/kinWrites.ts), so
  // a replay is a second Kin on the household's list.
  const save = usePortalMutation({
    mutationFn: async () => {
      const { kinId } = await addKin(buildNewKinPayload(form), kinfolkId);
      if (!photoFile) return { kinId, photoFailed: false };
      setUploadingPhoto(true);
      try {
        await uploadKinPhotoSigned(kinId, photoFile, kinfolkId);
        return { kinId, photoFailed: false };
      } catch {
        return { kinId, photoFailed: true };
      } finally {
        setUploadingPhoto(false);
      }
    },
    // #1281: the new Kin's page reads the kin list, so the list is refreshed
    // (and waited for) before the move; "Saving…" stays up until then.
    onSuccess: async (res) => {
      await refreshAfterSave(queryClient, ['myKin', kinfolkId]);
      if (res.photoFailed) {
        void navigate({ to: '/kin/$kinId/edit', params: { kinId: res.kinId }, search: { photo: 'failed' } });
      } else {
        void navigate({ to: '/kin/$kinId', params: { kinId: res.kinId } });
      }
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

  const set = (key: KinTextKey, value: string) => {
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

  const textField = (key: KinTextKey, label: string, opts?: { full?: boolean; area?: boolean; required?: boolean; type?: string }) => (
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
              <SexField id="kin-new-sex" value={form.sex} onChange={(v) => set('sex', v)} error={errors.sex} />
              {textField('weight', 'Weight')}
              {textField('colorMarkings', 'Color / markings')}
              <FixedField id="kin-new-spayedNeutered" checked={form.spayedNeutered} onChange={(v) => setForm((f) => ({ ...f, spayedNeutered: v }))} />
              <div className="field full">
                <label id="kin-new-photo-label">Photo</label>
                <SignedImageUpload
                  onPicked={(file) => setPhotoFile(file)}
                  validate={validateKinPhotoFile}
                  imageUrl={photoPreview}
                  onClear={() => setPhotoFile(null)}
                  fallback={'\u{1F43E}'}
                  pickLabel="Add Photo"
                  replaceLabel="Replace Photo"
                  clearLabel="Remove Photo"
                  disabled={save.isPending}
                />
              </div>
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
              {textField('vetInfo', 'Vet', { full: true, area: true })}
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
                <MutationLabel mutation={save} busy={uploadingPhoto ? 'Uploading photo…' : 'Adding…'}>
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

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}
