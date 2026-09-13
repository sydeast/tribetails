import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  MARKETING_KEYS,
  MARKETING_KEY_LABEL,
  blastAudienceArgs,
  cancelMarketingBlast,
  listMarketingBlasts,
  previewBlastAudience,
  scheduleBlast,
  type BlastReach,
  type MarketingBlast,
  type MarketingKey,
} from '../api/marketingBlasts';
import { listAudienceSegments, type AudienceSegment } from '../api/audienceSegments';
import { describeAudience, type BroadcastCriteria } from '../api/communicateWrite';
import {
  blastBlocker,
  cancelNotice,
  fireAtMsFrom,
  mergeFieldsToData,
  parseUidList,
  scheduleNotice,
  sendingLabel,
  type MergeFieldRow,
} from '../lib/marketingBlastEdit';
import { mintBlastIdempotencyKey } from '../lib/sendIdempotency';
import { sendTimeOf } from '../lib/communicateFormat';
import { formatWhenFull, machineWhen } from '../lib/time';
import { DenScreenHeading, DenPanel, StatusPill, EmptyHint, ErrorHint } from '../components/DenScreenKit';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { Dialog } from '../components/Dialog';
// The campaign list borrows the wait treatment's classes for the manual re-read
// it offers while a fan-out is still running. Imported here rather than copied
// into MarketingBlasts.css so the two cannot drift apart.
import '../components/SlowWaitNotice.css';
import './MarketingBlasts.css';

/**
 * Marketing blasts: SCHEDULED campaigns to kinfolk.
 *
 * Communicate's broadcast sends now; this schedules. The distinction is the
 * whole reason the screen exists separately, and it is the mock's own
 * (`ui-ideas/auntieos-marketing-blasts-2026-05-27.html`: "One-off 1:1 /
 * broadcast sends live on the Communicate screen; THIS screen is scheduled
 * campaigns").
 *
 * ── WHAT THE MOCK ASKS FOR AND WHAT LANDED ──────────────────────────────────
 * Kept: the three campaign-key chips, the three audience modes (all opted-in /
 * a saved segment / picked uids), the send-time pair that resolves to
 * `fireAtMs`, the scheduled and sent campaign lists, and Cancel on a scheduled
 * row.
 *
 * Changed, deliberately:
 *   - The mock's `audienceUids[ ]` / `data.subject` argument annotations and its
 *     "new surface" banner are mock COMMENTARY, written to show a reviewer which
 *     callable field each control feeds. They are not operator UI and are not
 *     here. Same for the two explanatory sub-lines under the screen and panel
 *     titles, which the 2026-09-11 subtitle ruling replaces with a tooltip.
 *   - "All opted-in" is labelled "All active kinfolk", the server's own
 *     `describeCriteria` wording, because that is what `{ kind: 'all' }`
 *     resolves to. Who is opted IN is not knowable from the criteria; it is what
 *     the audience preview measures, and it is shown there as a real number
 *     rather than promised in a label.
 *   - The per-campaign open rate is not here. Nothing in this codebase records
 *     an email open, so drawing one would mean inventing the number.
 *   - The mock's "Sending" group and its progress bar ARE here as of #823, and
 *     they were not before. The reason given for leaving them out, "a blast is
 *     promoted by a 5-minute cron, so there is no in-flight state to report" ,
 *     was true of the PROMOTION and never true of the fan-out. Since #823 the
 *     fan-out is an interruptible walk over a frozen roster that can span
 *     several invocations and several minutes, and the row carries exactly the
 *     mock's "256 of 410 dispatched".
 *
 * ── WHERE THE COPY COMES FROM ───────────────────────────────────────────────
 * Not from this screen. A blast names a catalog key and the pipeline renders the
 * operator's own template for it (`emailTemplates/{key}`, authored in Template
 * Bank). The merge fields below are the context that template is rendered
 * against, which is why they are free-form rows rather than a fixed
 * subject/body pair: what a blast needs is whichever `{{tokens}}` the operator
 * put in their own template.
 */

type AudienceMode = 'criteria' | 'segment' | 'uids';
type CriteriaKind = BroadcastCriteria['kind'];

