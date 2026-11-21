import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #2428: a Communicate Email or Text draft that already went out opened again
 * as "needs approval", and approving it again sent the household the same
 * message a second time. Nothing on the draft said it had gone, and the server
 * was never told there was a draft. `sendGeneratedDraft` is the one send: it
 * claims the draft, sends, and stamps it.
 */

const DELETE = '__DELETE__';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  twilioCreate: vi.fn(),
  getTwilio: vi.fn(),
  getTwilioFromNumber: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: mocks.getTwilio,
  getTwilioFromNumber: mocks.getTwilioFromNumber,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import {
  sendGeneratedDraftHandler,
  nothingWentOut,
  DRAFT_SEND_LEASE_MS,
  DRAFT_SEND_IN_FLIGHT,
  DRAFT_SEND_UNCONFIRMED,
  DRAFT_SEND_UNCONFIRMED_MESSAGE,
} from '../src/admin/sendGeneratedDraft';
import { deleteGeneratedDraftHandler } from '../src/admin/kinTaleDrafts';
import { draftSendState, draftWentOut, draftMessageChannel } from '../src/lib/generatedDraftType';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { SMTP2GO_NO_VERDICT_MESSAGE } from '../src/lib/providerFailure';

const auditMock = writeAuditEntry as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('smtp-1');
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SM123' });
  mocks.getTwilio.mockReset().mockReturnValue({ messages: { create: mocks.twilioCreate } });
  mocks.getTwilioFromNumber.mockReset().mockReturnValue('+15550000000');
  auditMock.mockClear();
});

const owner = (data: unknown) => callableRequest(data, { uid: 'owner-1', token: { admin: true } });

/** A generate.js Email draft: snake_case, `generated`. */
const EMAIL_DRAFT = {
  status: 'generated',
  communication_type: 'email',
  kinfolk_id: 'kf-robyn',
  kinfolk_name: 'Robyn',
  generated_copy: 'Biscuit is booked for Friday.',
  generated_title: 'Friday',
  createdOn: '2026-11-18T10:00:00.000Z',
};
/** A migrated Text draft: camelCase, `pending`. */
const TEXT_DRAFT = {
  status: 'pending',
  communicationType: 'sms',
  kinfolkId: 'kf-robyn',
  kinfolkName: 'Robyn',
  generatedCopy: 'See you Friday.',
  createdOn: '2026-05-23T10:00:00.000Z',
};
const HOUSEHOLD = {
  'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale', email: 'catch@hanasamku.com', phoneNumber: '(415) 555-2671' },
};

type Docs = Record<string, Record<string, unknown> | null>;

/**
 * A write-through fake whose `update` drops a field set to `FieldValue.delete()`,
 * the way Firestore does, so "the claim is let go" is read off the stored draft.
 */
