import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listSecondaryKinfolk,
  removeSecondaryKinfolk,
  saveSecondaryKinfolk,
  type SecondaryKinfolkDto,
} from '../api/tribeApi';
import { viewOfQuery } from '../lib/queryState';
import { BusyLabel } from './Loading';
import { OfflineNotice } from './OfflineNotice';

interface Draft {
  personId?: string;
  name: string;
  phone: string;
  email: string;
}

const EMPTY: Draft = { name: '', phone: '', email: '' };
const NAME_REQUIRED = 'A secondary kinfolk needs a name.';
const ACCESS_LABEL: Record<SecondaryKinfolkDto['access'], string> = {
  NONE: 'No portal access',
  INVITED: 'Invited',
  ACTIVE: 'Portal access',
};

export const secondaryKinfolkQueryKey = (kinfolkId: string | undefined) => ['secondaryKinfolk', kinfolkId];

/**
 * Secondary kinfolk with no portal account (operator ruling 2026-09-27, Q3):
 * "A Secondary kinfolk can be added to the household but doesn't have portal
 * access unless PK invites them and set access."
 *
 * PRIMARY-only, like the Household Members card: `listSecondaryKinfolk` refuses
 * a secondary, and the card then says it could not load, the same way.
 *
 * Adding one sends no invite. "Give portal access" hands the person to the
 * Invite a Kinfolk card through `onGiveAccess`, which pre-fills it, so the
 * primary picks the permissions with the same toggles as any invite. A person
 * who accepted is a Household Members row and is not repeated here.
 *
 * Saves are pessimistic: the form locks and reads "Saving…" until the server
 * answers, and a refusal keeps what was typed under the server's own sentence.
 */
export function SecondaryKinfolkCard(props: {
  kinfolkId: string | undefined;
  onGiveAccess: (person: SecondaryKinfolkDto) => void;
}) {
  const { kinfolkId, onGiveAccess } = props;
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: secondaryKinfolkQueryKey(kinfolkId), queryFn: () => listSecondaryKinfolk(kinfolkId) });
  const view = viewOfQuery(q);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const people = (q.data ?? []).filter((p) => p.access !== 'ACTIVE');
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setMessage(null);
  };

  async function save() {
    if (draft.name.trim() === '') {
      setMessage({ text: NAME_REQUIRED, ok: false });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const blank = (v: string) => (v.trim() === '' ? null : v.trim());
      await saveSecondaryKinfolk({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        ...(draft.personId !== undefined ? { personId: draft.personId } : {}),
        name: draft.name.trim(),
        phone: blank(draft.phone),
        email: blank(draft.email),
      });
      setDraft({ ...EMPTY });
      setMessage({ text: 'Saved.', ok: true });
      await queryClient.invalidateQueries({ queryKey: secondaryKinfolkQueryKey(kinfolkId) });
    } catch (err) {
      setMessage({ text: err instanceof Error && err.message ? err.message : 'Not saved. Try again.', ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function remove(personId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await removeSecondaryKinfolk({ ...(kinfolkId !== undefined ? { kinfolkId } : {}), personId });
      setConfirmRemove(null);
      if (draft.personId === personId) setDraft({ ...EMPTY });
      await queryClient.invalidateQueries({ queryKey: secondaryKinfolkQueryKey(kinfolkId) });
    } catch (err) {
      setMessage({ text: err instanceof Error && err.message ? err.message : 'Not removed. Try again.', ok: false });
    } finally {
      setBusy(false);
    }
  }

  const editing = draft.personId !== undefined;

  return (
    <section className="glass card d4" aria-labelledby="skin-title">
      <div className="cardhead">
        <div className="ic purple">{'\u{1F46A}'}</div>
        <div className="htxt">
          <h3 className="title" id="skin-title">
            Secondary Kinfolk
          </h3>
          <p className="sub">Add someone in your household without giving them portal access. You can invite them later.</p>
        </div>
      </div>

      {view.kind === 'offline' ? (
        <OfflineNotice what="your secondary kinfolk" compact />
      ) : view.kind === 'error' ? (
        <p className="sub">Couldn&rsquo;t load secondary kinfolk right now.</p>
      ) : view.kind !== 'data' ? (
        <p className="sub">
          <BusyLabel>Loading secondary kinfolk…</BusyLabel>
        </p>
      ) : (
        <>
          {people.length > 0 && (
            <ul className="skin-list">
              {people.map((p) => (
                <li key={p.personId} className="memberrow" data-testid="skin-row">
                  <div className="mname">{p.name}</div>
                  <div className="msub">{[p.phone, p.email, ACCESS_LABEL[p.access]].filter(Boolean).join(' · ')}</div>
                  {confirmRemove === p.personId ? (
                    <div className="contactactions">
                      <span className="sub">Remove {p.name}?</span>
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => void remove(p.personId)}>
                        {busy ? <BusyLabel>Removing…</BusyLabel> : 'Yes, remove'}
                      </button>
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmRemove(null)}>
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className="contactactions">
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => onGiveAccess(p)}>
                        Give portal access
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy}
                        aria-label={`Edit ${p.name}`}
                        onClick={() => {
                          setMessage(null);
                          setDraft({ personId: p.personId, name: p.name, phone: p.phone ?? '', email: p.email ?? '' });
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="btn ghost" disabled={busy} aria-label={`Remove ${p.name}`} onClick={() => setConfirmRemove(p.personId)}>
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <fieldset className="skin-form" disabled={busy} aria-label={editing ? 'Edit secondary kinfolk' : 'Add secondary kinfolk'}>
            <div className="grid2">
              <div className="field full">
                <label htmlFor="skin-name">Name</label>
                <input id="skin-name" className="inp" type="text" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="skin-phone">Phone (optional)</label>
                <input id="skin-phone" className="inp mono" type="tel" maxLength={32} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="skin-email">Email (optional)</label>
                <input id="skin-email" className="inp" type="email" maxLength={254} value={draft.email} onChange={(e) => set({ email: e.target.value })} />
              </div>
            </div>
          </fieldset>
          <div className="contactactions">
            <button type="button" className="btn grad" disabled={busy} onClick={() => void save()}>
              {busy ? <BusyLabel>Saving…</BusyLabel> : editing ? 'Save changes' : 'Add secondary kinfolk'}
            </button>
            {editing && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft({ ...EMPTY })}>
                Cancel
              </button>
            )}
          </div>
          {message && (
            <p className="sub" role={message.ok ? 'status' : 'alert'} style={{ color: message.ok ? 'var(--teal)' : 'var(--coral)', marginTop: 8 }}>
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
