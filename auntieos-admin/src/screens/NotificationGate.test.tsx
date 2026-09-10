// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  STREAM_STAFF,
  type NotificationCatalogEntry,
  type NotificationMatrix,
} from '../api/myNotifications';

const { getNotificationMatrix } = vi.hoisted(() => ({ getNotificationMatrix: vi.fn() }));
vi.mock('../api/myNotifications', async (orig) => ({
  ...(await orig<typeof import('../api/myNotifications')>()),
  getNotificationMatrix,
}));

const { saveBusinessNotificationOverride } = vi.hoisted(() => ({
  saveBusinessNotificationOverride: vi.fn(),
}));
vi.mock('../api/notificationOverridesWrite', () => ({
  saveBusinessNotificationOverride,
  deleteBusinessNotificationOverride: vi.fn(),
}));
const { listNotificationDeliveries } = vi.hoisted(() => ({
  listNotificationDeliveries: vi.fn(),
}));
vi.mock('../api/notificationDeliveries', () => ({ listNotificationDeliveries }));
const { listBusinessAdmins } = vi.hoisted(() => ({ listBusinessAdmins: vi.fn() }));
vi.mock('../api/businessAdmins', () => ({ listBusinessAdmins }));

import { NotificationGate } from './NotificationGate';

function entry(over: Partial<NotificationCatalogEntry> = {}): NotificationCatalogEntry {
  return {
    key: 'kincare.booking.confirm',
    label: 'Booking confirmed',
    category: 'visit',
    audience: 'business',
    audiences: new Set([STREAM_BUSINESS]),
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    alwaysEnabledStreams: new Set(),
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    whoReceives: [],
    recipientResolver: '',
    emitters: [],
    neverFires: false,
    templates: {},
    mergeFields: [],
    external: false,
    description: '',
    ...over,
  };
}

function matrix(over: Partial<NotificationMatrix> = {}): NotificationMatrix {
  return {
    catalog: [],
    overrides: {},
    ungated: [],
    businessAdminCount: null,
    businessAdminRosterPath: 'businessSettings/admins.uids',
    updatedAtMs: null,
    ...over,
  };
}

beforeEach(() => {
  getNotificationMatrix.mockReset();
  saveBusinessNotificationOverride.mockReset().mockResolvedValue(undefined);
  listNotificationDeliveries.mockReset().mockResolvedValue({
    deliveries: [],
    sentMeaning: 'Sent means the provider accepted the message.',
    receiptAvailable: false,
  });
  listBusinessAdmins.mockReset().mockResolvedValue({
    members: [],
    source: 'none',
    rosterPath: 'businessSettings/admins.uids',
    reason: 'businessSettings/admins.uids is empty.',
  });
});

