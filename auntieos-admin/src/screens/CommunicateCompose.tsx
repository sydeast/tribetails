import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  sendBroadcast,
  describeAudience,
  channelCountsOf,
  getBroadcastProgress,
  reachOf,
  stopBroadcast,
  type BroadcastCriteria,
  type BroadcastChannel,
  type BroadcastProgress,
  type SendBroadcastResult,
} from '../api/communicateWrite';
import {
  listAudienceSegments,
  saveAudienceSegment,
  deleteAudienceSegment,
  type AudienceSegment,
} from '../api/audienceSegments';
import { segmentSaveBlocker, broadcastBlocker, broadcastAudienceArgs } from '../lib/audienceSegmentEdit';
import { mintBroadcastIdempotencyKey } from '../lib/sendIdempotency';
import { channelLabel } from '../lib/communicateFormat';
import { DenPanel } from '../components/DenScreenKit';
import { MergePreview } from '../components/MergePreview';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
// The still-sending panel borrows the wait treatment's classes for its manual
// re-read. Imported rather than copied so the two cannot drift apart.
import '../components/SlowWaitNotice.css';
import './CommunicateCompose.css';

const BODY_MAX = 5000;
const SUBJECT_MAX = 200;

type AudienceKind = BroadcastCriteria['kind'];

/** Splits a comma-separated field into trimmed, non-blank entries. Pure. */
export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builds the `criteria` this screen will send, or `null` when the current
 * audience picker state doesn't yet describe a valid one (e.g. "By status"
 * chosen with no statuses typed). `null` is the honest "not ready", never a
 * fabricated `{ kind: 'all' }` fallback that would silently broaden the send.
 */
