import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveKin, canDeleteKin, deleteKin, getMyKin, updateKin } from '../api/portal';
import { BREEDS_QUERY, EMPTY_BREED_BANKS } from '../api/breeds';
import type { KinPayloadPartial } from '../api/types';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { breedCatalogForSpecies, speciesWantsBreedBank } from '../lib/breedSearch';
import { BreedField } from '../components/BreedField';
import { SpeciesField } from '../components/SpeciesField';
import { PortalNav } from '../components/PortalNav';
import { FixedField, SexField } from '../components/KinFactsFields';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { viewOfQuery } from '../lib/queryState';
import { buildKinChanges, hasErrors, kinFormFromDto, validateKinForm, type KinEditForm, type KinTextKey } from '../lib/kinEditForm';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { useIsMounted, usePortalMutation } from '../lib/mutationState';
import { SignedImageUpload } from '../components/SignedImageUpload';
import { BusyLabel } from '../components/Loading';
import { confirmKinPhotoUpload, signKinPhotoUpload, validateKinPhotoFile } from '../api/kinPhotoApi';
import { refreshAfterSave } from '../lib/refreshAfterSave';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

/**
 * Kin edit form (open item O-17): the React counterpart to Compose's
 * AddEditKinDialog. There is no getKinById callable, so this reads the same
 * ['myKin', kinfolkId] cache as KinDetail/Kin and finds the row by id, then
 * seeds an editable copy. Save sends only the changed fields to updateKin
 * (kin_edit enforced server-side) and returns to the detail on success.
 * Validation mirrors the KinPayload server schema so the form fails loud
 * before the call (see lib/kinEditForm.ts).
 *
 * #1291: the photo is a real upload, not a URL box. Picking a file runs
 * signKinPhotoUpload -> direct Cloudinary POST (metadata stripped by the
 * signed `fl_force_strip`) -> confirmKinPhotoUpload, which writes photoUrl
 * on the kin doc. Remove sends `photoUrl: null` through updateKin. Both take
 * effect immediately, independent of Save, and the text form never carries
 * photoUrl, so Save can not undo either one.
 *
 * #1311: the memorial action lives here, not on the profile. It is the last
 * control on the page, below Save / Cancel and behind a confirm step; a
 * memorial Kin gets "Restore as Active" in the same slot. The `kinactions`
 * block takes more rows after it.
 *
 * #1314: "Delete this Kin" is the second row, shown only when the server says
 * the Kin has no history (no visit, KinTale, photo or admin record). The
 * check is one read of the `deleteKin` callable without `confirm`; the
 * confirm tap calls the same function with it. A Kin with history gets no
 * row here; its path is the request for removal (#1408), not built here.
 */
