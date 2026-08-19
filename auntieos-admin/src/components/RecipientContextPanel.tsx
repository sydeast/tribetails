import { useEffect, useMemo, useState } from 'react';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { KIN_QUERY, type Kin } from '../api/directory';
import { getFeatureFlags } from '../api/featureFlags';
import {
  getDossier,
  getHouseholdBank,
  getKin411,
  recapRecentComms,
  commsQueries,
  type Dossier,
  type HouseholdBank,
  type Kin411,
} from '../api/recipientContext';
import {
  summaryLine,
  contextFieldShown,
  kinMetaLine,
  latestCommunication,
  commsBoxState,
  type CommsRow,
  type CommsChannel,
} from '../lib/recipientContext';
import { DenPanel, EmptyHint } from './DenScreenKit';
import { Banner } from './Banner';
import './RecipientContextPanel.css';

const DOSSIER_SUMMARY_MAX = 280;
/** The bank describes a whole home, so it gets the dossier's allowance, not a pet's. */
const BANK_SUMMARY_MAX = 280;
const KIN_SUMMARY_MAX = 200;

/** The flag key that gates the paid AI recap. Off by default, per the flag catalog. */
const RECAP_FLAG = 'auntieos.communicate.commsRecap';

const CHANNEL_LABEL: Record<CommsChannel, string> = {
  sms: 'Text',
  email: 'Email',
  call: 'Call',
  voicemail: 'Voicemail',
};

export interface RecipientContextPanelProps {
  /** The resolved kinfolk doc id, or '' when no recipient has been chosen yet. */
  kinfolkId: string;
}

/**
 * What Auntie reads about a household before she drafts: the dossier, each pet's
 * 411, and where things last left off.
 *
 * Ports the archive's `RecipientContextPanel` and `LastCommunicationBox`
 * (screens/communicate/CommunicateScreen.kt). Internal, admin-only reading
 * material, not client-facing copy, and the panel says so.
 *
 * ── THE ONE PIECE OF HONESTY THIS PANEL TURNS ON ────────────────────────────
 * The AI recap is gated behind `auntieos.communicate.commsRecap`, off by
 * default. Flag off means the raw latest message with no commentary, because no
 * recap was promised. Flag ON but the recap came back blank means the raw latest
 * message WITH a note saying that is what you are looking at. Those two renders
 * are otherwise identical, and an operator who turned the recap on and is
 * quietly being served the fallback would have no way to tell. A recap that
 * FAILS gets its own named banner, with the raw message still shown beneath it,
 * because a weaker true answer beats a blank box.
 *
 * ── READS ───────────────────────────────────────────────────────────────────
 * The kin list reuses `KIN_QUERY`, the same bounded, sandbox-scoped listener
 * Directory uses, filtered to this household in memory. Each pet's 411 is
 * fetched lazily when its card is opened, so a six-pet household costs no reads
 * to render collapsed. The four comms logs are per-household filtered queries
 * (see `api/recipientContext.ts` for why they order by document id and sort in
 * memory rather than requiring four composite indexes nobody has deployed).
 */