describe('NotificationGate screen', () => {
  it('renders the three audience tabs', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({}),
          entry({ key: 'k2', category: 'kintale', audiences: new Set([STREAM_STAFF]) }),
          entry({ key: 'k3', audiences: new Set([STREAM_KINFOLK]) }),
        ],
      }),
    );
    render(<NotificationGate />);
    expect(await screen.findByRole('tab', { name: /Business/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Staff/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Kinfolk/ })).toBeInTheDocument();
  });

  it('shows a catalog-empty message when nothing is in the catalog', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [] }));
    render(<NotificationGate />);
    expect(await screen.findByText(/no notification types in the catalog yet/i)).toBeInTheDocument();
  });

  // #718: Settings > Notifications is the only place this renders now, and
  // Settings already carries its own page heading. A second h1 nested inside
  // that tab panel would repeat it, so NotificationGate no longer draws one.
  it('renders no page heading of its own; embedded in Settings is its only surface', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [] }));
    render(<NotificationGate />);
    await screen.findByText(/no notification types in the catalog yet/i);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notification gate', level: 2 })).toBeInTheDocument();
  });

  it('shows the spinner while getNotificationMatrix cold-starts, not the catalog-empty message (issue #714)', async () => {
    let resolveMatrix: (value: NotificationMatrix) => void = () => {};
    getNotificationMatrix.mockImplementation(
      () => new Promise((resolve) => { resolveMatrix = resolve; }),
    );
    render(<NotificationGate />);

    expect(await screen.findByRole('img', { name: 'Loading the notification gate…' })).toBeInTheDocument();
    expect(screen.queryByText(/no notification types in the catalog yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    resolveMatrix(matrix({ catalog: [entry({})] }));

    expect(await screen.findByRole('tab', { name: /Business/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Loading the notification gate…' })).not.toBeInTheDocument();
  });

  it('turning a channel off persists a per-stream overlay through the write callable', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<NotificationGate />);

    const sms = await screen.findByRole('switch', { name: /via SMS for Business/i });
    expect(sms).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sms);

    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    // Edited under the Business tab -> a business stream overlay, not the flat field.
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({
        streams: expect.objectContaining({
          business: expect.objectContaining({ channels: expect.objectContaining({ sms: false }) }),
        }),
      }),
    );
    // Optimistic update flips the visible toggle immediately.
    expect(sms).toHaveAttribute('aria-checked', 'false');
  });

  it('locking the whole notification writes a stream lockedEnabled overlay', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    render(<NotificationGate />);

    const lock = await screen.findByRole('button', { name: /^Lock on for Business$/i });
    await userEvent.click(lock);

    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({
        streams: expect.objectContaining({
          business: expect.objectContaining({ lockedEnabled: true }),
        }),
      }),
    );
  });

  it('switches audiences: a kinfolk-only row appears only under the Kinfolk tab', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({ key: 'kb', label: 'Booking confirmed' }),
          entry({ key: 'kk', label: 'Visit report', audiences: new Set([STREAM_KINFOLK]) }),
        ],
      }),
    );
    render(<NotificationGate />);

    expect(await screen.findByText('Booking confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Visit report')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Kinfolk/ }));
    expect(await screen.findByText('Visit report')).toBeInTheDocument();
    expect(screen.queryByText('Booking confirmed')).not.toBeInTheDocument();
  });

  /**
   * #386: broadcasts used to be stamped with a key that was in no catalog, so
   * this screen never offered the operator a row for them and there was nothing
   * to switch off. The row itself is server-side (MyTribe/functions/src/
   * notifications/catalog.ts) and reaches this screen through
   * `getNotificationMatrix`; what is asserted here is that a row shaped like
   * that one is GOVERNABLE from the Kinfolk tab: it renders, and its channel
   * toggles persist under its own key.
   */
  it('governs the broadcast row from the Kinfolk tab', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({
            key: 'broadcast.message',
            label: 'Announcements from the office',
            category: 'messages',
            audience: 'kinfolk',
            audiences: new Set([STREAM_KINFOLK]),
            kinfolkFacing: true,
            description: 'One-off announcements the office sends to a group of households.',
          }),
        ],
      }),
    );
    render(<NotificationGate />);

    await userEvent.click(await screen.findByRole('tab', { name: /Kinfolk/ }));
    expect(await screen.findByText('Announcements from the office')).toBeInTheDocument();

    const sms = screen.getByRole('switch', { name: /via SMS for Kinfolk/i });
    await userEvent.click(sms);
    await waitFor(() => expect(saveBusinessNotificationOverride).toHaveBeenCalledTimes(1));
    expect(saveBusinessNotificationOverride).toHaveBeenCalledWith(
      'broadcast.message',
      expect.objectContaining({
        streams: expect.objectContaining({
          kinfolk: expect.objectContaining({ channels: expect.objectContaining({ sms: false }) }),
        }),
      }),
    );
  });

  it('surfaces a load failure fail-loud', async () => {
    getNotificationMatrix.mockRejectedValue(new Error('permission-denied'));
    render(<NotificationGate />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('a save failure is fail-loud (names the callable) and reloads to server truth', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [entry({ key: 'k' })] }));
    saveBusinessNotificationOverride.mockRejectedValueOnce(new Error('nope'));
    render(<NotificationGate />);

    const sms = await screen.findByRole('switch', { name: /via SMS for Business/i });
    await userEvent.click(sms);

    expect(await screen.findByText(/saveBusinessNotificationOverride failed/i)).toBeInTheDocument();
    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
    // initial load + reload-on-failure
    await waitFor(() => expect(getNotificationMatrix).toHaveBeenCalledTimes(2));
  });
});
/**
 * #396. The gate could always turn a notification off. It could never say what
 * it was turning off. These cases cover the half that answers the operator's
 * actual question: "I am blind to what could be sent out to users."
 */