export function KinEdit() {
  const { kinId } = useParams({ from: '/kin/$kinId/edit' });
  const { photo: photoFlag } = useSearch({ from: '/kin/$kinId/edit' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });
  const found = kin.data?.kin.find((k) => k.id === kinId) ?? null;

  // The seeded dog / cat bank behind the Breed dropdown. Its failure is NOT the
  // screen's failure: breed is free text either way, so a bank that will not
  // load degrades the field rather than the page, and BreedField's note says so.
  const breeds = useQuery(BREEDS_QUERY);
  const breedBanks = breeds.data ?? EMPTY_BREED_BANKS;

  // Seed the editable copy once, the first time this kin resolves, so a
  // background refetch of the list query can't clobber in-progress edits.
  const [form, setForm] = useState<KinEditForm | null>(null);
  // The photo lives beside the form, not in it (see kinEditForm.ts): an
  // upload or a removal is already saved when it finishes.
  const [photoUrl, setPhotoUrl] = useState('');
  // Set by KinAdd when the Kin was created but its photo upload failed.
  // Cleared by the first photo action here, successful or not.
  const [photoCarryover, setPhotoCarryover] = useState(photoFlag === 'failed');
  const seededId = useRef<string | null>(null);
  useEffect(() => {
    if (found && seededId.current !== found.id) {
      setForm(kinFormFromDto(found));
      setPhotoUrl(found.photoUrl ?? '');
      seededId.current = found.id;
    }
  }, [found]);

  // HOLD. `updateKin` is a set/merge on families/{id}/kin/{kinId}, a
  // deterministic document id, so a replay only re-stamps `updatedAt`.
  const isMounted = useIsMounted();
  const save = usePortalMutation({
    mutationFn: (changes: KinPayloadPartial) => updateKin(kinId, changes, kinfolkId),
    // #1281: the profile this navigates to reads the kin list, so the refresh
    // is waited for first; otherwise it opens on the pre-save values.
    onSuccess: async () => {
      await refreshAfterSave(queryClient, ['myKin', kinfolkId]);
      // Guarded because this write is HELD: a queued save resumes on
      // reconnect whether or not this screen is still open, and navigating
      // from a dead screen drops the household onto a Kin profile they did
      // not ask for. The cache invalidation above is the part that still
      // matters when they are elsewhere.
      if (isMounted()) void navigate({ to: '/kin/$kinId', params: { kinId } });
    },
  }, { policy: 'hold', what: 'this update' });

  // ABANDON, matching the upload half: a photo change is a deliberate tap the
  // household watches finish, not something to replay behind their back.
  const removePhoto = usePortalMutation({
    mutationFn: () => updateKin(kinId, { photoUrl: null }, kinfolkId),
    onSuccess: () => {
      setPhotoUrl('');
      void queryClient.invalidateQueries({ queryKey: ['myKin', kinfolkId] });
    },
  }, { policy: 'abandon', what: 'this photo change' });

  // HOLD. `archiveKin` set/merges one fixed status ('active' or
  // 'noLongerWithUs') onto a known doc id, so a replay writes the same value.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const archive = usePortalMutation({
    mutationFn: (reason: 'noLongerWithUs' | 'restore') => archiveKin(kinId, reason, kinfolkId),
    // #1281: pending until the kin list shows the change, then back to the
    // profile, where the "In our hearts" band (or its absence) confirms it.
    onSuccess: async () => {
      await refreshAfterSave(queryClient, ['myKin', kinfolkId]);
      setConfirmingArchive(false);
      if (isMounted()) void navigate({ to: '/kin/$kinId', params: { kinId } });
    },
  }, { policy: 'hold', what: 'this change' });

  // #1314: the delete row exists only when the server says there is nothing
  // on file for this Kin. Hidden while the check loads, when it fails, and
  // when it says no; the server re-checks on the confirm tap regardless.
  const eligibility = useQuery({
    queryKey: ['kinDelete', kinfolkId, kinId],
    queryFn: () => canDeleteKin(kinId, kinfolkId),
    enabled: found !== null,
  });
  const canDelete = eligibility.data?.canDelete === true;

  // ABANDON. A hard delete is not replayed from a queue behind the
  // household's back: they watch it finish, or they tap it again.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Set the moment the server confirms the delete, before the roster refetch
  // lands: once it does, `found` is null and this screen would otherwise show
  // "We couldn't find that profile" for the instant before navigation.
  const [deleted, setDeleted] = useState(false);
  const del = usePortalMutation({
    mutationFn: () => deleteKin(kinId, kinfolkId),
    onSuccess: async () => {
      setDeleted(true);
      // The list this navigates to reads the kin roster, so the refresh is
      // waited for first; otherwise it opens with the deleted Kin still on it.
      await refreshAfterSave(queryClient, ['myKin', kinfolkId]);
      if (isMounted()) void navigate({ to: '/kin' });
    },
  }, { policy: 'abandon', what: 'this delete' });

  const { signOut, signingOut } = useSignOut();

  if (kin.isError) {
    return <LaunchError onRetry={() => void kin.refetch()} retrying={kin.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  // Paused, this fell through to the `!found` card: an edit screen telling a
  // household their Kin is not in a list that was never fetched.
  const kinView = viewOfQuery(kin);
  const breedsView = viewOfQuery(breeds);
  if (kinView.kind === 'offline') {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <section className="glass card">
            <OfflineNotice what="this profile" />
          </section>
        </div>
      </>
    );
  }
  if (kinView.kind !== 'data' || (found && form === null)) {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <p className="sub">Loading profile…</p>
        </div>
      </>
    );
  }
  // #1314: deleted, roster refreshing, Kin list next.
  if (deleted) {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <p className="sub" role="status">
            <BusyLabel>Deleting…</BusyLabel>
          </p>
        </div>
      </>
    );
  }

  if (!found || form === null) {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <div className="crumbrow">
            <Link className="backlink" to="/kin">
              {'←'} Back to Kin
            </Link>
          </div>
          <section className="glass card">
            <h3 className="title">We couldn&rsquo;t find that profile.</h3>
            <p className="sub">It may have been removed. Head back to The Kin to see the current roster.</p>
          </section>
        </div>
      </>
    );
  }

  const kinDoc = found;
  const current = form;
  const errors = validateKinForm(current);
  const changes = buildKinChanges(kinDoc, current);
  const nothingToSave = Object.keys(changes).length === 0;
  const canSave = !hasErrors(errors) && !nothingToSave && !save.isPending && !archive.isPending && !del.isPending;
  const memorial = kinDoc.status === 'noLongerWithUs';
  // One write at a time: the memorial action waits on a Save in flight and
  // the other way round, and the delete row waits on both.
  const archiveBusy = archive.isPending || save.isPending || del.isPending;
  const deleteBusy = archiveBusy;

  const set = (key: KinTextKey, value: string) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const submit = () => {
    if (!canSave) return;
    save.mutate(changes);
  };

  const textField = (key: KinTextKey, label: string, opts?: { full?: boolean; area?: boolean; required?: boolean; type?: string }) => (
    <div className={opts?.full ? 'field full' : 'field'}>
      <label htmlFor={`kin-${key}`}>
        {label}
        {opts?.required ? ' *' : ''}
      </label>
      {opts?.area ? (
        <textarea id={`kin-${key}`} className="inp" value={current[key]} onChange={(e) => set(key, e.target.value)} />
      ) : (
        <input id={`kin-${key}`} className="inp" type={opts?.type ?? 'text'} value={current[key]} onChange={(e) => set(key, e.target.value)} />
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
          <Link className="backlink" to="/kin/$kinId" params={{ kinId }}>
            {'←'} Back to profile
          </Link>
          <div className="seg">
            <span className="page">Edit {kinDoc.name ?? 'Kin'}</span>
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
              <SpeciesField id="kin-species" value={current.species} onChange={(v) => set('species', v)} error={errors.species} />
              {/* Beside Species on purpose: Species is what picks the bank. */}
              <BreedField
                value={current.breed}
                onChange={(next) => set('breed', next)}
                catalog={breedCatalogForSpecies(
                  current.species,
                  breedBanks.dogBreeds,
                  breedBanks.catBreeds,
                )}
                error={errors.breed}
                note={
                  // The breed bank is its own query, so it can be paused while
                  // the Kin roster came from cache. Without this arm the field
                  // just offers nothing and says nothing.
                  !speciesWantsBreedBank(current.species)
                    ? null
                    : breedsView.kind === 'offline'
                      ? 'You are offline, so the breed list is unavailable. Type it in.'
                      : breedsView.kind === 'error'
                        ? 'Breed list unavailable right now, type it in.'
                        : null
                }
              />
              {textField('ageYears', 'Age (years)', { type: 'text' })}
              <SexField id="kin-sex" value={current.sex} onChange={(v) => set('sex', v)} error={errors.sex} />
              {textField('weight', 'Weight')}
              {textField('colorMarkings', 'Color / markings')}
              <FixedField id="kin-spayedNeutered" checked={current.spayedNeutered} onChange={(v) => setForm((f) => (f ? { ...f, spayedNeutered: v } : f))} />
              <div className="field full">
                <label id="kin-photo-label">Photo</label>
                <SignedImageUpload
                  sign={() => signKinPhotoUpload(kinId, kinfolkId)}
                  confirm={async (secureUrl) => (await confirmKinPhotoUpload(kinId, secureUrl, kinfolkId)).photoUrl}
                  validate={validateKinPhotoFile}
                  onUploaded={(url) => {
                    setPhotoUrl(url);
                    setPhotoCarryover(false);
                    removePhoto.reset();
                    void queryClient.invalidateQueries({ queryKey: ['myKin', kinfolkId] });
                  }}
                  onError={() => setPhotoCarryover(false)}
                  imageUrl={photoUrl}
                  onClear={() => {
                    setPhotoCarryover(false);
                    removePhoto.mutate();
                  }}
                  fallback={'\u{1F43E}'}
                  pickLabel="Add Photo"
                  replaceLabel="Replace Photo"
                  clearLabel="Remove Photo"
                  disabled={removePhoto.isPending}
                />
                {removePhoto.isPending && (
                  <span className="sub" role="status">
                    <BusyLabel>Removing photo…</BusyLabel>
                  </span>
                )}
                {removePhoto.phase === 'failed' && (
                  <span className="hint" role="alert" style={{ color: 'var(--coral)' }}>
                    {removePhoto.error instanceof Error ? removePhoto.error.message : 'Could not remove the photo. Try again.'}
                  </span>
                )}
                <OfflineMutationNotice phase={removePhoto.phase} what="this photo change" check="this Kin" />
                {photoCarryover && (
                  <span className="hint" role="alert" style={{ color: 'var(--coral)' }}>
                    {kinDoc.name ?? 'This Kin'} was added, but the photo did not upload. Pick it again here.
                  </span>
                )}
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
              <button className="btn grad" type="button" onClick={submit} disabled={!canSave}>
                {'\u{1F4BE}'}{' '}
                <MutationLabel mutation={save} busy="Saving…">
                  Save Changes
                </MutationLabel>
              </button>
              <Link className="btn ghost" to="/kin/$kinId" params={{ kinId }}>
                Cancel
              </Link>
              {save.phase === 'failed' && (
                <span className="status err">
                  <span className="dot" />
                  {save.error instanceof Error ? save.error.message : 'Could not save. Try again.'}
                </span>
              )}
              <OfflineMutationNotice phase={save.phase} what="this update" check="this Kin" />
              {!save.isError && nothingToSave && !hasErrors(errors) && <span className="sub">No changes yet.</span>}
              {hasErrors(errors) && <span className="sub">Fix the highlighted fields to save.</span>}
            </div>
          </section>

          {/* KIN ACTIONS (#1311). Last on the page, after Save / Cancel, behind a
              hairline. Memorial first, then delete (#1314, only without history);
              #1408 adds "Request removal" below for a Kin with history. */}
          <hr className="divider" />
          <section className="kinactions" aria-label="Kin actions">
            <div className="kinaction" data-testid="kinaction-memorial">
              {memorial ? (
                <button className="btn coralout" type="button" onClick={() => archive.mutate('restore')} disabled={archiveBusy}>
                  <MutationLabel mutation={archive} busy="Restoring…">
                    Restore as Active
                  </MutationLabel>
                </button>
              ) : confirmingArchive ? (
                <>
                  <span className="sub">Mark {kinDoc.name ?? 'this Kin'} as no longer with us? You can restore the profile from here.</span>
                  <div className="kinaction__choices">
                    <button className="btn ghost" type="button" onClick={() => setConfirmingArchive(false)} disabled={archiveBusy}>
                      Cancel
                    </button>
                    <button className="btn purple" type="button" onClick={() => archive.mutate('noLongerWithUs')} disabled={archiveBusy}>
                      <MutationLabel mutation={archive} busy="Saving…">
                        Yes, mark No Longer With Us
                      </MutationLabel>
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn purple" type="button" onClick={() => setConfirmingArchive(true)} disabled={archiveBusy}>
                  Mark No Longer With Us
                </button>
              )}
              {archive.phase === 'failed' && (
                <span className="status err" role="alert">
                  <span className="dot" />
                  {archive.error instanceof Error ? archive.error.message : 'Could not save. Try again.'}
                </span>
              )}
              <OfflineMutationNotice phase={archive.phase} what="this change" check="this Kin" />
            </div>

            {/* #1314: delete, only when the server found nothing on file. */}
            {canDelete && (
              <div className="kinaction" data-testid="kinaction-delete">
                {confirmingDelete ? (
                  <>
                    <span className="sub">Delete {kinDoc.name ?? 'this Kin'}? The profile is removed for good.</span>
                    <div className="kinaction__choices">
                      <button className="btn ghost" type="button" onClick={() => setConfirmingDelete(false)} disabled={deleteBusy}>
                        Cancel
                      </button>
                      <button className="btn coralout" type="button" onClick={() => del.mutate()} disabled={deleteBusy}>
                        <MutationLabel mutation={del} busy="Deleting…">
                          Yes, delete this Kin
                        </MutationLabel>
                      </button>
                    </div>
                  </>
                ) : (
                  <button className="btn coralout" type="button" onClick={() => setConfirmingDelete(true)} disabled={deleteBusy}>
                    Delete this Kin
                  </button>
                )}
                {del.phase === 'failed' && (
                  <span className="status err" role="alert">
                    <span className="dot" />
                    {del.error instanceof Error ? del.error.message : 'Could not delete. Try again.'}
                  </span>
                )}
                <OfflineMutationNotice phase={del.phase} what="this delete" check="this Kin" />
              </div>
            )}

            {/* #1408: "Request removal" for a Kin with history lands here. */}
          </section>
        </div>

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}
