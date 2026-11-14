import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #1564. Operator ruling, 2026-11-05 docket: "every business email goes to the
 * business contact email in business settings (`businessEmail`), not to a staff
 * record." On the walk the only business admin's staff record had no email, so
 * every business email was skipped as `recipient_no_email`.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  loadEmailTemplate: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  logEvent: vi.fn(),
  /** Custom claims per uid; a uid not named here is an owner (`admin: true`). */
  claims: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: () => ({
    auth: () => ({
      getUsers: async (ids: Array<{ uid: string }>) => ({
        users: ids.map(({ uid }) => ({ uid, customClaims: mocks.claims[uid] ?? { admin: true } })),
        notFound: [],
      }),
    }),
  }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ loadEmailTemplate: mocks.loadEmailTemplate }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import type { NotificationDef } from '../src/notifications/types';

const ADMIN = 'nppJNdMNYJfUigibGKUQj3n4obt2';
const SETTINGS = 'business_settings/business_settings';
const ROSTER = 'businessSettings/admins';

/** A business-only key, as `kincare.requested` is in the catalog. */
const BUSINESS_DEF: NotificationDef = {
  key: 'kincare.requested',
  label: 'Visit requested',
  audience: 'business',
  audiences: { business: true },
  category: 'visit',
  allowedChannels: ['email'],
  required: { email: true },
  alwaysEnabled: false,
  kinfolkFacing: false,
  deliveryMode: 'trigger',
  recipientResolver: 'businessAdmins',
  templates: { email: 'kincare.requested' },
  description: 'test',
};

/** An Auntie's own mail, as `assignment.assigned` is: not a business email. */
const AUNTIE_DEF: NotificationDef = {
  ...BUSINESS_DEF,
  key: 'assignment.assigned',
  audience: 'business',
  audiences: { staff: true },
  recipientResolver: 'auntieAssignedToKincare',
  templates: { email: 'assignment.assigned' },
};

function dbWith(docs: Record<string, Record<string, unknown>>) {
  const docMock = (path: string) => ({
    get: vi.fn(async () => ({ exists: path in docs, data: () => docs[path] })),
  });
  return {
    doc: (path: string) => docMock(path),
    collection: (col: string) => ({ doc: (id: string) => docMock(`${col}/${id}`) }),
  };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.loadEmailTemplate.mockReset().mockResolvedValue({ subject: 'S', body: 'B' });
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('msg-1');
  mocks.logEvent.mockReset();
  mocks.claims = {};
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

describe('sendEmailChannel: business email goes to businessEmail (#1564)', () => {
  it('sends a roster admin with no staff email to the business contact email', async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({
        [`staff/${ADMIN}`]: { staffRole: 'admin' },
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: ' pawsome@hanasamku.com ' },
      }),
    );

    const res = await sendEmailChannel({ def: BUSINESS_DEF, recipientUid: ADMIN, data: {} });

    expect(res).toEqual({ providerMessageId: 'msg-1' });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pawsome@hanasamku.com' }),
    );
  });

  it('sends to businessEmail even when the staff record has its own address', async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({
        [`staff/${ADMIN}`]: { email: 'catch@hanasamku.com' },
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    await sendEmailChannel({ def: BUSINESS_DEF, recipientUid: ADMIN, data: {} });

    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('pawsome@hanasamku.com');
  });

  it('skips with business_email_unset and a warn log when businessEmail is blank', async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({
        [`staff/${ADMIN}`]: { email: 'catch@hanasamku.com' },
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: '   ' },
      }),
    );

    const res = await sendEmailChannel({ def: BUSINESS_DEF, recipientUid: ADMIN, data: {} });

    expect(res).toEqual({ skipped: true, skipReason: 'business_email_unset' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'notification.businessEmail.unset' }),
    );
  });

  it('uses the operator allowlist while the roster is empty, as dispatch does', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = ADMIN;
    mocks.dbFn.mockReturnValue(dbWith({ [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' } }));

    await sendEmailChannel({ def: BUSINESS_DEF, recipientUid: ADMIN, data: {} });

    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('pawsome@hanasamku.com');
  });

  it("leaves an assigned Auntie's own mail on her staff record", async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({
        'staff/auntie1': { email: 'catch@hanasamku.com' },
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    await sendEmailChannel({ def: AUNTIE_DEF, recipientUid: 'auntie1', data: {} });

    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('catch@hanasamku.com');
  });

  it('never mails the business for a uid that is not on the roster', async () => {
    // A household uid with no clients/ document on a both-audience key: the
    // old answer (skip, no address) stands; the business inbox is not a
    // stand-in for a missing household.
    mocks.dbFn.mockReturnValue(
      dbWith({
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    const res = await sendEmailChannel({
      def: { ...BUSINESS_DEF, recipientResolver: 'kinfolkAcct', secondaryResolver: 'businessAdmins' },
      recipientUid: 'household1',
      data: {},
    });

    expect(res).toEqual({ skipped: true, skipReason: 'recipient_no_email' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("a household's copy of a both-audience key still goes to the household", async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({
        'clients/household1': { email: 'catch@hanasamku.com' },
        [ROSTER]: { uids: [ADMIN] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    await sendEmailChannel({
      def: { ...BUSINESS_DEF, recipientResolver: 'kinfolkAcct', secondaryResolver: 'businessAdmins' },
      recipientUid: 'household1',
      data: {},
    });

    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('catch@hanasamku.com');
  });
});

/**
 * #2223 review: the dispatcher skips an Auntie left on the business admin list,
 * so the business-copy check here has to agree with it about who is on it.
 */
describe('sendEmailChannel: the business copy check skips an Auntie on the list (#2223)', () => {
  it('a list holding only an Auntie: the allowlist owner the dispatcher chose still gets the business email', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = ADMIN;
    mocks.claims = { auntie1: { staffRole: 'auntie' } };
    mocks.dbFn.mockReturnValue(
      dbWith({
        [ROSTER]: { uids: ['auntie1'] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    const res = await sendEmailChannel({ def: BUSINESS_DEF, recipientUid: ADMIN, data: {} });

    expect(res).toEqual({ providerMessageId: 'msg-1' });
    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('pawsome@hanasamku.com');
  });

  it("an Auntie left on the list keeps her own assignment mail on her staff record", async () => {
    mocks.claims = { auntie1: { staffRole: 'auntie' } };
    mocks.dbFn.mockReturnValue(
      dbWith({
        'staff/auntie1': { email: 'catch@hanasamku.com', staffRole: 'auntie' },
        [ROSTER]: { uids: [ADMIN, 'auntie1'] },
        [SETTINGS]: { businessEmail: 'pawsome@hanasamku.com' },
      }),
    );

    await sendEmailChannel({
      def: { ...AUNTIE_DEF, secondaryResolver: 'businessAdmins' },
      recipientUid: 'auntie1',
      data: {},
    });

    expect(mocks.sendTemplatedEmail.mock.calls[0]![0].to).toBe('catch@hanasamku.com');
  });
});