function db(docs: Docs) {
  const ctx = buildDbMock({ docs, writeThrough: true });
  const realRun = ctx.db.runTransaction;
  ctx.db.runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await realRun(fn);
    for (const data of Object.values(docs)) {
      if (!data) continue;
      for (const [k, v] of Object.entries(data)) if (v === DELETE) delete data[k];
    }
    return result;
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

const emailArgs = { draftId: 'd1', kinfolkId: 'kf-robyn', body: 'Biscuit is booked for Friday at 9.', subject: 'Friday' };
const textArgs = { draftId: 'd2', kinfolkId: 'kf-robyn', body: 'See you Friday at 9.' };

describe('draftSendState / draftWentOut', () => {
  it('reads an Email or Text draft as unsent, sending, approved or sent', () => {
    expect(draftSendState({ status: 'generated' })).toBe('unsent');
    expect(draftSendState({ status: 'pending' })).toBe('unsent');
    expect(draftSendState({})).toBe('unsent');
    expect(draftSendState({ status: 'approved' })).toBe('approved');
    expect(draftSendState({ status: ' Approved ' })).toBe('approved');
    expect(draftSendState({ status: 'approved', sendClaimedAt: '2026-11-20T10:00:00.000Z' })).toBe('sending');
    expect(draftSendState({ status: 'approved', sentAt: '2026-11-20T10:00:01.000Z' })).toBe('sent');
    // A claim let go after a refused send leaves the draft unsent.
    expect(draftSendState({ status: 'generated', sendFailedAt: '2026-11-20T10:00:01.000Z' })).toBe('unsent');
  });

  it('names the channel only when every spelling of the type agrees', () => {
    expect(draftMessageChannel({ communication_type: 'email' })).toBe('email');
    expect(draftMessageChannel({ communicationType: 'sms' })).toBe('sms');
    expect(draftMessageChannel({ communication_type: 'email', communicationType: 'sms' })).toBeNull();
    expect(draftMessageChannel({ communication_type: 'push' })).toBeNull();
    expect(draftMessageChannel({ communication_type: 'Email' })).toBeNull();
    expect(draftMessageChannel({})).toBeNull();
  });

  it('a draft a household was sent, or may have been, went out', () => {
    expect(draftWentOut({ communication_type: 'visit_report', publishedReportId: 'r1' })).toBe(true);
    expect(draftWentOut({ communication_type: 'email', status: 'approved' })).toBe(true);
    expect(draftWentOut({ communicationType: 'sms', status: 'approved', sentAt: '2026-11-20T10:00:01.000Z' })).toBe(true);
    expect(draftWentOut({ communication_type: 'sms', status: 'approved', sendClaimedAt: '2026-11-20T10:00:00.000Z' })).toBe(true);
    expect(draftWentOut({ communication_type: 'push', status: 'approved', pushOutcome: 'sent' })).toBe(true);
    expect(draftWentOut({ communication_type: 'push', status: 'approved', pushOutcome: 'listed' })).toBe(true);
  });

  it('a draft that reached nobody did not', () => {
    expect(draftWentOut({ communication_type: 'email', status: 'generated' })).toBe(false);
    expect(draftWentOut({ communication_type: 'sms', status: 'pending' })).toBe(false);
    // A held Push, and one whose send never answered (#2381), reached nobody.
    expect(draftWentOut({ communication_type: 'push', status: 'approved', pushOutcome: 'held' })).toBe(false);
    expect(draftWentOut({ communication_type: 'push', status: 'approved' })).toBe(false);
    // Approving a Social, Blog or General draft sends nothing.
    expect(draftWentOut({ communication_type: 'social_post', status: 'approved' })).toBe(false);
    expect(draftWentOut({ communication_type: 'visit_report', status: 'generated' })).toBe(false);
  });
});

describe('sendGeneratedDraft: the one send', () => {
  it('sends an Email draft to the address on the household, and stamps the draft sent', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });

    const res = await sendGeneratedDraftHandler(owner(emailArgs));

    expect(res).toMatchObject({ ok: true, outcome: 'sent', channel: 'email', recipientRedacted: 'c***@hanasamku.com' });
    expect(res.sentAt > '').toBe(true);
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTemplatedEmail.mock.calls[0]![0]).toMatchObject({
      to: 'catch@hanasamku.com',
      subjectTemplate: 'Friday',
      // One named household: no unsubscribe footer, exactly as each client sent it before.
      bodyTemplate: 'Biscuit is booked for Friday at 9.',
    });
    expect(mocks.twilioCreate).not.toHaveBeenCalled();

    const draft = docs['generated_drafts/d1']!;
    expect(draft).toMatchObject({
      status: 'approved',
      generatedCopy: 'Biscuit is booked for Friday at 9.',
      subject: 'Friday',
      approvedBy: 'owner-1',
      sentAt: res.sentAt,
      sentChannel: 'email',
      sentTo: 'c***@hanasamku.com',
      sentProviderMessageId: 'smtp-1',
    });
    // The claim is let go with the stamp.
    expect(draft).not.toHaveProperty('sendClaimedAt');
    expect(draftSendState(draft)).toBe('sent');
    // The address is never stored on the draft in the clear.
    expect(JSON.stringify(draft)).not.toContain('catch@hanasamku.com');

    // Recorded like every other operator send, naming the draft.
    expect(ctx.adds.find((a) => a.collection === 'external_messages')?.data).toMatchObject({
      channel: 'email',
      transactional: true,
      providerMessageId: 'smtp-1',
    });
    expect(auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>).find((a) => a['event'] === 'EXTERNAL_MESSAGE_SENT')).toMatchObject({
      payload: { draftId: 'd1', kinfolkId: 'kf-robyn', channel: 'email' },
    });
  });

  it('sends a Text draft to the phone number on the household', async () => {
    const { docs } = db({ 'generated_drafts/d2': { ...TEXT_DRAFT }, ...HOUSEHOLD });

    const res = await sendGeneratedDraftHandler(owner(textArgs));

    expect(res).toMatchObject({ outcome: 'sent', channel: 'sms', recipientRedacted: '+1******2671' });
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
    expect(mocks.twilioCreate.mock.calls[0]![0]).toMatchObject({ to: '+14155552671', body: 'See you Friday at 9.' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(docs['generated_drafts/d2']).toMatchObject({ status: 'approved', sentChannel: 'sms', sentProviderMessageId: 'SM123' });
  });

  it('the claim is on the draft before the provider is called', async () => {
    const { docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    let atSend: Record<string, unknown> = {};
    mocks.sendTemplatedEmail.mockImplementation(async () => {
      atSend = { ...docs['generated_drafts/d1']! };
      return 'smtp-1';
    });

    await sendGeneratedDraftHandler(owner(emailArgs));

    expect(atSend['status']).toBe('approved');
    expect(String(atSend['sendClaimedAt']) > '').toBe(true);
    expect(atSend['sentAt']).toBeUndefined();
    expect(draftSendState(atSend)).toBe('sending');
  });
});

describe('sendGeneratedDraft: once per draft', () => {
  it('a second call for a draft that went out sends nothing and says it already went', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    const first = await sendGeneratedDraftHandler(owner(emailArgs));
    // An older client, or a direct call, sending the same draft again with new words.
    const second = await sendGeneratedDraftHandler(owner({ ...emailArgs, body: 'Different words.' }));

    expect(second).toEqual({
      ok: true,
      outcome: 'already_sent',
      channel: 'email',
      recipientRedacted: 'c***@hanasamku.com',
      sentAt: first.sentAt,
    });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(ctx.adds.filter((a) => a.collection === 'external_messages')).toHaveLength(1);
  });

  it('the words that went out stay on the draft after a second call', async () => {
    const { docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    await sendGeneratedDraftHandler(owner(emailArgs));
    await sendGeneratedDraftHandler(owner({ ...emailArgs, body: 'Different words.', subject: 'Changed' }));
    expect(docs['generated_drafts/d1']).toMatchObject({ generatedCopy: 'Biscuit is booked for Friday at 9.', subject: 'Friday' });
  });

  it('a second tap while the first is still sending is refused and sends nothing', async () => {
    db({ 'generated_drafts/d2': { ...TEXT_DRAFT }, ...HOUSEHOLD });
    let letGo: (v: { sid: string }) => void = () => undefined;
    mocks.twilioCreate.mockImplementation(() => new Promise((resolve) => (letGo = resolve)));

    const first = sendGeneratedDraftHandler(owner(textArgs));
    await vi.waitFor(() => expect(mocks.twilioCreate).toHaveBeenCalledTimes(1));
    await expect(sendGeneratedDraftHandler(owner(textArgs))).rejects.toMatchObject({
      code: 'aborted',
      details: { code: DRAFT_SEND_IN_FLIGHT },
    });
    letGo({ sid: 'SM123' });

    expect(await first).toMatchObject({ outcome: 'sent' });
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
  });

  it('an approved draft with no stamp was sent by an older client: nothing is sent', async () => {
    const { docs } = db({
      'generated_drafts/d1': { ...EMAIL_DRAFT, status: 'approved', generatedCopy: 'Old words.', approvedAt: '2026-11-01T10:00:00.000Z' },
      ...HOUSEHOLD,
    });
    const res = await sendGeneratedDraftHandler(owner(emailArgs));
    expect(res).toEqual({ ok: true, outcome: 'already_sent', channel: 'email', recipientRedacted: '', sentAt: '' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(docs['generated_drafts/d1']).toMatchObject({ generatedCopy: 'Old words.', approvedAt: '2026-11-01T10:00:00.000Z' });
  });

  it('a claim left by a call that died is never tried again, and is not called sent either', async () => {
    const stale = new Date(Date.now() - DRAFT_SEND_LEASE_MS - 1000).toISOString();
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT, status: 'approved', sendClaimedAt: stale }, ...HOUSEHOLD });
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: DRAFT_SEND_UNCONFIRMED_MESSAGE,
      details: { code: DRAFT_SEND_UNCONFIRMED },
    });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('a live claim reads as being sent right now', async () => {
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT, status: 'approved', sendClaimedAt: new Date().toISOString() }, ...HOUSEHOLD });
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({
      code: 'aborted',
      message: 'This message is being sent right now.',
    });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
});