describe('NotificationGate: who / what fires it / whether it arrived (#396)', () => {
  const documented = entry({
    key: 'invoice.new',
    label: 'New invoice',
    whoReceives: [
      "The household's own portal account.",
      'Every business admin on the roster, one copy each.',
    ],
    emitters: [
      {
        trigger: 'An admin creates an invoice.',
        source: 'src/admin/createInvoice.ts',
        dataKeys: ['kinfolkId', 'invoiceId'],
      },
    ],
    templates: { email: 'invoice.new', sms: 'invoice.new', push: 'invoice.new' },
    mergeFields: ['amount', 'dueDate'],
  });
  async function open(label = /Who gets this, and what fires it/i) {
    render(<NotificationGate />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
  }
  it('keeps the answer folded until asked, so the matrix stays a matrix', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    render(<NotificationGate />);
    const toggle = await screen.findByRole('button', { name: /Who gets this, and what fires it/i });
    // aria-expanded is the state carrier. jsdom would call folded content
    // "visible", so asserting on the text alone would prove nothing.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/An admin creates an invoice/)).not.toBeInTheDocument();
  });
  it('names every audience a notification reaches, in plain words', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText(/The household's own portal account/)).toBeInTheDocument();
    expect(screen.getByText(/Every business admin on the roster/)).toBeInTheDocument();
  });
  it('counts the business-admin roster, so "every admin" is a number', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [documented], businessAdminCount: 4 }),
    );
    await open();
    expect(await screen.findByText(/That is 4 people today/)).toBeInTheDocument();
  });
  it('names what fires it and where that code lives', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText(/An admin creates an invoice/)).toBeInTheDocument();
    expect(screen.getByText('src/admin/createInvoice.ts')).toBeInTheDocument();
  });
  it('names the template document behind each channel', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText('emailTemplates/invoice.new')).toBeInTheDocument();
    expect(screen.getByText('smsTemplates/invoice.new')).toBeInTheDocument();
  });
  it('says when the email has been retargeted, and names the catalog default', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [
          entry({
            ...documented,
            templates: { email: 'invoice.new.v2', sms: 'invoice.new', push: 'invoice.new' },
            emailTemplateRetargetedFrom: 'invoice.new',
          }),
        ],
      }),
    );
    await open();
    expect(await screen.findByText('emailTemplates/invoice.new.v2')).toBeInTheDocument();
    expect(screen.getByText(/the catalog default is invoice\.new/)).toBeInTheDocument();
  });
  /**
   * The gate REPORTS the routing; Template Assignments (#439) owns changing it.
   * Two screens offering the same edit is how they end up disagreeing, so the
   * gate names the one that owns it rather than growing its own control.
   */
  it('points at Template Assignments rather than offering its own repoint control', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText(/Repoint an email on the Template/)).toBeInTheDocument();
  });

  it('lists the merge fields, emitter data keys included, as the leak surface', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText('amount')).toBeInTheDocument();
    // This one existed only in source before now: it is what the emitter puts
    // in the bag, and it is the half that matters for a leak.
    expect(screen.getByText('invoiceId')).toBeInTheDocument();
  });
  it('says a row nothing fires controls nothing', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ key: 'quote.accepted', neverFires: true, emitters: [] })] }),
    );
    render(<NotificationGate />);
    expect(await screen.findByText('Never fires')).toBeInTheDocument();
  });
  it('never captions a critical row "Always on", because nothing enforces it', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({ catalog: [entry({ key: 'auth.password.reset', alwaysEnabled: true })] }),
    );
    render(<NotificationGate />);
    await screen.findByText('Meant to stay on');
    expect(screen.queryByText('Always on')).not.toBeInTheDocument();
  });
  it('warns loudly once a critical row is actually switched off', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [entry({ key: 'auth.password.reset', alwaysEnabled: true })],
        overrides: {
          'auth.password.reset': {
            enabled: false,
            channels: {},
            lockedEnabled: false,
            locked: {},
            streams: {},
          },
        },
      }),
    );
    render(<NotificationGate />);
    expect(await screen.findByText('Off, and meant to stay on')).toBeInTheDocument();
  });
  it('reports "sent" as handed over, never as delivered', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    listNotificationDeliveries.mockResolvedValue({
      deliveries: [
        {
          dispatchId: 'd1',
          key: 'invoice.new',
          recipientUid: 'kin1',
          status: 'dispatched',
          mode: 'trigger',
          channels: ['email'],
          createdAtMs: Date.UTC(2026, 7, 1, 12, 0),
          attempts: [
            {
              channel: 'email',
              status: 'sent',
              providerMessageId: 'smtp-1',
              skipReason: null,
              errorMessage: null,
              attempts: 1,
              sentAtMs: null,
              failedAtMs: null,
              skippedAtMs: null,
            },
          ],
        },
      ],
      sentMeaning: 'Sent means the provider accepted the message.',
      receiptAvailable: false,
    });
    await open();
    expect(await screen.findByText(/Handed to the provider/)).toBeInTheDocument();
    expect(screen.queryByText(/Delivered/)).not.toBeInTheDocument();
    expect(screen.getByText('smtp-1')).toBeInTheDocument();
  });
  it('shows a failure with its provider error rather than hiding it', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    listNotificationDeliveries.mockResolvedValue({
      deliveries: [
        {
          dispatchId: 'd1',
          key: 'invoice.new',
          recipientUid: 'kin1',
          status: 'dispatched',
          mode: 'trigger',
          channels: ['sms'],
          createdAtMs: 1,
          attempts: [
            {
              channel: 'sms',
              status: 'failed',
              providerMessageId: null,
              skipReason: null,
              errorMessage: 'Twilio 21610: unsubscribed recipient',
              attempts: 3,
              sentAtMs: null,
              failedAtMs: 2,
              skippedAtMs: null,
            },
          ],
        },
      ],
      sentMeaning: 'x',
      receiptAvailable: false,
    });
    await open();
    expect(await screen.findByText(/Twilio 21610: unsubscribed recipient/)).toBeInTheDocument();
    expect(screen.getByText(/Tried 3 times/)).toBeInTheDocument();
  });
  it('says an empty delivery log is not evidence of failure', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    await open();
    expect(await screen.findByText(/not evidence it failed/i)).toBeInTheDocument();
  });
  it('surfaces a delivery-log read failure instead of rendering an empty log', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented] }));
    listNotificationDeliveries.mockRejectedValue(new Error('permission-denied'));
    await open();
    expect(await screen.findByText(/Couldn’t read the delivery log/)).toBeInTheDocument();
  });
  it('lists the mail this gate does NOT govern', async () => {
    getNotificationMatrix.mockResolvedValue(
      matrix({
        catalog: [documented],
        ungated: [
          {
            templateId: 'invite.primary',
            trigger: 'A household is invited to the portal.',
            source: 'src/admin/inviteKinfolkToPortal.ts',
          },
        ],
      }),
    );
    render(<NotificationGate />);
    expect(await screen.findByText(/ALSO SENT, BUT NOT GATED HERE/)).toBeInTheDocument();
    expect(screen.getByText('emailTemplates/invite.primary')).toBeInTheDocument();
  });
  it('says nothing about ungated mail when there is none to warn about', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [documented], ungated: [] }));
    render(<NotificationGate />);
    await screen.findByText('New invoice');
    expect(screen.queryByText(/ALSO SENT, BUT NOT GATED HERE/)).not.toBeInTheDocument();
  });
});
/**
 * Issue #450. Every other audience on this screen resolves to a description of
 * a person. `businessAdmins` resolved to a count and a Firestore path, because
 * nothing could read the roster back, so the answer to "who does this reach"
 * was still "go and look it up yourself".
 */