export function RecipientContextPanel({ kinfolkId }: RecipientContextPanelProps) {
  const id = kinfolkId.trim();
  const hasRecipient = id !== '';

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierError, setDossierError] = useState<string | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);

  const [bank, setBank] = useState<HouseholdBank | null>(null);
  const [bankError, setBankError] = useState<string | null>(null);
  const [bankLoading, setBankLoading] = useState(false);

  const [recapFlagOn, setRecapFlagOn] = useState(false);
  const [recap, setRecap] = useState('');
  const [recapError, setRecapError] = useState<string | null>(null);

  const kinState = useCollection<Kin>(KIN_QUERY);

  // Hooks cannot be called in a loop, so the four channel listeners are spelled
  // out. `commsQueries` keeps their specs in one place and in one order.
  const queries = useMemo(() => commsQueries(id), [id]);
  const smsState = useCollection<Record<string, unknown>>(queries[0]!.spec);
  const emailState = useCollection<Record<string, unknown>>(queries[1]!.spec);
  const callState = useCollection<Record<string, unknown>>(queries[2]!.spec);
  const voicemailState = useCollection<Record<string, unknown>>(queries[3]!.spec);

  useEffect(() => {
    if (!hasRecipient) {
      setDossier(null);
      setDossierError(null);
      return;
    }
    let live = true;
    setDossierLoading(true);
    setDossierError(null);
    getDossier(id)
      .then((d) => {
        if (live) setDossier(d);
      })
      .catch((err: unknown) => {
        if (live) setDossierError(err instanceof Error ? err.message : 'The dossier could not be read.');
      })
      .finally(() => {
        if (live) setDossierLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, hasRecipient]);

  // The bank is read eagerly alongside the dossier rather than lazily like a kin
  // card. There is exactly one per household, so it costs one read, and it is
  // the record that answers "how does somebody get in the door", which is not a
  // thing to make an admin click for.
  useEffect(() => {
    if (!hasRecipient) {
      setBank(null);
      setBankError(null);
      return;
    }
    let live = true;
    setBankLoading(true);
    setBankError(null);
    getHouseholdBank(id)
      .then((b) => {
        if (live) setBank(b);
      })
      .catch((err: unknown) => {
        if (live) {
          setBankError(err instanceof Error ? err.message : 'The household bank could not be read.');
        }
      })
      .finally(() => {
        if (live) setBankLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, hasRecipient]);

  // The flag is read once per mount. A failed read leaves the recap OFF, which
  // is both the catalog default and the non-spending choice; the panel still
  // shows the raw latest message, so nothing is hidden by the failure.
  useEffect(() => {
    let live = true;
    getFeatureFlags()
      .then((flags) => {
        if (live) setRecapFlagOn(flags[RECAP_FLAG] === true);
      })
      .catch(() => {
        if (live) setRecapFlagOn(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!hasRecipient || !recapFlagOn) {
      setRecap('');
      setRecapError(null);
      return;
    }
    let live = true;
    setRecapError(null);
    recapRecentComms(id)
      .then((r) => {
        if (live) setRecap(r.recap);
      })
      .catch((err: unknown) => {
        if (live) {
          setRecap('');
          setRecapError(err instanceof Error ? err.message : 'The recap call failed.');
        }
      });
    return () => {
      live = false;
    };
  }, [id, hasRecipient, recapFlagOn]);

  const kin = useMemo(() => {
    if (kinState.status !== 'ready') return [];
    return kinState.data.filter((k) => str(k.kinfolkId) === id && str(k.status) !== 'archived');
  }, [kinState, id]);

  const commsRows = useMemo<CommsRow[]>(() => {
    const rows: CommsRow[] = [];
    const push = (state: typeof smsState, channel: CommsChannel) => {
      if (state.status !== 'ready') return;
      for (const raw of state.data) {
        rows.push({
          _id: str(raw['_id']),
          channel,
          timestamp: str(raw['timestamp']),
          body: str(raw['body']),
          subject: str(raw['subject']),
          transcript: str(raw['transcript']),
          status: str(raw['status']),
        });
      }
    };
    push(smsState, 'sms');
    push(emailState, 'email');
    push(callState, 'call');
    push(voicemailState, 'voicemail');
    return rows;
  }, [smsState, emailState, callState, voicemailState]);

  const box = commsBoxState(recapFlagOn, recap, latestCommunication(commsRows));

  if (!hasRecipient) {
    return (
      <DenPanel
        title="Recipient context"
        subtitle="The dossier, the household bank and the kin Auntie reads before drafting."
      >
        <p className="context__admin-note">Admin only, internal</p>
        <EmptyHint>
          Pick a recipient to see the dossier, the household bank and the kin Auntie reads for them.
        </EmptyHint>
      </DenPanel>
    );
  }

  const dossierSummary = dossier ? summaryLine(dossier.tldr, dossier.rawSummary, DOSSIER_SUMMARY_MAX) : '';
  const dossierExtras: [string, string][] = dossier
    ? ([
        ['Communication style', dossier.communicationStyle],
        ['Household notes', dossier.householdNotes],
        ['Relationship with Auntie', dossier.relationshipWithAuntie],
      ] as [string, string][]).filter(([, v]) => contextFieldShown(v))
    : [];
  const bankSummary = bank ? summaryLine(bank.tldr, bank.rawSummary, BANK_SUMMARY_MAX) : '';
  const bankExtras: [string, string][] = bank
    ? ([
        ['Access and entry', bank.accessAndEntry],
        ['The property', bank.propertyNotes],
        ['How the home runs', bank.householdRoutine],
        ['Standing instructions', bank.standingInstructions],
        ['Scheduling', bank.schedulingNotes],
      ] as [string, string][]).filter(([, v]) => contextFieldShown(v))
    : [];
  const nothingOnFile =
    !dossierLoading &&
    !bankLoading &&
    dossierError === null &&
    bankError === null &&
    dossierSummary === '' &&
    dossierExtras.length === 0 &&
    bankSummary === '' &&
    bankExtras.length === 0 &&
    kin.length === 0;

  return (
    <DenPanel
      title="Recipient context"
      subtitle="The dossier, the household bank and the kin Auntie reads before drafting."
    >
      <p className="context__admin-note">Admin only, internal</p>

      {dossierError !== null && (
        <Banner tone="error" title="Couldn't load the dossier">
          {dossierError}
        </Banner>
      )}

      {bankError !== null && (
        <Banner tone="error" title="Couldn't load the household bank">
          {bankError}
        </Banner>
      )}

      {kinState.status === 'error' && (
        <Banner tone="error" title="Couldn't load kin">
          {kinState.message}
        </Banner>
      )}

      {nothingOnFile ? (
        <EmptyHint>No saved dossier, household bank or kin on file yet for this recipient.</EmptyHint>
      ) : (
        <>
          {(dossierSummary !== '' || dossierExtras.length > 0) && (
            <section className="context__section">
              <h3 className="context__section-title">The dossier</h3>
              {dossierSummary !== '' && (
                <p className="context__field">
                  <span className="context__field-label">Summary</span>
                  <span className="context__field-value">{dossierSummary}</span>
                </p>
              )}
              {dossierExtras.map(([label, value]) => (
                <p key={label} className="context__field">
                  <span className="context__field-label">{label}</span>
                  <span className="context__field-value">{value}</span>
                </p>
              ))}
            </section>
          )}

          {(bankSummary !== '' || bankExtras.length > 0) && (
            <section className="context__section">
              <h3 className="context__section-title">The household bank</h3>
              {bankSummary !== '' && (
                <p className="context__field">
                  <span className="context__field-label">Summary</span>
                  <span className="context__field-value">{bankSummary}</span>
                </p>
              )}
              {bankExtras.map(([label, value]) => (
                <p key={label} className="context__field">
                  <span className="context__field-label">{label}</span>
                  <span className="context__field-value">{value}</span>
                </p>
              ))}
            </section>
          )}

          {kin.length > 0 && (
            <section className="context__section">
              <h3 className="context__section-title">The 411</h3>
              <ul className="context__kin-list">
                {kin.map((k) => (
                  <KinCard key={k._id} kin={k} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="context__section">
        <h3 className="context__section-title">
          {box.kind === 'recap' ? 'Where things last left off' : 'Latest message'}
        </h3>

        {recapError !== null && (
          <Banner tone="warning">
            AI recap unavailable ({recapError}). Showing the latest message instead.
          </Banner>
        )}

        {box.kind === 'recap' && <p className="context__recap">{box.recap}</p>}

        {box.kind === 'latest' && (
          <>
            <p className="context__latest">
              {CHANNEL_LABEL[box.latest.channel]} · {box.latest.timestamp}: {box.latest.snippet}
            </p>
            {box.disclosedFallback && recapError === null && (
              <p className="context__disclosure">
                Showing the raw latest message (no AI recap came back).
              </p>
            )}
          </>
        )}

        {box.kind === 'empty' && <EmptyHint>No messages on file yet.</EmptyHint>}
      </section>
    </DenPanel>
  );
}

interface KinCardProps {
  kin: Kin;
}

/**
 * One pet, collapsed by default. Its 411 is fetched on first open and kept
 * after, so re-collapsing and re-opening does not pay for the read twice.
 */
function KinCard({ kin }: KinCardProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [four11, setFour11] = useState<Kin411 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    setError(null);
    getKin411(kin._id)
      .then((f) => {
        if (!live) return;
        setFour11(f);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'The 411 could not be read.');
      });
    return () => {
      live = false;
    };
  }, [open, loaded, kin._id]);

  const name = str(kin.name) || 'Unnamed kin';
  const meta = kinMetaLine(str(kin.species), str(kin.breed) || str(four11?.breed ?? ''));
  const summary = four11 ? summaryLine(four11.tldr, four11.rawSummary, KIN_SUMMARY_MAX) : '';
  const extras: [string, string][] = four11
    ? ([
        ['Personality', four11.personality],
        ['Quirks', four11.quirksAndPreferences],
        ['Medical', four11.medicalNotes],
        ['Diet', four11.dietaryDetails],
      ] as [string, string][]).filter(([, v]) => contextFieldShown(v))
    : [];

  return (
    <li className="context__kin">
      <button
        type="button"
        className="context__kin-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="context__kin-name">{name}</span>
        {meta !== '' && <span className="context__kin-meta">{meta}</span>}
      </button>

      {open && (
        <div className="context__kin-body">
          {error !== null ? (
            <p className="context__kin-error" role="alert">
              Couldn&rsquo;t load the 411: {error}
            </p>
          ) : !loaded ? (
            <p className="context__kin-loading">Loading the 411…</p>
          ) : summary === '' && extras.length === 0 ? (
            <p className="context__kin-loading">No 411 on file for {name} yet.</p>
          ) : (
            <>
              {summary !== '' && (
                <p className="context__field">
                  <span className="context__field-label">411</span>
                  <span className="context__field-value">{summary}</span>
                </p>
              )}
              {extras.map(([label, value]) => (
                <p key={label} className="context__field">
                  <span className="context__field-label">{label}</span>
                  <span className="context__field-value">{value}</span>
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </li>
  );
}
