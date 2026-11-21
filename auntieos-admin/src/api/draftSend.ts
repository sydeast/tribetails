import { call } from '../lib/fns';
import { logActivity } from './activityLog';
import { ACTIVITY_WORDS } from '../lib/activityWords';

/**
 * #2428: approving a Communicate Email or Text draft, which sends it, through
 * the `sendGeneratedDraft` callable
 * (`mytribe/functions/src/admin/sendGeneratedDraft.ts`). Android and the
 * desktop console call the same one.
 *
 * WHY A CALLABLE AND NOT THE OLD TWO STEPS. This screen used to approve the
 * draft with its own write and then call `sendExternalMessage`, which takes an
 * address and some words and has never heard of the draft. Nothing recorded
 * that the draft went out, so it opened again as "needs approval" and a second
 * approve sent the household the same message twice. The server now does both
 * in one call: it claims the draft before the provider is called, stamps it
 * afterwards, and answers a repeat with `already_sent`.
 *
 * There is no address in the request. The server reads the household's own.
 */

export type DraftSendOutcome = 'sent' | 'already_sent';

export interface SendGeneratedDraftArgs {
  /** The bare `generated_drafts` doc id. */
  draftId: string;
  /** The household the operator confirmed. The server refuses a draft written for another. */
  kinfolkId: string;
  /** The operator's final text, edits included. */
  body: string;
  /** The Email's subject. Left out for a Text. */
  subject?: string;
}

export interface SendGeneratedDraftResult {
  /** `already_sent`: it went out before, or may have. Nothing new was sent. */
  outcome: DraftSendOutcome;
  /** The audit failure's own message when the entry could not be written, else null. */
  auditWarning: string | null;
}

const DRAFTS_COLLECTION = 'generated_drafts';

/**
 * One send per draft at a time, decided here and not by the screen's `busy`
 * state: that is React state, so two taps in one frame both read it false. A
 * second call for a draft whose send is still running gets the first call's
 * promise, so it makes no second request and both callers see the same answer.
 * The server's claim on the draft is the guarantee; this is what keeps a second
 * tap from being answered with a refusal the operator would read as a failure.
 */
const inFlight = new Map<string, Promise<SendGeneratedDraftResult>>();

export function sendGeneratedDraft(args: SendGeneratedDraftArgs): Promise<SendGeneratedDraftResult> {
  const draftId = args.draftId.trim();
  if (draftId === '') {
    return Promise.reject(
      new Error('This draft was not saved, so there is nothing to approve. Regenerate and try again.'),
    );
  }
  const running = inFlight.get(draftId);
  if (running) return running;
  const started = send({ ...args, draftId }).finally(() => {
    inFlight.delete(draftId);
  });
  inFlight.set(draftId, started);
  return started;
}

async function send(args: SendGeneratedDraftArgs): Promise<SendGeneratedDraftResult> {
  const subject = (args.subject ?? '').trim();
  const res = await call<
    { draftId: string; kinfolkId: string; body: string; subject?: string },
    { ok: true; outcome?: unknown }
  >(
    'sendGeneratedDraft',
    {
      draftId: args.draftId,
      kinfolkId: args.kinfolkId,
      body: args.body.trim(),
      ...(subject !== '' ? { subject } : {}),
    },
    // Safe to retry: the server answers a repeat from the draft's own stamp.
    { idempotent: true },
  );
  // Only the literal word claims a send. Any other answer means the call was
  // taken and this draft will not go out again, which is what `already_sent` says.
  if (res.outcome !== 'sent') return { outcome: 'already_sent', auditWarning: null };

  // The Activity Log entry, after the send and never before it: an entry
  // written first would say a draft was approved that the provider then
  // refused. Through the callable, so it joins the hash chain. Non-fatal: the
  // message is out, and a failure here is reported beside that, not instead.
  let auditWarning: string | null = null;
  try {
    await logActivity({
      actionType: 'DRAFT_APPROVED',
      description: ACTIVITY_WORDS.draftApproved,
      status: 'SUCCESS',
      targetId: args.draftId,
      targetCollection: DRAFTS_COLLECTION,
      ...(args.kinfolkId !== '' ? { familyId: args.kinfolkId } : {}),
      payload: { draftId: args.draftId },
    });
  } catch (err) {
    auditWarning = err instanceof Error ? err.message : 'The audit entry could not be written.';
  }
  return { outcome: 'sent', auditWarning };
}
