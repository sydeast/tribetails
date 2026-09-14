import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listEmergencyContacts,
  saveEmergencyContacts,
  type EmergencyContactDto,
  type ListEmergencyContactsResult,
} from '../api/tribeApi';
import { viewOfQuery } from '../lib/queryState';
import { BusyLabel } from './Loading';
import { OfflineNotice } from './OfflineNotice';

interface Draft {
  name: string;
  phone: string;
  relationship: string;
}

const MAX_CONTACTS = 2;
const REQUIRED = 'A household needs at least one Emergency Contact';
/** Same sentence admin web, admin Android, desktop and portal Android show. */
const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';
/** The #844 explanation, word for word, so web and Android say the same thing. */
const LOCKED = 'Only someone with Home access can change the Emergency Contact.';

const EMPTY_DRAFT: Draft = { name: '', phone: '', relationship: '' };

const toDrafts = (c: EmergencyContactDto[]): Draft[] =>
  c.length > 0 ? c.map((x) => ({ name: x.name, phone: x.phone, relationship: x.relationship ?? '' })) : [{ ...EMPTY_DRAFT }];

/** True when the drafts on screen are exactly what the server copy seeds. */
const sameDrafts = (a: Draft[], b: Draft[]) =>
  a.length === b.length && a.every((d, i) => d.name === b[i]?.name && d.phone === b[i]?.phone && d.relationship === b[i]?.relationship);

/** Digits only, a bare 10-digit US number read as +1, so two spellings of one phone compare equal. */
const digits = (p: string) => p.replace(/\D/g, '').replace(/^(\d{10})$/, '1$1');

/**
 * What the card can refuse before dialling. The household-member check stays on
 * the server: the portal has no member phones to compare against (`listMembers`
 * is PRIMARY-only), and the callable's own message is shown as-is.
 */
function precheck(drafts: Draft[]): string | null {
  if (drafts.every((d) => d.name.trim() === '' && d.phone.trim() === '')) return REQUIRED;
  if (drafts.some((d) => d.name.trim() === '')) return 'Each Emergency Contact needs a name.';
  if (drafts.some((d) => d.phone.trim() === '')) return 'Each Emergency Contact needs a phone number.';
  const [first, second] = drafts;
  if (first && second && digits(first.phone) === digits(second.phone)) return 'The two Emergency Contacts need different phone numbers.';
  return null;
}

/**
 * Small info icon beside the card title. `title` covers a mouse hover; a tap
 * toggles the sentence open, because a phone has no hover and iOS kinfolk only
 * have this web portal (portal Android's `KinInfoTip` opens on a tap too).
 *
 * A tap anywhere outside closes it. `onBlur` alone is not enough: iOS Safari
 * does not focus a tapped button, so it never blurs and the tip stayed open.
 */
function InfoTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  return (
    <span className="ec-tip" ref={ref}>
      <button
        type="button"
        className="ec-tip__icon"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? 'ec-tip-text' : undefined}
        title={text}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        i
      </button>
      {open && (
        <span id="ec-tip-text" role="tooltip" className="ec-tip__text">
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * The household's Emergency Contacts (#829): up to two, the first called first,
 * never messaged, no portal access. Read by any household member; edited only by
 * someone holding home_access, with the #844 sentence saying why otherwise.
 *
 * Reads and writes ONLY through `listEmergencyContacts` / `saveEmergencyContacts`.
 * The old `emergencyContact*` keys in the profile customFields were a store the
 * admin never read, and nothing here reads or writes them.
 *
 * Saves are pessimistic: the inputs lock and Save reads "Saving..." until the
 * server answers. A refusal leaves every typed value in place under the server's
 * own message.
 *
 * UNSAVED EDITS. The drafts are compared with the server copy they were seeded
 * from (`baseline`). While they differ the card says "Unsaved changes" and tells
 * the page through `onDirtyChange`, because the page's own Save Changes never
 * sends contacts. A background refetch only reseeds the drafts when there is
 * nothing unsaved, and a save writes the reply into the query cache instead of
 * refetching, so the household sees exactly what the server stored.
 */
export function EmergencyContactsCard(props: { kinfolkId: string | undefined; onDirtyChange?: (dirty: boolean) => void }) {
  // Keyed on the household: a switch starts a fresh card, so no draft, busy Save
  // or message from one household is ever shown on another.
  return <EmergencyContactsCardFor key={props.kinfolkId ?? ''} {...props} />;
}

function EmergencyContactsCardFor({
  kinfolkId,
  onDirtyChange,
}: {
  kinfolkId: string | undefined;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  /** False once this household's card has left the screen; a save reply that lands after that is not applied. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const queryClient = useQueryClient();
  const queryKey = ['emergencyContacts', kinfolkId];
  const q = useQuery({ queryKey, queryFn: () => listEmergencyContacts(kinfolkId) });
  const view = viewOfQuery(q);
  const [drafts, setDrafts] = useState<Draft[]>(toDrafts([]));
  /** The server copy the drafts were last seeded from; null until the first load. */
  const [baseline, setBaseline] = useState<EmergencyContactDto[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const dirty = baseline !== null && !sameDrafts(drafts, toDrafts(baseline));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!q.data || dirtyRef.current) return;
    setBaseline(q.data.contacts);
    setDrafts(toDrafts(q.data.contacts));
  }, [q.data]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** Every user edit goes through here, so a stale "Saved." or error never outlives the change it described. */
  const edit = (next: (ds: Draft[]) => Draft[]) => {
    setDrafts(next);
    setMessage(null);
  };
  const set = (i: number, patch: Partial<Draft>) => edit((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function save() {
    const problem = precheck(drafts);
    if (problem) {
      // With none on file the prompt above already says this; a second copy
      // under Save reads as an echo. Kept when the server holds contacts and the
      // household cleared them, where no prompt shows.
      const promptShowing = problem === REQUIRED && (q.data?.contacts.length ?? 0) === 0;
      setMessage(promptShowing ? null : { text: problem, ok: false });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      // A refetch already in flight would otherwise resolve after the reply
      // below and put the older server copy back in the cache and the inputs.
      await queryClient.cancelQueries({ queryKey });
      const res = await saveEmergencyContacts({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        contacts: drafts.map((d) => ({
          name: d.name.trim(),
          phone: d.phone.trim(),
          relationship: d.relationship.trim() === '' ? null : d.relationship.trim(),
        })),
      });
      // The reply is what the server stored (E.164 phones, trimmed names). Write
      // it into the cache instead of refetching. The cancel above is what keeps
      // an earlier refetch from landing over it. `queryKey` is the household the
      // save was sent for, so this is correct even after a switch.
      queryClient.setQueryData<ListEmergencyContactsResult>(queryKey, (old) =>
        old ? { ...old, contacts: res.contacts, legacy: false } : old,
      );
      // The household changed while the save was away: its card is gone, and
      // the reply must not seed another household's slots or say "Saved.".
      if (!alive.current) return;
      setBaseline(res.contacts);
      setDrafts(toDrafts(res.contacts));
      setMessage({ text: 'Saved.', ok: true });
    } catch (err) {
      if (!alive.current) return;
      setMessage({ text: err instanceof Error && err.message ? err.message : 'The Emergency Contacts were not saved. Try again.', ok: false });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  return (
    <section className="glass card d4 ec-card" aria-labelledby="ec-title">
      <div className="cardhead">
        <div className="ic coral">{'\u{1F4DE}'}</div>
        <div className="htxt">
          <h3 className="title" id="ec-title">
            Emergency Contacts <InfoTip text={WHO_GETS_CALLED} label="Who gets called" />
          </h3>
        </div>
      </div>

      {view.kind === 'offline' ? (
        <OfflineNotice what="your Emergency Contacts" compact />
      ) : view.kind === 'error' ? (
        <>
          <p className="sub" role="alert" style={{ color: 'var(--coral)' }}>
            Couldn&rsquo;t load your Emergency Contacts right now.
          </p>
          {/* Not a dead end: ask again, with a busy label while it runs. */}
          <div className="contactactions">
            <button type="button" className="btn ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
              {q.isFetching ? <BusyLabel>Trying again…</BusyLabel> : 'Try again'}
            </button>
          </div>
        </>
      ) : view.kind !== 'data' ? (
        <p className="sub">
          <BusyLabel>Loading Emergency Contacts…</BusyLabel>
        </p>
      ) : !view.data.canEdit ? (
        <>
          {view.data.contacts.length === 0 ? (
            <p className="sub">{REQUIRED}</p>
          ) : (
            <ol className="ec-list">
              {view.data.contacts.map((c, i) => (
                <li key={`${c.phone}-${i}`}>
                  <span className="ec-list__order">{i === 0 ? 'Called first' : 'Called second'}</span>
                  <span className="ec-list__name">{c.name}</span>
                  {c.relationship ? <span className="ec-list__rel">{c.relationship}</span> : null}
                  <a className="ec-list__phone mono" href={`tel:${c.phone}`}>
                    {c.phone}
                  </a>
                </li>
              ))}
            </ol>
          )}
          <p className="sub" data-testid="ec-locked">
            {LOCKED}
          </p>
        </>
      ) : (
        <>
          {view.data.contacts.length === 0 && (
            <p className="sub ec-prompt" role="status">
              {REQUIRED}
            </p>
          )}
          {drafts.map((d, i) => (
            <fieldset key={i} className="ec-slot" aria-label={`Emergency Contact ${i + 1}`} disabled={saving}>
              <legend className="sectlabel">{i === 0 ? 'Called first' : 'Called second'}</legend>
              <div className="grid2">
                <div className="field">
                  <label htmlFor={`ec-${i}-name`}>Name</label>
                  <input id={`ec-${i}-name`} className="inp" type="text" maxLength={80} autoComplete="off" value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`ec-${i}-phone`}>Phone</label>
                  <input id={`ec-${i}-phone`} className="inp mono" type="tel" maxLength={32} autoComplete="off" value={d.phone} onChange={(e) => set(i, { phone: e.target.value })} />
                </div>
                <div className="field full">
                  <label htmlFor={`ec-${i}-relationship`}>Relationship (optional)</label>
                  <input id={`ec-${i}-relationship`} className="inp" type="text" maxLength={40} autoComplete="off" value={d.relationship} onChange={(e) => set(i, { relationship: e.target.value })} />
                </div>
              </div>
              {(i > 0 || drafts.length > 1) && (
                <div className="contactactions">
                  {i > 0 && (
                    <button
                      type="button"
                      className="btn ghost"
                      aria-label={`Call ${d.name.trim() || 'this contact'} first`}
                      onClick={() =>
                        edit((ds) => {
                          const chosen = ds[i];
                          return chosen === undefined ? ds : [chosen, ...ds.filter((_, j) => j !== i)];
                        })
                      }
                    >
                      Call first
                    </button>
                  )}
                  {drafts.length > 1 && (
                    <button
                      type="button"
                      className="btn ghost"
                      aria-label={`Remove Emergency Contact ${i + 1}`}
                      onClick={() => edit((ds) => ds.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </fieldset>
          ))}
          {dirty && (
            <p className="sub ec-unsaved" data-testid="ec-unsaved" role="status">
              Unsaved changes
            </p>
          )}
          <div className="contactactions ec-actions">
            {drafts.length < MAX_CONTACTS && (
              <button type="button" className="btn ghost" disabled={saving} onClick={() => edit((ds) => [...ds, { ...EMPTY_DRAFT }])}>
                Add a second Emergency Contact
              </button>
            )}
            <button type="button" className="btn grad" disabled={saving} onClick={() => void save()}>
              {saving ? <BusyLabel>Saving…</BusyLabel> : 'Save Emergency Contacts'}
            </button>
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