describe('sendGeneratedDraft: when the provider says no', () => {
  it('lets the claim go, so the draft is unsent again and the next send goes out once', async () => {
    const { docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(Object.assign(new Error('smtp2go is down'), { status: 503 }));

    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ code: 'unavailable' });

    const after = docs['generated_drafts/d1']!;
    expect(after['status']).toBe('generated');
    expect(after).not.toHaveProperty('sendClaimedAt');
    expect(after).not.toHaveProperty('approvedAt');
    expect(after).not.toHaveProperty('approvedBy');
    expect(after).not.toHaveProperty('sentAt');
    expect(draftSendState(after)).toBe('unsent');
    expect(draftWentOut(after)).toBe(false);

    const retry = await sendGeneratedDraftHandler(owner(emailArgs));
    expect(retry.outcome).toBe('sent');
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(2);
    expect(docs['generated_drafts/d1']).not.toHaveProperty('sendFailedAt');
  });

  it('a hard-bounced address is refused before the provider, and the draft is unsent again', async () => {
    const { docs } = db({
      'generated_drafts/d1': { ...EMAIL_DRAFT },
      ...HOUSEHOLD,
      'message_suppressions/catch%40hanasamku.com': { reason: 'hard_bounce' },
    });
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(draftSendState(docs['generated_drafts/d1']!)).toBe('unsent');
  });

  it('a draft that had no status goes back to having none', async () => {
    const { status: _dropped, ...noStatus } = EMAIL_DRAFT;
    const { docs } = db({ 'generated_drafts/d1': { ...noStatus }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(new Error('refused'));
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ code: 'unavailable' });
    expect(docs['generated_drafts/d1']).not.toHaveProperty('status');
  });

  it('a connection that was never made sent nothing, so the draft is unsent again', async () => {
    const { docs } = db({ 'generated_drafts/d2': { ...TEXT_DRAFT }, ...HOUSEHOLD });
    mocks.twilioCreate.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(sendGeneratedDraftHandler(owner(textArgs))).rejects.toMatchObject({ code: 'unavailable' });
    expect(draftSendState(docs['generated_drafts/d2']!)).toBe('unsent');
    expect(docs['generated_drafts/d2']!['status']).toBe('pending');
  });
});

