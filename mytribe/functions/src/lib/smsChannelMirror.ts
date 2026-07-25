import { db } from './firestoreAdmin';

/**
 * Mirrors an outbound operator reply into `sms_messages` so the Inbox Channels
 * thread reads as a conversation instead of one-sided.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY DECISION, MADE DELIBERATELY (do not loosen this without redoing it)
 * ---------------------------------------------------------------------------
 * `sendExternalMessage` REDACTS the recipient everywhere it writes. Both the
 * `activity_log` audit entry AND the `external_messages` send record store only
 * `recipientRedacted`, so a plaintext one-off contact never lands in long-lived
 * storage. That posture is the whole reason this mirror was not smuggled into
 * Task 6.1: an `sms_messages` row carries `counterpartNumber` in the CLEAR.
 *
 * The resolution is not "trust the caller". A boolean flag alone would only move
 * the decision to whoever calls the function, and `ExternalSendPanel` reaches the
 * same callable to text people who are not kinfolk at all. So the flag means
 * "mirror IF this is already a known channel counterpart", and the SERVER decides
 * whether that is true.
 *
 * We mirror only when `sms_messages` ALREADY holds a row for that number, written
 * by the signature-verified Twilio inbound webhook. In that case the plaintext
 * number is already in the collection, put there by the person texting us first,
 * and the mirror adds no contact that was not stored anyway. Where no such row
 * exists, the number is a genuinely new contact, the redaction posture applies in
 * full, and we write nothing and say so.
 *
 * Net effect: a one-off text to a stranger can never be smuggled into
 * `sms_messages` by passing a flag, and the audit trail's redaction is untouched.
 * `activity_log` and `external_messages` still see only the masked recipient.
 * ---------------------------------------------------------------------------
 */

export const SMS_COLLECTION = 'sms_messages';

/**
 * Why a mirror did not happen. Returned to the caller so the operator's success
 * banner can say where the reply went, rather than the UI guessing. Clients
 * branch on these codes, never on message text.
 */
export const MIRROR_SKIPPED = {
  /** Caller did not ask. The default, and what every non-Inbox send does. */
  NOT_REQUESTED: 'not_requested',
  /** No prior inbound row for this number, so the privacy rule above refuses. */
  NO_EXISTING_THREAD: 'no_existing_thread',
  /** The send succeeded and only the mirror write failed. Never fails the call. */
  WRITE_FAILED: 'write_failed',
} as const;

export type MirrorSkippedReason = (typeof MIRROR_SKIPPED)[keyof typeof MIRROR_SKIPPED];

/** The parts of an existing thread row an outbound mirror inherits. */
export interface ExistingThread {
  kinfolkId: string | null;
  kinfolkName: string;
  threadId: string;
}

/**
 * Is this number already a known channel counterpart?
 *
 * One indexed equality on `counterpartNumber`, limit 1. `counterpartNumber` is
 * stored raw as Twilio delivered it, and we query with the E.164 value
 * `normalizeRecipient` produced, which is the same shape Twilio's `From` carries.
 * A number stored in some other shape simply does not match, and a miss is the
 * SAFE outcome here: it means "no mirror", never "mirror with a fresh plaintext
 * contact".
 *
 * Returns the newest matching row's kinfolk linkage so the mirror inherits it
 * rather than re-running a match the reconcile pipeline has already made
 * authoritatively.
 */
export async function findExistingThread(counterpartNumber: string): Promise<ExistingThread | null> {
  const snap = await db()
    .collection(SMS_COLLECTION)
    .where('counterpartNumber', '==', counterpartNumber)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) return null;

  const data = doc.data() as Record<string, unknown>;
  const kinfolkId = typeof data.kinfolkId === 'string' && data.kinfolkId !== '' ? data.kinfolkId : null;
  return {
    kinfolkId,
    kinfolkName: typeof data.kinfolkName === 'string' ? data.kinfolkName : '',
    threadId: typeof data.threadId === 'string' ? data.threadId : '',
  };
}

/**
 * `reconcile_comms.py` claims every row with `reconcileStatus == 'pending'` and
 * runs an LLM pass to fold it into the kinfolk dossier. It already understands
 * `direction`, and it matches sms rows on `counterpartNumber` in either
 * direction, so an outbound row is safe to hand it.
 *
 * We hand it one only when it has work to do. A row that inherited a kinfolk
 * link from the thread is ALREADY linked, so 'pending' would spend an LLM call
 * re-deriving a fact we copied. An unlinked row gets 'pending' so the pipeline
 * can match it by phone exactly like any inbound row, rather than being stranded
 * outside the dossier forever.
 */
export function resolveReconcileStatus(kinfolkId: string | null): 'pending' | 'skipped' {
  return kinfolkId ? 'skipped' : 'pending';
}

export interface OutboundMirrorInput {
  counterpartNumber: string;
  body: string;
  providerMessageId: string;
  actorUid: string;
  thread: ExistingThread;
  nowIso: string;
}

/**
 * The mirror row. Field-for-field the schema `twilioInboundSms` writes, because
 * the Inbox readers, Android's `observeSmsMessages` and the python reconcile
 * pipeline all parse that one shape and none of them should need to learn a
 * second. Only `direction`, `status` and the provenance keys differ.
 *
 * `timestamp` is an ISO STRING, not a Timestamp. Every writer of these four
 * collections stamps `new Date().toISOString()`, the readers range-query it
 * lexically, and Firestore orders every Timestamp after every string, so a
 * Timestamp here would sort the operator's own replies away from the thread
 * they belong to and would not error while doing it.
 */
export function buildOutboundMirrorDoc(input: OutboundMirrorInput): Record<string, unknown> {
  const kinfolkId = input.thread.kinfolkId;
  return {
    counterpartNumber: input.counterpartNumber,
    direction: 'outbound',
    subType: 'sms',
    body: input.body,
    mediaUrls: [],
    timestamp: input.nowIso,
    status: 'sent',
    twilioMessageSid: input.providerMessageId,
    kinfolkId,
    kinfolkName: input.thread.kinfolkName,
    threadId: input.thread.threadId,
    reconcileStatus: resolveReconcileStatus(kinfolkId),
    reconciledAt: '',
    reconcileNotes: kinfolkId
      ? 'Outbound mirror of an operator reply; kinfolk link inherited from the existing thread.'
      : '',
    // Provenance. Nothing else writes an outbound row into this collection, so a
    // reader that needs to tell an operator reply from a carrier record can, and
    // an unexpected row can be traced to the admin who caused it. actorUid is an
    // internal admin uid, not a contact detail.
    mirroredFrom: 'sendExternalMessage',
    actorUid: input.actorUid,
  };
}

/**
 * Writes the mirror row, keyed by the Twilio message SID exactly as the inbound
 * webhook keys its own, so a retry of the same send upserts one row rather than
 * duplicating the reply in the operator's thread.
 */
export async function writeOutboundMirror(input: OutboundMirrorInput): Promise<void> {
  await db()
    .collection(SMS_COLLECTION)
    .doc(input.providerMessageId)
    .set(buildOutboundMirrorDoc(input), { merge: true });
}