/** Splits a comma-separated field into trimmed, non-blank entries. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The criteria the picker currently describes, or null when it does not
 * describe one yet. Never a `{ kind: 'all' }` fallback: on a marketing send
 * that would silently widen the audience to every household on the roster.
 */
export function buildBlastCriteria(
  kind: CriteriaKind,
  statusesRaw: string,
  tagsRaw: string,
  tagMatch: 'any' | 'all',
): BroadcastCriteria | null {
  if (kind === 'all') return { kind: 'all' };
  if (kind === 'status') {
    const statuses = splitList(statusesRaw);
    return statuses.length > 0 ? { kind: 'status', statuses } : null;
  }
  const tags = splitList(tagsRaw);
  return tags.length > 0 ? { kind: 'tags', tags, tagMatch } : null;
}

/**
 * The mock gives each group its own accent: teal for Scheduled, orange for
 * Sending, purple for Sent. #823 made the orange one real, and it comes from the
 * token the mock's `--orange` maps to rather than being re-picked by eye.
 */
function statusTone(
  status: MarketingBlast['status'],
): 'teal' | 'orange' | 'purple' | 'error' | 'muted' {
  if (status === 'scheduled') return 'teal';
  if (status === 'sending' || status === 'cancelling') return 'orange';
  if (status === 'sent') return 'purple';
  if (status === 'failed') return 'error';
  return 'muted';
}

