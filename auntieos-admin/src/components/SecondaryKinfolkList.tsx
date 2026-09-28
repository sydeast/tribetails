import { useCallback, useEffect, useState } from 'react';
import {
  SECONDARY_KINFOLK_ACCESS_LABEL,
  listSecondaryKinfolk,
  removeSecondaryKinfolk,
  saveSecondaryKinfolk,
  type SecondaryKinfolk,
  type SecondaryKinfolkDraft,
} from '../api/secondaryKinfolk';
import { type Async } from '../lib/async';
import { AsyncLoading } from './AsyncRegion';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import { ErrorHint, StatusPill } from './DenScreenKit';
import { Dialog } from './Dialog';
import './SecondaryKinfolkList.css';

const EMPTY: SecondaryKinfolkDraft = { name: '', phone: '', email: '' };

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

/**
 * The secondary kinfolk on a household who have no portal account yet
 * (operator ruling 2026-09-27, Q3), inside the admin's "Secondary kinfolk"
 * panel under the member rows.
 *
 * The admin can add, edit and remove one. There is no invite here, on purpose:
 * "the admin invites only the primary; the primary invites the secondary and
 * sets their permissions." A person who accepted the primary's invite is an
 * ACTIVE member row above and is not repeated here.
 *
 * Saves are pessimistic: the dialog locks and reads "Saving…" until the server
 * answers, and a refusal keeps what was typed under the server's own sentence.
 */
export function SecondaryKinfolkList({ kinfolkId }: { kinfolkId: string }) {
  const [people, setPeople] = useState<Async<SecondaryKinfolk[]>>({ status: 'loading' });
  const [editing, setEditing] = useState<{ personId?: string; draft: SecondaryKinfolkDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SecondaryKinfolk | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setPeople({ status: 'loading' });
    listSecondaryKinfolk(kinfolkId)
      .then((data) => {
        if (live) setPeople({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) setPeople({ status: 'error', message: `listSecondaryKinfolk failed: ${errText(err, 'Load failed')}`, retry: load });
      });
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => load(), [load]);

  function open(person?: SecondaryKinfolk) {
    setSaveError(null);
    setEditing(
      person === undefined
        ? { draft: { ...EMPTY } }
        : { personId: person.personId, draft: { name: person.name, phone: person.phone ?? '', email: person.email ?? '' } },
    );
  }

  async function save() {
    if (editing === null) return;
    if (editing.draft.name.trim() === '') {
      setSaveError('A secondary kinfolk needs a name.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveSecondaryKinfolk(kinfolkId, editing.draft, editing.personId);
      setEditing(null);
      load();
    } catch (err) {
      setSaveError(errText(err, 'The secondary kinfolk was not saved. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    if (removeTarget === null) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeSecondaryKinfolk(kinfolkId, removeTarget.personId);
      setRemoveTarget(null);
      load();
    } catch (err) {
      setRemoveError(errText(err, 'The secondary kinfolk was not removed. Try again.'));
    } finally {
      setRemoving(false);
    }
  }

  const set = (patch: Partial<SecondaryKinfolkDraft>) =>
    setEditing((e) => (e === null ? e : { ...e, draft: { ...e.draft, ...patch } }));

  const rows = people.status === 'ready' ? people.data.filter((p) => p.access !== 'ACTIVE') : [];

  return (
    <div className="skin" data-testid="secondary-kinfolk">
      {people.status === 'loading' && <AsyncLoading what="secondary kinfolk" />}
      {people.status === 'error' && (
        <ErrorHint>
          {people.message}{' '}
          <GhostButton label="Try again" onClick={() => people.retry?.()} />
        </ErrorHint>
      )}
      {rows.length > 0 && (
        <ul className="skin__list">
          {rows.map((p) => (
            <li key={p.personId} className="skin__row" data-testid="secondary-kinfolk-row">
              <div className="skin__who">
                <span className="skin__name">{p.name}</span>
                <StatusPill label={SECONDARY_KINFOLK_ACCESS_LABEL[p.access]} tone={p.access === 'INVITED' ? 'warning' : 'neutral'} size="compact" />
                {(p.phone !== null || p.email !== null) && (
                  <span className="skin__contact">{[p.phone, p.email].filter((v) => v !== null).join(' · ')}</span>
                )}
              </div>
              <div className="skin__actions">
                <GhostButton label="Edit" onClick={() => open(p)} />
                <GhostButton label="Remove" onClick={() => { setRemoveError(null); setRemoveTarget(p); }} className="hmembers__danger" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <GhostButton label="Add secondary kinfolk" onClick={() => open()} />

      {editing !== null && (
        <Dialog
          title={editing.personId === undefined ? 'Add secondary kinfolk' : 'Edit secondary kinfolk'}
          onClose={() => {
            if (!saving) setEditing(null);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setEditing(null)} disabled={saving} />
              <PrimaryButton label={saving ? 'Saving…' : 'Save'} onClick={() => void save()} disabled={saving} busy={saving} />
            </>
          }
        >
          <fieldset className="skin__form" disabled={saving}>
            <label className="skin__field">
              <span className="skin__label">Name</span>
              <input id="skin-name" type="text" maxLength={80} value={editing.draft.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="skin__field">
              <span className="skin__label">Phone (optional)</span>
              <input id="skin-phone" type="tel" maxLength={32} value={editing.draft.phone} onChange={(e) => set({ phone: e.target.value })} />
            </label>
            <label className="skin__field">
              <span className="skin__label">Email (optional)</span>
              <input id="skin-email" type="email" maxLength={254} value={editing.draft.email} onChange={(e) => set({ email: e.target.value })} />
            </label>
          </fieldset>
          <p className="skin__note">No invite is sent. Only their primary kinfolk can give them portal access.</p>
          {saveError !== null && (
            <Banner tone="error" title="Not saved">
              {saveError}
            </Banner>
          )}
        </Dialog>
      )}

      {removeTarget !== null && (
        <Dialog
          title={`Remove ${removeTarget.name}?`}
          onClose={() => {
            if (!removing) setRemoveTarget(null);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setRemoveTarget(null)} disabled={removing} />
              <PrimaryButton label={removing ? 'Removing…' : 'Remove'} onClick={() => void confirmRemove()} disabled={removing} busy={removing} />
            </>
          }
        >
          <p>{removeTarget.name} will no longer be listed on this household.</p>
          {removeError !== null && (
            <Banner tone="error" title="That did not work">
              {removeError}
            </Banner>
          )}
        </Dialog>
      )}
    </div>
  );
}