export function buildCriteria(
  kind: AudienceKind,
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
 * Communicate BROADCAST: one admin-authored message to an audience of kinfolk,
 * over any of the four channels `broadcastMessage` dispatches.
 *
 * ── WHAT THIS SLICE ADDED ───────────────────────────────────────────────────
 * Saved segments, the in-app channel, and a per-channel result table.
 *
 * `listAudienceSegments` / `saveAudienceSegment` / `deleteAudienceSegment` were
 * deployed and admin-gated the whole time; nothing on web had ever called them,
 * so the operator rebuilt the same audience by hand on every send. Picking a
 * saved segment sends `segmentId` and NO `criteria`, and ad-hoc sends `criteria`
 * and no `segmentId`. They are mutually exclusive because the server resolves
 * `segmentId` by loading the stored criteria, so sending both would ship two
 * answers to one question.
 *
 * In-app is now a channel rather than a documented omission. Like email it
 * requires a subject, which becomes the notification title in the MyTribe
 * portal feed.
 *
 * There is deliberately no KinTale channel. KinTale participates as a message
 * TYPE in Personalize, and the dispatcher has no KinTale delivery leg, so the
 * chip would be a button that cannot deliver.
 *
 * ── STILL NO PRE-SEND RECIPIENT COUNT ───────────────────────────────────────
 * The confirm step shows an audience DESCRIPTION rather than a live "N
 * recipients" figure, because no such figure exists to show honestly:
 * `broadcastMessageHandler` only computes `recipientCount` AFTER it has sent,
 * and MyTribe has no preview/count/dry-run callable anywhere. The REAL count
 * appears in the result, once it is real.
 */
export function CommunicateCompose() {
  const [segments, setSegments] = useState<AudienceSegment[]>([]);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [segmentName, setSegmentName] = useState('');
  const [segmentBusy, setSegmentBusy] = useState(false);
  const [segmentNotice, setSegmentNotice] = useState<string | null>(null);

  const [audienceKind, setAudienceKind] = useState<AudienceKind>('all');
  const [statusesRaw, setStatusesRaw] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [tagMatch, setTagMatch] = useState<'any' | 'all'>('any');
  const [inappOn, setInappOn] = useState(false);
  const [emailOn, setEmailOn] = useState(true);
  const [smsOn, setSmsOn] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SendBroadcastResult | null>(null);

  const legendId = useId();

  /**
   * #814: the key that makes pressing Send twice safe.
   *
   * Minted on the first attempt at a message and held for every retry of it,
   * the automatic one inside `call(..., { idempotent: true })` and the
   * operator's own after seeing an error. Both are the SAME send, and reusing
   * the key is what stops the second one putting a second email and a second
   * text in front of every household in the audience.
   *
   * Cleared by the effect below whenever any part of the message or its
   * audience changes: an edited broadcast is a new send, and a held key would
   * replay the first one and report success for words that never left the
   * browser.
   */
  const submissionKey = useRef<string | null>(null);
  useEffect(() => {
    submissionKey.current = null;
  }, [
    selectedSegmentId,
    audienceKind,
    statusesRaw,
    tagsRaw,
    tagMatch,
    inappOn,
    emailOn,
    smsOn,
    pushOn,
    subject,
    body,
  ]);

  const loadSegments = useCallback(() => {
    let live = true;
    listAudienceSegments()
      .then((rows) => {
        if (!live) return;
        setSegments(rows);
        setSegmentsError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // Fail loud but non-blocking: saved segments are an accelerator, and an
        // ad-hoc broadcast is still perfectly sendable without them.
        setSegmentsError(
          `listAudienceSegments failed: ${err instanceof Error ? err.message : 'Load failed'}. You can still build an audience below.`,
        );
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => loadSegments(), [loadSegments]);

  const adhocCriteria = buildCriteria(audienceKind, statusesRaw, tagsRaw, tagMatch);
  const audienceArgs = broadcastAudienceArgs(selectedSegmentId, adhocCriteria);
  const selectedSegment = segments.find((s) => s.id === selectedSegmentId);

  const channels: BroadcastChannel[] = [
    ...(inappOn ? (['inapp'] as const) : []),
    ...(emailOn ? (['email'] as const) : []),
    ...(smsOn ? (['sms'] as const) : []),
    ...(pushOn ? (['push'] as const) : []),
  ];
  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();

  // Push deliberately does NOT make the subject required, because the backend
  // does not either: it falls back to "Tribe Tails" as the notification title.
  // Adding a rule the server does not enforce would block a send the server
  // would happily accept, so this is a hint instead.
  const subjectRequired = emailOn || inappOn;
  const subjectIsPushTitle = pushOn && !subjectRequired && trimmedSubject.length === 0;
  const audienceMissing = audienceArgs === null;
  const formBlocker = broadcastBlocker(channels, subject, body);
  const formValid = !audienceMissing && formBlocker === null && trimmedBody.length <= BODY_MAX;

  function openConfirm() {
    if (!formValid || sending) return;
    setResult(null);
    setSendError(null);
    setConfirmOpen(true);
  }

  async function confirmSend() {
    if (!formValid || audienceArgs === null || sending) return;
    setSending(true);
    setSendError(null);
    submissionKey.current ??= mintBroadcastIdempotencyKey();
    try {
      const res = await sendBroadcast({
        ...audienceArgs,
        channels,
        ...(subjectRequired || trimmedSubject.length > 0 ? { subject: trimmedSubject } : {}),
        body: trimmedBody,
        idempotencyKey: submissionKey.current,
      });
      setResult(res);
      submissionKey.current = null;
      setConfirmOpen(false);
    } catch (err) {
      setSendError(`sendBroadcast failed: ${friendlySendError(err)}`);
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  }

  async function handleSaveSegment() {
    if (segmentBusy || adhocCriteria === null) return;
    setSegmentNotice(null);
    const blocker = segmentSaveBlocker(segmentName, adhocCriteria);
    if (blocker !== null) {
      setSegmentsError(blocker);
      return;
    }
    setSegmentsError(null);
    setSegmentBusy(true);
    try {
      const id = await saveAudienceSegment({ name: segmentName, criteria: adhocCriteria });
      setSegmentNotice(`Saved "${segmentName.trim()}".`);
      setSegmentName('');
      setSelectedSegmentId(id);
      loadSegments();
    } catch (err) {
      setSegmentsError(`saveAudienceSegment failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setSegmentBusy(false);
    }
  }

  async function handleDeleteSegment(segment: AudienceSegment) {
    if (segmentBusy) return;
    setSegmentNotice(null);
    setSegmentBusy(true);
    try {
      await deleteAudienceSegment(segment.id);
      setSelectedSegmentId(null);
      setSegmentNotice(`Deleted "${segment.name}".`);
      setSegmentsError(null);
      loadSegments();
    } catch (err) {
      setSegmentsError(`deleteAudienceSegment failed: ${err instanceof Error ? err.message : 'Delete failed'}`);
    } finally {
      setSegmentBusy(false);
    }
  }

  function sendAnother() {
    setResult(null);
    setSendError(null);
    setSubject('');
    setBody('');
  }

  if (result) {
    return (
      <div className="communicate__main">
        <BroadcastResultPanel result={result} channels={channels} onSendAnother={sendAnother} />
      </div>
    );
  }

  // A FRAGMENT, on purpose. `Communicate` lays this screen out as the mock's
  // two columns, and it is the grid; these three children land in it directly.
  // `.communicate__main` is the left column; `.communicate__preview` is the
  // right column's top slot, above Recent. The Dialog is `position: fixed` and
  // takes no cell.
  return (
    <>
      <div className="communicate__main">
        <DenPanel title="Compose" subtitle="Every field below is validated the same way the send itself will be.">
        <div className="compose__form">
          {sendError !== null && (
            <Banner tone="error" title="Broadcast failed">
              {sendError}
            </Banner>
          )}

          <fieldset className="compose__fieldset" aria-labelledby={`${legendId}-segment`}>
            <legend id={`${legendId}-segment`} className="compose__legend">
              Saved audience
            </legend>

            {segmentsError !== null && <Banner tone="warning">{segmentsError}</Banner>}
            {segmentNotice !== null && <Banner tone="success">{segmentNotice}</Banner>}

            <div className="compose__radio-row" role="radiogroup" aria-labelledby={`${legendId}-segment`}>
              <label className="compose__radio">
                <input
                  type="radio"
                  name="audienceSegment"
                  checked={selectedSegmentId === null}
                  disabled={sending || segmentBusy}
                  onChange={() => setSelectedSegmentId(null)}
                />
                Ad-hoc
              </label>
              {segments.map((s) => (
                <label key={s.id} className="compose__radio">
                  <input
                    type="radio"
                    name="audienceSegment"
                    checked={selectedSegmentId === s.id}
                    disabled={sending || segmentBusy}
                    onChange={() => setSelectedSegmentId(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </div>

            {selectedSegment !== undefined && (
              <>
                <p className="compose__hint">{selectedSegment.description}</p>
                <div className="compose__actions">
                  <GhostButton
                    label="Delete this segment"
                    disabled={sending || segmentBusy}
                    onClick={() => void handleDeleteSegment(selectedSegment)}
                  />
                </div>
              </>
            )}
          </fieldset>

          {selectedSegmentId === null && (
            <fieldset className="compose__fieldset" aria-labelledby={`${legendId}-audience`}>
              <legend id={`${legendId}-audience`} className="compose__legend">
                Audience
              </legend>
              <div className="compose__radio-row" role="radiogroup" aria-labelledby={`${legendId}-audience`}>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'all'}
                    disabled={sending}
                    onChange={() => setAudienceKind('all')}
                  />
                  All active kinfolk
                </label>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'status'}
                    disabled={sending}
                    onChange={() => setAudienceKind('status')}
                  />
                  By status
                </label>
                <label className="compose__radio">
                  <input
                    type="radio"
                    name="audienceKind"
                    checked={audienceKind === 'tags'}
                    disabled={sending}
                    onChange={() => setAudienceKind('tags')}
                  />
                  By tag
                </label>
              </div>

              {audienceKind === 'status' && (
                <label className="compose__field">
                  <span className="compose__field-label">Statuses (comma-separated)</span>
                  <input
                    type="text"
                    className="compose__text-input"
                    value={statusesRaw}
                    disabled={sending}
                    onChange={(e) => setStatusesRaw(e.target.value)}
                    placeholder="active, prospect"
                  />
                </label>
              )}

              {audienceKind === 'tags' && (
                <>
                  <label className="compose__field">
                    <span className="compose__field-label">Tags (comma-separated)</span>
                    <input
                      type="text"
                      className="compose__text-input"
                      value={tagsRaw}
                      disabled={sending}
                      onChange={(e) => setTagsRaw(e.target.value)}
                      placeholder="vip, newsletter"
                    />
                  </label>
                  <p className="compose__hint">
                    A broadcast matches tags on the household, not tags on individual pets. Tag matching is exact, so a
                    name spelled differently reaches nobody.
                  </p>
                  <div className="compose__radio-row" role="radiogroup" aria-label="Tag match mode">
                    <label className="compose__radio">
                      <input
                        type="radio"
                        name="tagMatch"
                        checked={tagMatch === 'any'}
                        disabled={sending}
                        onChange={() => setTagMatch('any')}
                      />
                      Any of these tags
                    </label>
                    <label className="compose__radio">
                      <input
                        type="radio"
                        name="tagMatch"
                        checked={tagMatch === 'all'}
                        disabled={sending}
                        onChange={() => setTagMatch('all')}
                      />
                      All of these tags
                    </label>
                  </div>
                </>
              )}

              <label className="compose__field">
                <span className="compose__field-label">Save this audience as</span>
                <input
                  type="text"
                  className="compose__text-input"
                  value={segmentName}
                  disabled={sending || segmentBusy}
                  onChange={(e) => setSegmentName(e.target.value)}
                  placeholder="Name to save this audience"
                />
              </label>
              <div className="compose__actions">
                <GhostButton
                  label={segmentBusy ? 'Saving…' : 'Save segment'}
                  disabled={sending || segmentBusy}
                  onClick={() => void handleSaveSegment()}
                />
              </div>
            </fieldset>
          )}

          <fieldset className="compose__fieldset" aria-labelledby={`${legendId}-channels`}>
            <legend id={`${legendId}-channels`} className="compose__legend">
              Channels
            </legend>
            <ul className="compose__toggle-list">
              <li className="compose__toggle-row">
                <span className="compose__toggle-caption">In-app</span>
                <Toggle checked={inappOn} onChange={setInappOn} disabled={sending} label="Send in-app" />
              </li>
              <li className="compose__toggle-row">
                <span className="compose__toggle-caption">Email</span>
                <Toggle checked={emailOn} onChange={setEmailOn} disabled={sending} label="Send by email" />
              </li>
              <li className="compose__toggle-row">
                <span className="compose__toggle-caption">Text (SMS)</span>
                <Toggle checked={smsOn} onChange={setSmsOn} disabled={sending} label="Send by text (SMS)" />
              </li>
              <li className="compose__toggle-row">
                <span className="compose__toggle-caption">Push</span>
                <Toggle checked={pushOn} onChange={setPushOn} disabled={sending} label="Send by push notification" />
              </li>
            </ul>
            {inappOn && (
              <p className="compose__hint">
                In-app writes a notification into the MyTribe portal feed. The subject is its title.
              </p>
            )}
            {pushOn && (
              <p className="compose__hint">
                Push reaches Kinfolk who have the app installed and notifications on. Anyone without a registered
                device is skipped, and the send report says how many.
              </p>
            )}
          </fieldset>

          <label className="compose__field">
            <span className="compose__field-label">
              Subject
              {subjectRequired
                ? ' (required for email and in-app)'
                : subjectIsPushTitle
                  ? ' (optional, push will show "Tribe Tails")'
                  : ' (optional)'}
            </span>
            <input
              type="text"
              className="compose__text-input"
              value={subject}
              disabled={sending}
              maxLength={SUBJECT_MAX}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's this about?"
            />
          </label>

          <label className="compose__field">
            <span className="compose__field-label">Message</span>
            <textarea
              className="compose__textarea"
              value={body}
              disabled={sending}
              maxLength={BODY_MAX}
              rows={8}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write the message every recipient on this audience will see."
            />
            <span className="compose__char-count">
              {body.length} / {BODY_MAX}
            </span>
          </label>

          <div className="compose__actions">
            <PrimaryButton label="Review broadcast" onClick={openConfirm} disabled={!formValid || sending} />
          </div>
        </div>

        {/*
          The preview column. `sample={{}}` is not a placeholder waiting to be
          filled in later, it is the accurate one: `broadcastMessage` calls
          `sendTemplatedEmail` with `data: {}` and hands Twilio / FCM / the
          in-app write the string verbatim, so nothing on this path can resolve
          a merge field. Every `{{token}}` an author types here IS unresolved,
          and the footnote says what each channel does with it rather than
          leaving the operator to find out from a customer.
        */}
        </DenPanel>
      </div>

      <div className="communicate__preview">
        <DenPanel title="Live preview" subtitle="How this reads once it lands, as an email.">
          <MergePreview
            subject={subject}
            body={body}
            sample={{}}
            footnote="A broadcast carries no merge data. Email sends these blank; in-app, SMS and push send the braces as typed."
          />
        </DenPanel>
      </div>

      {confirmOpen && audienceArgs !== null && (
        <Dialog
          title="Send this broadcast?"
          onClose={() => {
            if (!sending) setConfirmOpen(false);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setConfirmOpen(false)} disabled={sending} />
              <PrimaryButton
                label={sending ? 'Sending…' : 'Send now'}
                onClick={() => void confirmSend()}
                disabled={sending}
                busy={sending}
              />
            </>
          }
        >
          <p className="compose__confirm-line">
            <strong>Audience:</strong>{' '}
            {selectedSegment !== undefined
              ? `${selectedSegment.name} (${selectedSegment.description})`
              : describeAudience(adhocCriteria as BroadcastCriteria)}
          </p>
          <p className="compose__confirm-line">
            <strong>Channels:</strong> {channels.map((c) => channelLabel(c)).join(', ')}
          </p>
          {trimmedSubject.length > 0 && (
            <p className="compose__confirm-line">
              <strong>Subject:</strong> {trimmedSubject}
            </p>
          )}
          <p className="compose__confirm-line">
            <strong>Message:</strong> {trimmedBody}
          </p>
          <p className="compose__confirm-note">
            This goes out to every kinfolk this audience matches, right now. The exact number reached is reported below
            once the send completes; it isn&rsquo;t known until then.
          </p>
        </Dialog>
      )}
    </>
  );
}

/** Maps a callable rejection to a readable message, naming the two documented backend failure codes honestly. */
function friendlySendError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Send failed';
  if (message.includes('no_recipients')) return 'No kinfolk match this audience. Nothing was sent.';
  if (message.includes('broadcast_all_failed')) {
    return 'Every attempted send failed. Nothing went out, check the email/SMS provider configuration.';
  }
  return message;
}

interface BroadcastResultPanelProps {
  result: SendBroadcastResult;
  channels: BroadcastChannel[];
  onSendAnother: () => void;
}

/**
 * The panel's detail line: who the segment matched, and how many of them the
 * broadcast actually reached. A count, so it stays on screen rather than
 * going behind the info button with the explanations (#752).
 *
 * This used to read "Reached N kinfolk" off `recipientCount`, which is the
 * number the SEGMENT matched, not the number that heard anything. Since
 * #386 every recipient passes through their notification preferences first, so
 * the two numbers genuinely differ. When the response carries no `reach` at all
 * (a backend older than the field), the sentence stops claiming a reach rather
 * than reporting a fabricated one.
 */
function reachSentence(result: SendBroadcastResult): string {
  // #814: a deduped reply describes a broadcast an EARLIER attempt sent, so it
  // must not be read as this press having sent one. The pending case leaves the
  // counts out entirely: the first attempt is still fanning out and the stored
  // numbers are a snapshot, not a total.
  if (result.deduped === true && result.pending === true) {
    return 'You already sent this message, and it is still going out. Nothing went out twice.';
  }
  if (result.deduped === true) {
    return 'You already sent this message. Nothing went out twice.';
  }
  const reach = reachOf(result);
  if (!reach) return `Sent to ${result.recipientCount} kinfolk.`;
  const base = `Reached ${reach.reached} of ${reach.targeted} kinfolk.`;
  if (reach.suppressedByPrefs === 0) return base;
  const households = reach.suppressedByPrefs === 1 ? 'household has' : 'households have';
  return `${base} ${reach.suppressedByPrefs} ${households} broadcasts switched off.`;
}

/**
 * The post-send result: how far the broadcast actually got (`reachSentence`)
 * and the per-channel sent/skipped/failed tallies the callable returned.
 *
 * One row per channel rather than the archive's single joined sentence
 * ("Reached N kinfolk. email: 4 sent, 1 skipped; sms: 3 sent"), because this
 * screen lets four channels fire in one send and a sentence that long stops
 * being scannable. Only the channels actually selected are listed: the response
 * carries all four, but rendering "push: 0 sent, 0 skipped, 0 failed" for a
 * channel nobody chose reads as a failure rather than an absence.
 */
function BroadcastResultPanel({ result, channels, onSendAnother }: BroadcastResultPanelProps) {
  return (
    <DenPanel
      title={result.pending === true ? 'Broadcast sending' : 'Broadcast sent'}
      detail={reachSentence(result)}
    >
      {result.pending === true && <StillSending broadcastId={result.broadcastId} />}
      <ul className="compose__result-list">
        {channels.map((ch) => {
          const counts = channelCountsOf(result.perChannel, ch);
          return (
            <li key={ch} className="compose__result-row">
              <span className="compose__result-channel">{channelLabel(ch)}</span>
              <span className="compose__result-counts">
                {counts.sent} sent · {counts.skipped} skipped · {counts.failed} failed
              </span>
            </li>
          );
        })}
      </ul>
      <div className="compose__actions">
        <PrimaryButton label="Send another" onClick={onSendAnother} />
      </div>
    </DenPanel>
  );
}

/**
 * What a broadcast that is still going shows the operator (#823).
 *
 * `broadcastMessage` sends for fifteen seconds and hands the rest to a cron
 * sweep, because five thousand households cannot be reached inside a function's
 * 540-second ceiling. Before this, a send past about sixty households replied
 * `pending: true` and this screen printed a per-channel table that described one
 * leg of it as though it were the whole thing.
 *
 * THE NUMBERS ARE ASKED FOR, NOT PUSHED. There is no poll. The fan-out is on the
 * server, the sweep runs once a minute, and the count moves about once every
 * twenty-five seconds, so a screen that re-read every second would spend a
 * callable a second to watch a number that is standing still. This borrows the
 * treatment #819 built instead — say what is being waited on, offer a manual
 * sync — which is that ruling's own shape for a wait past ten seconds. The
 * re-read is safe to press repeatedly because it is a READ.
 *
 * STOPPING IS HONEST ABOUT WHAT IT CANNOT DO. Email and SMS already sent cannot
 * be recalled, and nothing here pretends otherwise. The button stops the
 * REMAINDER, and the confirmation says which households that leaves in numbers
 * rather than in a word.
 */
function StillSending({ broadcastId }: { broadcastId: string }) {
  const [progress, setProgress] = useState<BroadcastProgress | null>(null);
  const [checks, setChecks] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    getBroadcastProgress(broadcastId)
      .then((p) => {
        setProgress(p);
        setError(null);
      })
      .catch((err: unknown) => {
        // Left null rather than zeroed: "we could not look" and "nothing has
        // gone out" are different facts, and a progress bar cannot tell them
        // apart.
        setProgress(null);
        setError(`getBroadcastProgress failed: ${err instanceof Error ? err.message : 'Read failed'}`);
      });
  }, [broadcastId]);

  useEffect(check, [check]);

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      const res = await stopBroadcast(broadcastId);
      setStopNotice(
        `Stopping. ${res.sent} ${res.sent === 1 ? 'household has' : 'households have'} already been contacted and cannot be called back. ${res.neverSent} will not be.`,
      );
      check();
    } catch (err) {
      setError(`stopBroadcast failed: ${err instanceof Error ? err.message : 'Stop failed'}`);
    } finally {
      setStopping(false);
    }
  }

  const stalled = progress?.fanoutState === 'stalled';
  const running = progress !== null && (progress.fanoutState === 'running' || stalled);

  return (
    <div className="compose__sending">
      {error !== null && <Banner tone="error">{error}</Banner>}
      {stopNotice !== null && <Banner tone="warning">{stopNotice}</Banner>}

      {progress !== null && (
        <>
          <p className="compose__sending-line">
            {!running
              ? `Finished. ${progress.sent} of ${progress.audienceSize} households.`
              : stalled
                ? `Stopped at ${progress.sent} of ${progress.audienceSize} households. It picks up again shortly.`
                : `${progress.sent} of ${progress.audienceSize} households so far.`}
          </p>
          <progress
            className="compose__sending-bar"
            max={1}
            value={progress.audienceSize > 0 ? progress.sent / progress.audienceSize : 0}
            aria-label="Households contacted so far"
          />
        </>
      )}

      {(progress === null || running) && (
        <div className="slowWait" role="group" aria-label="This broadcast is still going out">
          <p className="slowWait__line">
            {checks === 0 ? 'This carries on in the background.' : 'Asked again. Still going.'}
          </p>
          <button
            type="button"
            className="slowWait__sync"
            onClick={() => {
              setChecks((n) => n + 1);
              check();
            }}
          >
            {checks === 0 ? 'Check again' : 'Ask again'}
          </button>
          {progress !== null && !progress.stopRequested && (
            <GhostButton
              label={stopping ? 'Stopping...' : 'Stop the rest'}
              disabled={stopping}
              onClick={() => void handleStop()}
            />
          )}
        </div>
      )}
    </div>
  );
}