const STATUS_LABEL: Record<MarketingBlast['status'], string> = {
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/**
 * One campaign row.
 *
 * Extracted when #823 added a third group. Scheduled and Sent were already the
 * same markup written twice, and a third copy is where the differences between
 * them start being accidental rather than meant.
 */
function CampaignRow({
  blast,
  detail,
  action,
  progress,
}: {
  blast: MarketingBlast;
  detail?: ReactNode;
  action?: ReactNode;
  /** 0..1 while the fan-out is walking the roster, or null for a campaign at rest. */
  progress?: number | null;
}) {
  return (
    <li className="blasts__row">
      <div className="blasts__row-main">
        <span className="blasts__row-name">{blast.title === '' ? blast.key : blast.title}</span>
        <span className="blasts__row-meta">
          <code className="blasts__code">{blast.key}</code> {blast.audienceDescription} &middot;{' '}
          <time dateTime={machineWhen(sendTimeOf(blast.fireAtMs))}>{fireLabel(blast.fireAtMs)}</time>
          {detail}
        </span>
        {progress !== null && progress !== undefined && (
          // A real `<progress>` rather than a painted div: it carries its value
          // to a screen reader without a second aria-label restating the
          // sentence beside it, and the viewer's reduced-motion setting is the
          // browser's business rather than this stylesheet's.
          <progress className="blasts__progress" max={1} value={progress} aria-label="Queued so far" />
        )}
      </div>
      <div className="blasts__row-side">
        <StatusPill label={STATUS_LABEL[blast.status]} tone={statusTone(blast.status)} size="compact" />
        {action}
      </div>
    </li>
  );
}

function fireLabel(ms: number): string {
  return formatWhenFull(sendTimeOf(ms)) ?? 'no send time';
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function MarketingBlasts() {
  const legendId = useId();

  const [campaignKey, setCampaignKey] = useState<MarketingKey>('newsletter.announcement');
  const [title, setTitle] = useState('');

  const [mode, setMode] = useState<AudienceMode>('criteria');
  const [criteriaKind, setCriteriaKind] = useState<CriteriaKind>('all');
  const [statusesRaw, setStatusesRaw] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [tagMatch, setTagMatch] = useState<'any' | 'all'>('any');
  const [uidsRaw, setUidsRaw] = useState('');

  const [segments, setSegments] = useState<AudienceSegment[]>([]);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

  const [mergeFields, setMergeFields] = useState<MergeFieldRow[]>([{ key: '', value: '' }]);

  const [sendDate, setSendDate] = useState('');
  const [sendTime, setSendTime] = useState('');

  const [reach, setReach] = useState<BlastReach | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [blasts, setBlasts] = useState<MarketingBlast[] | null>(null);
  const [blastsError, setBlastsError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  /**
   * How many times the operator has pressed the campaign list's manual re-read
   * while something was still queueing (#823).
   *
   * It changes the copy, and that is its whole job: #819's ruling is that a tap
   * with no visible consequence reads as a dead button, and the list may well
   * come back with the same numbers because the sweep runs once a minute.
   */
  const [refreshes, setRefreshes] = useState(0);

  const adhocCriteria = buildBlastCriteria(criteriaKind, statusesRaw, tagsRaw, tagMatch);
  const explicitUids = parseUidList(uidsRaw);
  const audience = blastAudienceArgs(selectedSegmentId, adhocCriteria, explicitUids, mode);
  const fireAtMs = fireAtMsFrom(sendDate, sendTime);
  const blocker = blastBlocker(audience, fireAtMs, Date.now(), reach?.reachable);
  const busy = scheduling || previewing;

  const loadSegments = useCallback(() => {
    listAudienceSegments()
      .then((rows) => {
        setSegments(rows);
        setSegmentsError(null);
      })
      .catch((err: unknown) => {
        // Fail loud but non-blocking: saved segments are an accelerator, and an
        // inline audience is still perfectly schedulable without them.
        setSegmentsError(
          `listAudienceSegments failed: ${errText(err, 'Load failed')}. You can still build an audience below.`,
        );
      });
  }, []);

  const loadBlasts = useCallback(() => {
    listMarketingBlasts()
      .then((rows) => {
        setBlasts(rows);
        setBlastsError(null);
      })
      .catch((err: unknown) => {
        // Left as null, never as [], so the campaign list renders its error
        // rather than the "nothing scheduled" it would otherwise be lying about.
        setBlasts(null);
        setBlastsError(`listMarketingBlasts failed: ${errText(err, 'Load failed')}`);
      });
  }, []);

  useEffect(() => {
    loadSegments();
    loadBlasts();
  }, [loadSegments, loadBlasts]);

  // A preview describes ONE audience selection. The moment the selection
  // changes, the number on screen is about something else, so it is dropped
  // rather than left to be read as current.
  useEffect(() => {
    setReach(null);
    setPreviewError(null);
  }, [mode, criteriaKind, statusesRaw, tagsRaw, tagMatch, uidsRaw, selectedSegmentId, campaignKey]);

  /**
   * #814: the key that makes pressing Schedule twice safe.
   *
   * Minted on the first attempt at a campaign and held for every retry of it,
   * the automatic one inside `call(..., { idempotent: true })` and the
   * operator's own after seeing an error. Both are the SAME submission, and
   * reusing the key is what makes the server hand back the blast the first
   * attempt created instead of queueing a second set of scheduled marketing
   * emails to real households.
   *
   * Cleared by the effect below whenever any part of the campaign changes,
   * which is the case a held key would get WRONG: a stale key would replay the
   * first attempt's campaign and report success for an edit that never left the
   * browser.
   */
  const submissionKey = useRef<string | null>(null);
  useEffect(() => {
    submissionKey.current = null;
  }, [
    campaignKey,
    title,
    mode,
    criteriaKind,
    statusesRaw,
    tagsRaw,
    tagMatch,
    uidsRaw,
    selectedSegmentId,
    mergeFields,
    sendDate,
    sendTime,
  ]);

  async function handlePreview() {
    if (audience === null || busy) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setReach(await previewBlastAudience(campaignKey, audience));
    } catch (err) {
      setReach(null);
      setPreviewError(`previewMarketingBlastAudience failed: ${errText(err, 'Preview failed')}`);
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmSchedule() {
    if (audience === null || fireAtMs === null || scheduling) return;
    setScheduling(true);
    setScheduleError(null);
    submissionKey.current ??= mintBlastIdempotencyKey();
    try {
      const res = await scheduleBlast({
        key: campaignKey,
        fireAtMs,
        audience,
        data: mergeFieldsToData(mergeFields),
        title,
        idempotencyKey: submissionKey.current,
      });
      setConfirmOpen(false);
      submissionKey.current = null;
      setNotice(scheduleNotice(res, fireLabel(fireAtMs)));
      setReach(null);
      loadBlasts();
    } catch (err) {
      setConfirmOpen(false);
      setScheduleError(`scheduleMarketingBlast failed: ${errText(err, 'Schedule failed')}`);
    } finally {
      setScheduling(false);
    }
  }

  async function handleCancel(blast: MarketingBlast) {
    if (cancellingId !== null) return;
    setCancellingId(blast.id);
    setBlastsError(null);
    setNotice(null);
    try {
      setNotice(cancelNotice(await cancelMarketingBlast(blast.id)));
      loadBlasts();
    } catch (err) {
      setBlastsError(`cancelMarketingBlast failed: ${errText(err, 'Cancel failed')}`);
    } finally {
      setCancellingId(null);
    }
  }

  function setMergeField(index: number, patch: Partial<MergeFieldRow>) {
    setMergeFields((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /**
   * The mock's three groups, and #823 is what made the middle one real: a
   * campaign whose fan-out is still walking its roster is neither scheduled nor
   * sent, and filing it under either would put a Cancel button beside something
   * half-delivered or a "Sent" pill on something still going.
   */
  const sending = blasts?.filter((b) => b.status === 'sending' || b.status === 'cancelling') ?? [];
  const scheduled = blasts?.filter((b) => b.status === 'scheduled') ?? [];
  const history = blasts?.filter(
    (b) => b.status === 'sent' || b.status === 'cancelled' || b.status === 'failed',
  ) ?? [];

  return (
    <div className="blasts">
      <DenScreenHeading
        kicker="The Den"
        title="Marketing"
        accentTail="blasts"
        subtitle="A blast is scheduled. Communicate's broadcast sends immediately."
      />

      <div className="blasts__cols">
        <div className="blasts__col">
          <DenPanel
            title="Schedule a blast"
            subtitle="The copy comes from your template for this campaign key, authored in Template Bank. The merge fields below fill its tokens."
          >
            <div className="blasts__form">
              {scheduleError !== null && (
                <Banner tone="error" title="Schedule failed">
                  {scheduleError}
                </Banner>
              )}
              {notice !== null && <Banner tone="success">{notice}</Banner>}

              <fieldset className="blasts__fieldset" aria-labelledby={`${legendId}-key`}>
                <legend id={`${legendId}-key`} className="blasts__legend">
                  Campaign
                </legend>
                <div className="blasts__radio-row" role="radiogroup" aria-labelledby={`${legendId}-key`}>
                  {MARKETING_KEYS.map((k) => (
                    <label key={k} className="blasts__radio">
                      <input
                        type="radio"
                        name="campaignKey"
                        checked={campaignKey === k}
                        disabled={busy}
                        onChange={() => setCampaignKey(k)}
                      />
                      {MARKETING_KEY_LABEL[k]}
                      <code className="blasts__code">{k}</code>
                    </label>
                  ))}
                </div>

                <label className="blasts__field">
                  <span className="blasts__field-label">Name this campaign</span>
                  <input
                    type="text"
                    className="blasts__text-input"
                    value={title}
                    disabled={busy}
                    maxLength={200}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="June newsletter"
                  />
                </label>
              </fieldset>

              <fieldset className="blasts__fieldset" aria-labelledby={`${legendId}-audience`}>
                <legend id={`${legendId}-audience`} className="blasts__legend">
                  Audience
                </legend>

                {segmentsError !== null && <Banner tone="warning">{segmentsError}</Banner>}

                <div className="blasts__radio-row" role="radiogroup" aria-labelledby={`${legendId}-audience`}>
                  <label className="blasts__radio">
                    <input
                      type="radio"
                      name="audienceMode"
                      checked={mode === 'criteria'}
                      disabled={busy}
                      onChange={() => setMode('criteria')}
                    />
                    Build a filter
                  </label>
                  <label className="blasts__radio">
                    <input
                      type="radio"
                      name="audienceMode"
                      checked={mode === 'segment'}
                      disabled={busy}
                      onChange={() => setMode('segment')}
                    />
                    A saved segment
                  </label>
                  <label className="blasts__radio">
                    <input
                      type="radio"
                      name="audienceMode"
                      checked={mode === 'uids'}
                      disabled={busy}
                      onChange={() => setMode('uids')}
                    />
                    Pick accounts
                  </label>
                </div>

                {mode === 'criteria' && (
                  <>
                    <div className="blasts__radio-row" role="radiogroup" aria-label="Filter kind">
                      <label className="blasts__radio">
                        <input
                          type="radio"
                          name="criteriaKind"
                          checked={criteriaKind === 'all'}
                          disabled={busy}
                          onChange={() => setCriteriaKind('all')}
                        />
                        All active kinfolk
                      </label>
                      <label className="blasts__radio">
                        <input
                          type="radio"
                          name="criteriaKind"
                          checked={criteriaKind === 'status'}
                          disabled={busy}
                          onChange={() => setCriteriaKind('status')}
                        />
                        By status
                      </label>
                      <label className="blasts__radio">
                        <input
                          type="radio"
                          name="criteriaKind"
                          checked={criteriaKind === 'tags'}
                          disabled={busy}
                          onChange={() => setCriteriaKind('tags')}
                        />
                        By tag
                      </label>
                    </div>

                    {criteriaKind === 'status' && (
                      <label className="blasts__field">
                        <span className="blasts__field-label">Statuses (comma-separated)</span>
                        <input
                          type="text"
                          className="blasts__text-input"
                          value={statusesRaw}
                          disabled={busy}
                          onChange={(e) => setStatusesRaw(e.target.value)}
                          placeholder="active, prospect"
                        />
                      </label>
                    )}

                    {criteriaKind === 'tags' && (
                      <>
                        <label className="blasts__field">
                          <span className="blasts__field-label">Tags (comma-separated)</span>
                          <input
                            type="text"
                            className="blasts__text-input"
                            value={tagsRaw}
                            disabled={busy}
                            onChange={(e) => setTagsRaw(e.target.value)}
                            placeholder="vip, newsletter"
                          />
                        </label>
                        <div className="blasts__radio-row" role="radiogroup" aria-label="Tag match mode">
                          <label className="blasts__radio">
                            <input
                              type="radio"
                              name="tagMatch"
                              checked={tagMatch === 'any'}
                              disabled={busy}
                              onChange={() => setTagMatch('any')}
                            />
                            Any of these tags
                          </label>
                          <label className="blasts__radio">
                            <input
                              type="radio"
                              name="tagMatch"
                              checked={tagMatch === 'all'}
                              disabled={busy}
                              onChange={() => setTagMatch('all')}
                            />
                            All of these tags
                          </label>
                        </div>
                      </>
                    )}
                  </>
                )}

                {mode === 'segment' && (
                  <div className="blasts__radio-row" role="radiogroup" aria-label="Saved segment">
                    {segments.length === 0 ? (
                      <EmptyHint>No saved segments yet. Build one on Communicate.</EmptyHint>
                    ) : (
                      segments.map((s) => (
                        <label key={s.id} className="blasts__radio">
                          <input
                            type="radio"
                            name="savedSegment"
                            checked={selectedSegmentId === s.id}
                            disabled={busy}
                            onChange={() => setSelectedSegmentId(s.id)}
                          />
                          {s.name}
                          <span className="blasts__hint">{s.description}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}

                {mode === 'uids' && (
                  <>
                    <label className="blasts__field">
                      <span className="blasts__field-label">Account ids</span>
                      <textarea
                        className="blasts__textarea"
                        rows={4}
                        value={uidsRaw}
                        disabled={busy}
                        onChange={(e) => setUidsRaw(e.target.value)}
                        placeholder="One per line, or comma-separated"
                      />
                    </label>
                    {/* Outside the label on purpose: text inside a <label>
                        joins the control's accessible name, so a running count
                        there would rename the field on every keystroke. */}
                    <p className="blasts__hint">
                      {explicitUids.length} {explicitUids.length === 1 ? 'account' : 'accounts'}
                    </p>
                  </>
                )}
              </fieldset>

              <fieldset className="blasts__fieldset" aria-labelledby={`${legendId}-merge`}>
                <legend id={`${legendId}-merge`} className="blasts__legend">
                  Merge fields
                </legend>
                {mergeFields.map((row, i) => (
                  <div className="blasts__merge-row" key={i}>
                    <input
                      type="text"
                      className="blasts__text-input"
                      value={row.key}
                      disabled={busy}
                      aria-label={`Merge field ${i + 1} name`}
                      onChange={(e) => setMergeField(i, { key: e.target.value })}
                      placeholder="token"
                    />
                    <input
                      type="text"
                      className="blasts__text-input"
                      value={row.value}
                      disabled={busy}
                      aria-label={`Merge field ${i + 1} value`}
                      onChange={(e) => setMergeField(i, { value: e.target.value })}
                      placeholder="value"
                    />
                  </div>
                ))}
                <div className="blasts__actions">
                  <GhostButton
                    label="Add a field"
                    disabled={busy}
                    onClick={() => setMergeFields((rows) => [...rows, { key: '', value: '' }])}
                  />
                </div>
              </fieldset>

              <fieldset className="blasts__fieldset" aria-labelledby={`${legendId}-when`}>
                <legend id={`${legendId}-when`} className="blasts__legend">
                  Send time
                </legend>
                <div className="blasts__when">
                  <label className="blasts__field">
                    <span className="blasts__field-label">Date</span>
                    <input
                      type="date"
                      className="blasts__text-input"
                      value={sendDate}
                      disabled={busy}
                      onChange={(e) => setSendDate(e.target.value)}
                    />
                  </label>
                  <label className="blasts__field">
                    <span className="blasts__field-label">Time</span>
                    <input
                      type="time"
                      className="blasts__text-input"
                      value={sendTime}
                      disabled={busy}
                      onChange={(e) => setSendTime(e.target.value)}
                    />
                  </label>
                </div>
                {fireAtMs !== null && <p className="blasts__hint">Fires {fireLabel(fireAtMs)}, your local time.</p>}
              </fieldset>

              <div className="blasts__actions">
                <GhostButton
                  label={previewing ? 'Checking...' : 'Check who this reaches'}
                  disabled={audience === null || busy}
                  onClick={() => void handlePreview()}
                />
                <PrimaryButton
                  label="Schedule blast"
                  disabled={blocker !== null || busy}
                  onClick={() => {
                    setScheduleError(null);
                    setNotice(null);
                    setConfirmOpen(true);
                  }}
                />
              </div>
              {blocker !== null && <p className="blasts__hint">{blocker}</p>}
            </div>
          </DenPanel>
        </div>

        <div className="blasts__col">
          <DenPanel title="Who this reaches">
            {previewError !== null && <ErrorHint>{previewError}</ErrorHint>}
            {previewError === null && reach === null && (
              <EmptyHint>Not checked yet for this audience.</EmptyHint>
            )}
            {reach !== null && (
              <dl className="blasts__reach">
                <div className="blasts__reach-row">
                  <dt>Matched</dt>
                  <dd>{reach.matched}</dd>
                </div>
                <div className="blasts__reach-row">
                  <dt>No linked account</dt>
                  <dd>{reach.noLinkedAccount}</dd>
                </div>
                <div className="blasts__reach-row">
                  <dt>Opted out or gated</dt>
                  <dd>{reach.suppressedByPrefs}</dd>
                </div>
                <div className="blasts__reach-row blasts__reach-row--total">
                  <dt>Will receive it</dt>
                  <dd>{reach.reachable}</dd>
                </div>
              </dl>
            )}
          </DenPanel>

          <DenPanel title="Campaigns">
            {blastsError !== null && <ErrorHint>{blastsError}</ErrorHint>}
            {blastsError === null && blasts === null && <EmptyHint>Loading campaigns...</EmptyHint>}
            {blasts !== null && (
              <>
                {sending.length > 0 && (
                  <>
                    <h3 className="blasts__listhead">Sending</h3>
                    <ul className="blasts__list">
                      {sending.map((b) => (
                        <CampaignRow
                          key={b.id}
                          blast={b}
                          progress={b.audienceSize > 0 ? b.queued / b.audienceSize : 0}
                          detail={
                            <>
                              {' '}
                              &middot; {sendingLabel(b.queued, b.audienceSize, b.fanoutState === 'stalled')}
                            </>
                          }
                          action={
                            // Cancel stays available MID fan-out, which is the
                            // whole point: the un-queued remainder is real and
                            // stoppable. A campaign already stopping has nothing
                            // left to offer, so it gets no button rather than a
                            // disabled one.
                            b.status === 'cancelling' ? undefined : (
                              <GhostButton
                                label={cancellingId === b.id ? 'Stopping...' : 'Stop sending'}
                                disabled={cancellingId !== null}
                                onClick={() => void handleCancel(b)}
                              />
                            )
                          }
                        />
                      ))}
                    </ul>
                    {/* Borrows the wait treatment #819 built rather than
                        inventing a second progress language: a long wait with a
                        number that only moves when the server says so is exactly
                        the shape that ruling is about, and the offer is a manual
                        re-read. Safe to press repeatedly: it points at a READ. */}
                    <div className="slowWait" role="group" aria-label="A campaign is still being queued">
                      <p className="slowWait__line">
                        {refreshes === 0
                          ? 'This carries on in the background.'
                          : 'Asked again. Still queueing.'}
                      </p>
                      <button
                        type="button"
                        className="slowWait__sync"
                        onClick={() => {
                          setRefreshes((n) => n + 1);
                          loadBlasts();
                        }}
                      >
                        {refreshes === 0 ? 'Check again' : 'Ask again'}
                      </button>
                    </div>
                  </>
                )}

                <h3 className="blasts__listhead">Scheduled</h3>
                {scheduled.length === 0 ? (
                  <EmptyHint>Nothing scheduled.</EmptyHint>
                ) : (
                  <ul className="blasts__list">
                    {scheduled.map((b) => (
                      <CampaignRow
                        key={b.id}
                        blast={b}
                        action={
                          <GhostButton
                            label={cancellingId === b.id ? 'Cancelling...' : 'Cancel'}
                            disabled={cancellingId !== null}
                            onClick={() => void handleCancel(b)}
                          />
                        }
                      />
                    ))}
                  </ul>
                )}

                <h3 className="blasts__listhead">Sent and cancelled</h3>
                {history.length === 0 ? (
                  <EmptyHint>Nothing sent yet.</EmptyHint>
                ) : (
                  <ul className="blasts__list">
                    {history.map((b) => (
                      <CampaignRow
                        key={b.id}
                        blast={b}
                        detail={
                          b.status === 'failed' && b.dispatched === 0 ? (
                            // Not a count: a campaign whose fan-out never armed
                            // queued nothing, and "0 sent, 0 suppressed" would
                            // read as a send that reached nobody rather than as
                            // one that never started.
                            <> &middot; never queued</>
                          ) : (
                            <>
                              {' '}
                              &middot; {b.dispatched} sent, {b.suppressed} suppressed
                              {/* A failed campaign that DID queue copies is a
                                  send stopped part-way, not one that never
                                  started, and it is the population #823 was
                                  filed about: a row the old build left at
                                  'running' with real counts on it and no roster
                                  to resume from. "never queued" over sixty sent
                                  copies would be the confident wrong number. */}
                              {b.status === 'failed' ? ', stopped part-way' : null}
                            </>
                          )
                        }
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </DenPanel>
        </div>
      </div>

      {/* Mounted rather than toggled: Dialog traps focus and restores it on
          unmount, so a hidden-but-mounted one would hold the page's focus. */}
      {confirmOpen && (
      <Dialog
        title="Schedule this blast"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <GhostButton label="Back" disabled={scheduling} onClick={() => setConfirmOpen(false)} />
            <PrimaryButton
              label={scheduling ? 'Scheduling...' : 'Schedule it'}
              disabled={scheduling}
              onClick={() => void confirmSchedule()}
            />
          </>
        }
      >
        <p>
          {MARKETING_KEY_LABEL[campaignKey]} to{' '}
          {mode === 'uids'
            ? `${explicitUids.length} chosen ${explicitUids.length === 1 ? 'account' : 'accounts'}`
            : mode === 'segment'
              ? (segments.find((s) => s.id === selectedSegmentId)?.description ?? 'a saved segment')
              : adhocCriteria !== null
                ? describeAudience(adhocCriteria)
                : ''}
          , firing {fireAtMs === null ? 'at no time yet' : fireLabel(fireAtMs)}.
        </p>
        {reach !== null && <p>{reach.reachable} of {reach.matched} will receive it.</p>}
      </Dialog>
      )}
    </div>
  );
}
