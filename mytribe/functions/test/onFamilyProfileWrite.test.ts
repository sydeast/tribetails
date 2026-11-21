import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));

import { onFamilyProfileWriteHandler, type FamilyProfileWriteEvent } from '../src/triggers/onFamilyProfileWrite';

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue(null);
  mocks.logEvent.mockReset();
});

type Doc = Record<string, unknown> | undefined;
const snap = (d: Doc) => ({ exists: d !== undefined, data: () => d });
const write = (before: Doc, after: Doc): FamilyProfileWriteEvent => ({
  params: { kinfolkId: 'fam1' },
  data: { before: snap(before), after: snap(after) },
});

/** The envelope `onKinfolkCreate` provisions for a new household (familyProvision.ts). */
const ENVELOPE = {
  displayName: 'Halbrook',
  primaryUid: '',
  themeConfigRef: 'families/fam1/themeConfig/active',
  flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
  provisionedBy: 'onKinfolkCreate',
};

describe('onFamilyProfileWrite (#1963)', () => {
  it('a new household envelope is not a profile update: nobody is told', async () => {
    await onFamilyProfileWriteHandler(write(undefined, ENVELOPE));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.resolveKinfolkUid).not.toHaveBeenCalled();
  });

  it('the invite path creating the envelope is not an update either', async () => {
    const { provisionedBy: _p, ...inviteEnvelope } = ENVELOPE;
    await onFamilyProfileWriteHandler(write(undefined, inviteEnvelope));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a changed name on an existing household still sends profile.updated to the household and the office', async () => {
    mocks.resolveKinfolkUid.mockResolvedValue('primary1');
    await onFamilyProfileWriteHandler(write(ENVELOPE, { ...ENVELOPE, displayName: 'Halbrook-Reyes' }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      key: 'profile.updated',
      recipientUid: 'primary1',
      data: { kinfolkId: 'fam1' },
    });
  });

  it('an unclaimed household passes no household uid, so only the office copy resolves', async () => {
    await onFamilyProfileWriteHandler(write(ENVELOPE, { ...ENVELOPE, phone: '+15555550123' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ recipientUid: '' }));
  });

  it('a write that touches no profile field sends nothing (the PIN flag, the claim)', async () => {
    await onFamilyProfileWriteHandler(
      write(ENVELOPE, { ...ENVELOPE, primaryUid: 'primary1', flags: { ...ENVELOPE.flags, tribePinSet: true } }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a delete sends nothing', async () => {
    await onFamilyProfileWriteHandler(write(ENVELOPE, undefined));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a failed send is logged and never thrown back into the trigger', async () => {
    mocks.enqueue.mockRejectedValue(new Error('roster read failed'));
    await expect(
      onFamilyProfileWriteHandler(write(ENVELOPE, { ...ENVELOPE, displayName: 'Reyes' })),
    ).resolves.toBeUndefined();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification.dispatch.failed', extra: expect.objectContaining({ kinfolkId: 'fam1' }) }),
    );
  });
});