describe('sendGeneratedDraft: when the send gets no answer', () => {
  /** What `lib/email.ts` throws when the request left and no answer came back in time. */
  const headersTimeout = () =>
    Object.assign(new Error('smtp2go send timed out (code UND_ERR_HEADERS_TIMEOUT): fetch failed'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });

  it('keeps the claim, marks the draft unconfirmed and says what is and is not known', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(headersTimeout());

    const err = await sendGeneratedDraftHandler(owner(emailArgs)).catch((e: unknown) => e as { code: string; message: string });

    expect(err).toMatchObject({
      code: 'failed-precondition',
      message: DRAFT_SEND_UNCONFIRMED_MESSAGE,
      details: { code: DRAFT_SEND_UNCONFIRMED },
    });
    // It says neither "sent" nor "failed", and never the provider's own words.
    expect((err as { message: string }).message).not.toMatch(/smtp2go|UND_ERR|timed out|failed/i);
    const after = docs['generated_drafts/d1']!;
    expect(after['status']).toBe('approved');
    expect(String(after['sendClaimedAt']) > '').toBe(true);
    expect(String(after['sendUnconfirmedAt']) > '').toBe(true);
    expect(after).not.toHaveProperty('sentAt');
    expect(draftSendState(after)).toBe('sending');
    expect(draftWentOut(after)).toBe(true);
    // No send record is written for a send nobody can vouch for.
    expect(ctx.adds.filter((a) => a.collection === 'external_messages')).toHaveLength(0);
  });

  it('every later call for that draft is refused the same way, at once, and sends nothing', async () => {
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(headersTimeout());
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ details: { code: DRAFT_SEND_UNCONFIRMED } });

    // Seconds later, inside the lease: told the same thing, not "being sent right now".
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: DRAFT_SEND_UNCONFIRMED },
    });
    await expect(sendGeneratedDraftHandler(owner({ ...emailArgs, body: 'Different words.' }))).rejects.toMatchObject({
      details: { code: DRAFT_SEND_UNCONFIRMED },
    });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
  });

  it('a Text whose provider call timed out is held the same way', async () => {
    const { docs } = db({ 'generated_drafts/d2': { ...TEXT_DRAFT }, ...HOUSEHOLD });
    mocks.twilioCreate.mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(sendGeneratedDraftHandler(owner(textArgs))).rejects.toMatchObject({ details: { code: DRAFT_SEND_UNCONFIRMED } });
    expect(docs['generated_drafts/d2']!['status']).toBe('approved');
    await expect(sendGeneratedDraftHandler(owner(textArgs))).rejects.toMatchObject({ details: { code: DRAFT_SEND_UNCONFIRMED } });
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed draft is kept: it cannot be deleted', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(headersTimeout());
    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ details: { code: DRAFT_SEND_UNCONFIRMED } });
    await expect(deleteGeneratedDraftHandler(owner({ draftId: 'd1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.deletes).toHaveLength(0);
  });

  it('nothingWentOut: only what proves no send lets a claim go', () => {
    const unavailable = (details: Record<string, unknown>) => ({ code: 'unavailable', details });
    // Refused before the provider was called.
    expect(nothingWentOut({ code: 'failed-precondition' })).toBe(true);
    expect(nothingWentOut({ code: 'invalid-argument' })).toBe(true);
    expect(nothingWentOut(new Error('Firestore read failed'))).toBe(true);
    // The provider answered, and the answer was no.
    expect(nothingWentOut(unavailable({ providerStatus: 400, providerCode: 21211 }))).toBe(true);
    expect(nothingWentOut(unavailable({ providerStatus: 503 }))).toBe(true);
    // Answered no in the body, or never dialled: no transport code.
    expect(nothingWentOut(unavailable({ channel: 'email' }))).toBe(true);
    expect(nothingWentOut(unavailable({}))).toBe(true);
    // The connection was never made.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(nothingWentOut(unavailable({ providerCode: code })), code).toBe(true);
    }
    // The request may have gone and nothing came back: not known.
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
      expect(nothingWentOut(unavailable({ providerCode: code })), code).toBe(false);
    }
    // smtp2go answered 2xx with no verdict in it: not known either. The same
    // codeless error with a refusal in words is still a no.
    expect(nothingWentOut({ code: 'unavailable', message: SMTP2GO_NO_VERDICT_MESSAGE, details: { channel: 'email' } })).toBe(false);
    expect(
      nothingWentOut({ code: 'unavailable', message: 'smtp2go send failed: Recipient address rejected', details: { channel: 'email' } }),
    ).toBe(true);
  });

  it('a 2xx from smtp2go that could not be read keeps the claim: it is not sent again', async () => {
    const { docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    // What `lib/email.ts` throws for a 2xx whose body is not JSON: no status, no code.
    mocks.sendTemplatedEmail.mockRejectedValueOnce(new Error(SMTP2GO_NO_VERDICT_MESSAGE));

    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: DRAFT_SEND_UNCONFIRMED_MESSAGE,
      details: { code: DRAFT_SEND_UNCONFIRMED },
    });
    const after = docs['generated_drafts/d1']!;
    expect(after['status']).toBe('approved');
    expect(String(after['sendUnconfirmedAt']) > '').toBe(true);
    expect(draftSendState(after)).toBe('sending');

    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ details: { code: DRAFT_SEND_UNCONFIRMED } });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
  });

  it('a 2xx from smtp2go that names its failures is a no: the draft is unsent again', async () => {
    const { docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockRejectedValueOnce(new Error('smtp2go send failed: Recipient address rejected'));

    await expect(sendGeneratedDraftHandler(owner(emailArgs))).rejects.toMatchObject({ code: 'unavailable' });
    expect(draftSendState(docs['generated_drafts/d1']!)).toBe('unsent');
    expect(docs['generated_drafts/d1']).not.toHaveProperty('sendUnconfirmedAt');
  });
});