describe('NotificationGate: naming the business admin roster (#450)', () => {
  const businessRow = entry({
    key: 'kincare.requested',
    label: 'Booking requested',
    recipientResolver: 'businessAdmins',
    whoReceives: ['Every business admin on the roster, one copy each.'],
  });
  const householdRow = entry({
    key: 'invoice.new',
    label: 'New invoice',
    recipientResolver: 'kinfolkAcct',
    whoReceives: ["The household's own portal account."],
  });
  const roster = {
    members: [
      {
        uid: 'op1',
        displayName: 'Auntie Nora',
        email: 'nora@tribetails.com',
        hasStaffRecord: true,
        defaultAssignee: true,
      },
      {
        uid: 'op8',
        displayName: null,
        email: null,
        hasStaffRecord: false,
        defaultAssignee: false,
      },
    ],
    source: 'roster' as const,
    rosterPath: 'businessSettings/admins.uids',
    reason: null,
  };
  async function open(label = /Who gets this, and what fires it/i) {
    render(<NotificationGate />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
  }
  it('names the people behind "every business admin"', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [businessRow], businessAdminCount: 2 }));
    listBusinessAdmins.mockResolvedValue(roster);
    await open();
    expect(await screen.findByText(/Auntie Nora/)).toBeInTheDocument();
    expect(screen.getByText(/nora@tribetails.com/)).toBeInTheDocument();
  });
  it('shows an allowlist-seeded operator by uid rather than dropping them', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [businessRow], businessAdminCount: 2 }));
    listBusinessAdmins.mockResolvedValue(roster);
    await open();
    expect(await screen.findByText(/op8/)).toBeInTheDocument();
    expect(screen.getByText(/no staff record/)).toBeInTheDocument();
  });
  it('warns when the list is the allowlist fallback and the roster is empty', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [businessRow], businessAdminCount: 0 }));
    listBusinessAdmins.mockResolvedValue({ ...roster, source: 'operatorAllowlist' });
    await open();
    expect(await screen.findByText(/operator allowlist accounts/)).toBeInTheDocument();
  });
  it('reports an empty roster as the outage it is, in the server’s words', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [businessRow], businessAdminCount: 0 }));
    listBusinessAdmins.mockResolvedValue({
      members: [],
      source: 'none',
      rosterPath: 'businessSettings/admins.uids',
      reason: 'businessSettings/admins.uids is empty, so this reaches nobody. Call provisionBusinessAdmins.',
    });
    await open();
    expect(await screen.findByText(/Call provisionBusinessAdmins/)).toBeInTheDocument();
  });
  it('surfaces a roster read failure with a way to try again', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [businessRow] }));
    listBusinessAdmins.mockRejectedValue(new Error('permission-denied'));
    await open();
    expect(await screen.findByText(/Couldn’t read the business admin roster/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
  /**
   * One extra callable per opened row is worth it for the row it answers and
   * not for any other, so a household-only row must not pay for it.
   */
  it('does not read the roster for a row that never reaches business admins', async () => {
    getNotificationMatrix.mockResolvedValue(matrix({ catalog: [householdRow] }));
    await open();
    await screen.findByText(/The household's own portal account/);
    expect(listBusinessAdmins).not.toHaveBeenCalled();
  });
});