describe('sendGeneratedDraft: what happens after the provider took it never fails the call', () => {
  it('a draft deleted while its send was in flight stays deleted', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    mocks.sendTemplatedEmail.mockImplementation(async () => {
      delete docs['generated_drafts/d1'];
      return 'smtp-1';
    });

    const res = await sendGeneratedDraftHandler(owner(emailArgs));

    expect(res.outcome).toBe('sent');
    expect(docs['generated_drafts/d1']).toBeUndefined();
    // No merge `set` anywhere: that is the write that would bring it back.
    expect(ctx.writes.filter((w) => w.path === 'generated_drafts/d1' && !w.merge)).toHaveLength(0);
  });

  it('still answers sent when the send record cannot be written', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    const realCollection = ctx.db.collection;
    ctx.db.collection = (path: string) => {
      const col = realCollection(path);
      if (path === 'external_messages') col.add = vi.fn().mockRejectedValue(new Error('write refused'));
      return col;
    };
    const res = await sendGeneratedDraftHandler(owner(emailArgs));
    expect(res.outcome).toBe('sent');
    expect(draftSendState(docs['generated_drafts/d1']!)).toBe('sent');
  });
});

describe('sendGeneratedDraft: refusals, with nothing sent and the draft untouched', () => {
  async function refused(docs: Docs, args: unknown, expected: Record<string, unknown>) {
    const before = JSON.stringify(docs);
    db(docs);
    await expect(sendGeneratedDraftHandler(owner(args))).rejects.toMatchObject(expected);
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
    const { 'business_settings/business_settings': _gate, ...rest } = docs;
    expect(JSON.stringify(rest)).toBe(before);
  }

  it('nobody signed in', async () => {
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    await expect(sendGeneratedDraftHandler(callableRequest(emailArgs))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('an Auntie: the callable is the owner\'s', async () => {
    const wrapped = wrapAdminCallable('sendGeneratedDraft', sendGeneratedDraftHandler);
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    await expect(
      wrapped(callableRequest(emailArgs, { uid: 'auntie-1', token: { staffRole: 'auntie' } })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('a draft that is gone', async () => {
    await refused({ 'generated_drafts/d1': null, ...HOUSEHOLD }, emailArgs, { code: 'not-found' });
  });

  it('a draft written for a different household', async () => {
    await refused(
      { 'generated_drafts/d1': { ...EMAIL_DRAFT, kinfolk_id: 'kf-olivia' }, ...HOUSEHOLD },
      emailArgs,
      { code: 'permission-denied', message: 'This draft was written for a different household.' },
    );
  });

  it('a draft whose two household spellings disagree, or that names no household', async () => {
    await refused(
      { 'generated_drafts/d1': { ...EMAIL_DRAFT, kinfolkId: 'kf-olivia' }, ...HOUSEHOLD },
      emailArgs,
      { code: 'permission-denied' },
    );
    const { kinfolk_id: _dropped, ...nobody } = EMAIL_DRAFT;
    await refused({ 'generated_drafts/d1': { ...nobody }, ...HOUSEHOLD }, emailArgs, { code: 'permission-denied' });
  });

  it('a draft that is not an Email or a Text', async () => {
    for (const type of ['push', 'visit_report', 'social_post', 'blog_post', 'general', 'Email', '']) {
      await refused(
        { 'generated_drafts/d1': { ...EMAIL_DRAFT, communication_type: type }, ...HOUSEHOLD },
        emailArgs,
        { code: 'failed-precondition', message: 'This draft is not an Email or a Text.' },
      );
    }
  });

  it('an Email with no subject', async () => {
    await refused(
      { 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD },
      { draftId: 'd1', kinfolkId: 'kf-robyn', body: 'Words.' },
      { code: 'invalid-argument', message: 'Email needs a subject.' },
    );
  });

  it('words that are only spaces', async () => {
    await refused(
      { 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD },
      { ...emailArgs, body: '   ' },
      { code: 'invalid-argument' },
    );
  });

  it('a household with no address on file for the channel', async () => {
    await refused(
      { 'generated_drafts/d1': { ...EMAIL_DRAFT }, 'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale', phoneNumber: '(415) 555-2671' } },
      emailArgs,
      { code: 'failed-precondition', message: 'Robyn Hale has no email address on file. Add one in Directory before sending.' },
    );
    await refused(
      { 'generated_drafts/d2': { ...TEXT_DRAFT }, 'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale', email: 'catch@hanasamku.com' } },
      textArgs,
      { code: 'failed-precondition', message: 'Robyn Hale has no phone number on file. Add one in Directory before sending.' },
    );
  });

  it('an address on file that cannot be sent to, without quoting it', async () => {
    db({ 'generated_drafts/d2': { ...TEXT_DRAFT }, 'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale', phoneNumber: '555' } });
    const err = await sendGeneratedDraftHandler(owner(textArgs)).catch((e: unknown) => e as { code: string; message: string });
    expect(err).toMatchObject({ code: 'failed-precondition' });
    expect((err as { message: string }).message).toContain('Robyn Hale');
    expect((err as { message: string }).message).not.toContain('555');
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
  });

  it('a household that no longer exists', async () => {
    await refused({ 'generated_drafts/d1': { ...EMAIL_DRAFT } }, emailArgs, { code: 'failed-precondition' });
  });

  it('a request with a slash in the draft id, or an address smuggled in', async () => {
    db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    await expect(sendGeneratedDraftHandler(owner({ ...emailArgs, draftId: 'a/b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    // An address in the request is ignored: the household's own is the only one read.
    await sendGeneratedDraftHandler(owner({ ...emailArgs, to: 'pawsome@hanasamku.com' }));
    expect(mocks.sendTemplatedEmail.mock.calls[0]![0]).toMatchObject({ to: 'catch@hanasamku.com' });
  });
});

describe('deleteGeneratedDraft keeps every draft a household was sent (#2428)', () => {
  const sentDrafts: Array<[string, Record<string, unknown>]> = [
    ['an Email sendGeneratedDraft stamped', { ...EMAIL_DRAFT, status: 'approved', sentAt: '2026-11-20T10:00:01.000Z' }],
    ['a Text an older client approved and sent', { ...TEXT_DRAFT, status: 'approved' }],
    ['an Email whose send is in flight', { ...EMAIL_DRAFT, status: 'approved', sendClaimedAt: '2026-11-20T10:00:00.000Z' }],
    ['a Push that reached their phone', { ...EMAIL_DRAFT, communication_type: 'push', status: 'approved', pushOutcome: 'sent' }],
    ['a Push on their notifications list', { ...EMAIL_DRAFT, communication_type: 'push', status: 'approved', pushOutcome: 'listed' }],
  ];
  for (const [what, draft] of sentDrafts) {
    it(`refuses ${what}`, async () => {
      const { ctx, docs } = db({ 'generated_drafts/d1': { ...draft } });
      await expect(deleteGeneratedDraftHandler(owner({ draftId: 'd1' }))).rejects.toMatchObject({
        code: 'failed-precondition',
        message: 'This draft has already been sent, so it is kept.',
      });
      expect(ctx.deletes).toHaveLength(0);
      expect(docs['generated_drafts/d1']).toBeDefined();
    });
  }

  const unsentDrafts: Array<[string, Record<string, unknown>]> = [
    ['an Email nobody approved', { ...EMAIL_DRAFT }],
    ['an Email whose send the provider refused', { ...EMAIL_DRAFT, sendFailedAt: '2026-11-20T10:00:01.000Z' }],
    ['a held Push', { ...EMAIL_DRAFT, communication_type: 'push', status: 'approved', pushOutcome: 'held' }],
    ['a Push whose send never answered (#2381)', { ...EMAIL_DRAFT, communication_type: 'push', status: 'approved' }],
    ['an approved Blog post, which is sent by nothing', { ...EMAIL_DRAFT, communication_type: 'blog_post', status: 'approved' }],
  ];
  for (const [what, draft] of unsentDrafts) {
    it(`still deletes ${what}`, async () => {
      const { ctx } = db({ 'generated_drafts/d1': { ...draft } });
      await expect(deleteGeneratedDraftHandler(owner({ draftId: 'd1' }))).resolves.toEqual({ ok: true, draftId: 'd1' });
      expect(ctx.deletes).toContain('generated_drafts/d1');
    });
  }

  it('a draft sendGeneratedDraft just sent cannot then be deleted', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...EMAIL_DRAFT }, ...HOUSEHOLD });
    await sendGeneratedDraftHandler(owner(emailArgs));
    await expect(deleteGeneratedDraftHandler(owner({ draftId: 'd1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.deletes).toHaveLength(0);
  });
});
