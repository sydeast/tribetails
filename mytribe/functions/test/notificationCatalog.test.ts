import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_CATALOG,
  alwaysEnabledForStream,
  listNotificationKeys,
} from '../src/notifications/catalog';

describe('NOTIFICATION_CATALOG integrity', () => {
  it('exposes every catalog key', () => {
    expect(listNotificationKeys().length).toBeGreaterThanOrEqual(30);
  });

  it('Run-4: invite-expired is Business/account via businessAdmins', () => {
    // The invite-ACCEPTED half of this pair, `account.welcome.business`, was
    // retired on 2026-08-18 at the operator's request (see
    // RETIRED_NOTIFICATION_KEYS in the catalog). Only invite-expired is left.
    expect(NOTIFICATION_CATALOG['account.welcome.business']).toBeUndefined();

    const expired = NOTIFICATION_CATALOG['invite.expired']!;
    expect(expired).toBeTruthy();
    expect(expired.audience).toBe('business');
    expect(expired.category).toBe('account');
    expect(expired.recipientResolver).toBe('businessAdmins');
    expect(expired.kinfolkFacing).toBe(false);
  });

  it('Run-4 audit: the three dual-bucket notifications are audience=both AND dispatch to both', () => {
    // audience=both is UI-only; a second resolver is what makes the other audience
    // actually RECEIVE it (otherwise the tab shows a notification it never sends).
    // `auth.failedLogin.attempts` left this list in #877: business admins get
    // their own key, `security.failedLogin.attempts.operator`, with an operator template.
    for (const k of ['kincare.changed', 'kintale.comment.added', 'invoice.payment.applied']) {
      const def = NOTIFICATION_CATALOG[k]!;
      expect(def.audience, `${k} should be both`).toBe('both');
      expect(def.secondaryResolver, `${k} needs a secondaryResolver to reach both audiences`).toBeTruthy();
      // The two resolvers must cover both a kinfolk-side and a business-side recipient.
      const resolvers = [def.recipientResolver, def.secondaryResolver];
      expect(resolvers).toContain('businessAdmins');
      expect(resolvers.some((r) => r === 'kinfolkAcct' || r === 'specificUid')).toBe(true);
    }
  });

  it('every notification exposes all three channels (business gate decides availability)', () => {
    // New model (2026-06-25): the business per-notification matrix shows Email+SMS+Push
    // for EVERY notification; the operator enables/disables/locks each channel, and users
    // pick within what's enabled. So no notification may pre-restrict its channels.
    for (const key of listNotificationKeys()) {
      const def = NOTIFICATION_CATALOG[key]!;
      expect([...def.allowedChannels].sort(), `${def.key} must allow email+sms+push`).toEqual([
        'email',
        'push',
        'sms',
      ]);
    }
  });

  it('every allowedChannels entry has a matching template id', () => {
    for (const key of listNotificationKeys()) {
      const def = NOTIFICATION_CATALOG[key]!;
      for (const ch of def.allowedChannels) {
        expect(def.templates[ch], `${def.key} missing ${ch} template`).toBeTruthy();
      }
    }
  });

  it('every required channel is in allowedChannels', () => {
    for (const key of listNotificationKeys()) {
      const def = NOTIFICATION_CATALOG[key]!;
      for (const ch of Object.keys(def.required) as Array<'email' | 'sms' | 'push'>) {
        if (def.required[ch]) {
          expect(def.allowedChannels.includes(ch), `${def.key} required ${ch} not in allowedChannels`).toBe(true);
        }
      }
    }
  });

  it('batched mode requires batchKey + batchWindowMs', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      if (def.deliveryMode === 'batched') {
        expect(def.batchKey, `${def.key} batched mode missing batchKey`).toBeTruthy();
        expect(def.batchWindowMs, `${def.key} batched mode missing batchWindowMs`).toBeTruthy();
      }
    }
  });

  it('marketing-class notifications all live in marketing category', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      if (def.marketingCategory) {
        expect(def.category).toBe('marketing');
      }
    }
  });

  it('kintale.note.added is registered as kinfolk-facing trigger with email+push', () => {
    const def = NOTIFICATION_CATALOG['kintale.note.added'];
    expect(def, 'kintale.note.added missing from catalog').toBeDefined();
    expect(def!.audience).toBe('kinfolk');
    expect(def!.category).toBe('kintale');
    expect(def!.kinfolkFacing).toBe(true);
    expect(def!.deliveryMode).toBe('trigger');
    expect(def!.recipientResolver).toBe('kinfolkAcct');
    // New model: every notification exposes all three channels (business gate decides).
    expect([...def!.allowedChannels].sort()).toEqual(['email', 'push', 'sms']);
    expect(def!.templates.email).toBe('kintale.note.added');
    expect(def!.templates.push).toBe('kintale.note.added');
    expect(def!.templates.sms).toBe('kintale.note.added');
  });

  it('#386: broadcast.message is a real row the operator and the household can both govern', () => {
    // The key is the one `admin/broadcastMessage.ts` stamps on the notification
    // doc it writes; a key with no row cannot be gated or silenced by anyone,
    // which is the defect this row closes.
    const def = NOTIFICATION_CATALOG['broadcast.message'];
    expect(def, 'broadcast.message missing from catalog').toBeDefined();
    expect(def!.audience).toBe('kinfolk');
    expect(def!.category).toBe('messages');
    // Visible on the household's own notification settings...
    expect(def!.kinfolkFacing).toBe(true);
    // ...and switchable off by the operator on the gate, on any channel.
    expect(def!.alwaysEnabled).toBe(false);
    expect(def!.required).toEqual({});
    // Transactional, NOT marketing-class: `marketingCategory` is an opt-IN gate
    // resolveChannels puts beyond the operator's reach, and real campaigns have
    // their own path (scheduleMarketingBlast). Broadcast keeps the opt-OUT model
    // it already ships: message_suppressions + the unsubscribe footer.
    expect(def!.marketingCategory).toBeUndefined();
  });

  it('always-enabled notifications cannot be kinfolkFacing', () => {
    // alwaysEnabled means user can't silence — hiding from UI is the right pair
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      if (def.alwaysEnabled && def.kinfolkFacing) {
        // Allow as long as there is at least one optional channel for the user
        // to express choice on; if every channel is required, UI exposure is misleading.
        const allRequired = def.allowedChannels.every((ch) => def.required[ch] === true);
        expect(allRequired, `${def.key}: alwaysEnabled + kinfolkFacing + every channel required → confusing UI`).toBe(
          false,
        );
      }
    }
  });
});

// Notification-audience revamp (2026-07): every key declares which audience
// STREAMS receive it (kinfolk / business / staff). The legacy `audience` field
// stays for enrichTemplateData + old clients; `audiences` is the new routing
// source of truth for stream-aware gating.
describe('NOTIFICATION_CATALOG audiences streams (audience revamp 2026-07)', () => {
  // Frozen taxonomy from the redesign contract. K=kinfolk, B=business, S=staff.
  const EXPECTED_AUDIENCES: Record<string, { kinfolk?: true; business?: true; staff?: true }> = {
    'kincare.booking.confirm': { kinfolk: true, business: true },
    'kincare.booking.cancel': { kinfolk: true, business: true },
    'kincare.auntie.on_my_way': { kinfolk: true },
    'kincare.auntie.arrived': { kinfolk: true },
    'kincare.auntie.departed': { kinfolk: true },
    // 'kincare.report.sent' was merged into 'kintale.published' on 2026-07-24
    // and is now an alias, not a row. See notificationKeyAliases.test.ts.
    'kincare.unavailable': { kinfolk: true },
    'kincare.requested': { business: true },
    'kincare.changed': { kinfolk: true, business: true },
    'kincare.note.kinfolk': { staff: true },
    // Vendor-parity additions (2026-07-02)
    'kincare.note.auntie': { business: true },
    'kincare.cancel.requested': { business: true },
    // #438: the answer to that ask, going the other way. Kinfolk-only; the
    // office made the decision and does not need a copy of its own reply.
    'kincare.cancel.declined': { kinfolk: true },
    'kincare.request.declined': { kinfolk: true },
    // #399 item 2: the kinfolk reschedule ask. Business-only, same as the
    // cancellation ask it mirrors: the household already knows what it asked for.
    'kincare.reschedule.requested': { business: true },
    'assignment.assigned': { staff: true },
    'assignment.changed': { staff: true },
    'message.received': { business: true },
    // #386: the office's broadcast out to a whole audience segment, the other
    // direction of message.received. Kinfolk-only; the operator wrote it, so
    // they do not need a copy of it back.
    'broadcast.message': { kinfolk: true },
    'kintale.published': { kinfolk: true },
    'kintale.comment.added': { kinfolk: true, staff: true },
    'kintale.note.added': { kinfolk: true },
    'invoice.new': { kinfolk: true, business: true },
    'invoice.updated': { kinfolk: true, business: true },
    'invoice.receipt': { kinfolk: true, business: true },
    'invoice.reminder': { kinfolk: true },
    'invoice.overdue': { kinfolk: true },
    'invoice.charge.failed': { kinfolk: true, business: true },
    'invoice.payment.applied': { kinfolk: true, business: true },
    // Business ONLY. A chargeback is the household's own bank acting on their
    // instruction, and the operator has not yet decided what the money does, so
    // there is nothing true to tell the household.
    'invoice.payment.disputed': { business: true },
    'quote.accepted': { kinfolk: true, business: true },
    'quote.denied': { business: true },
    'kincare.upcoming.reminder': { kinfolk: true },
    'schedule.upcoming.digest': { staff: true },
    'pets.updated': { kinfolk: true, staff: true },
    'profile.updated': { kinfolk: true, staff: true },
    'account.welcome.kinfolk': { kinfolk: true },
    // `account.welcome.business` was here. Retired 2026-08-18; this table is an
    // exact match against the catalog, so its absence is the assertion.
    'invite.expired': { business: true },
    'auth.password.reset': { kinfolk: true },
    'auth.failedLogin.attempts': { kinfolk: true },
    'auth.account.locked': { kinfolk: true },
    // #869: the operator's copy of a lockout, never the household's key.
    'security.account.locked.operator': { business: true },
    // #877: the operator's copy of the 5-failure warning, never the household's key.
    'security.failedLogin.attempts.operator': { business: true },
    'security.breach_attempt.kinfolk': { business: true },
    'rating.submitted.bad': { business: true },
    'rating.submitted.good': { business: true },
    'pet.marked.inactive': { business: true },
    'newsletter.announcement': { kinfolk: true },
    'survey.event': { kinfolk: true },
    'marketing.optin': { kinfolk: true },
  };

  it('matches the frozen taxonomy exactly (every key, no extras)', () => {
    expect(listNotificationKeys().sort()).toEqual(Object.keys(EXPECTED_AUDIENCES).sort());
    for (const [key, expected] of Object.entries(EXPECTED_AUDIENCES)) {
      expect(NOTIFICATION_CATALOG[key]!.audiences, `${key} audiences`).toEqual(expected);
    }
  });

  it('every key declares at least one audience stream', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      const streams = [def.audiences?.kinfolk, def.audiences?.business, def.audiences?.staff];
      expect(
        streams.filter((s) => s === true).length,
        `${def.key} must declare at least one audience stream`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('no key serves both business and staff (owner-hat and auntie-hat never share a key)', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      expect(
        def.audiences?.business === true && def.audiences?.staff === true,
        `${def.key} must not carry business AND staff`,
      ).toBe(false);
    }
  });

  it('any key dispatched to businessAdmins carries a business or staff audience', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      const resolvers = [def.recipientResolver, def.secondaryResolver];
      if (resolvers.includes('businessAdmins')) {
        expect(
          def.audiences?.business === true || def.audiences?.staff === true,
          `${def.key} resolves to businessAdmins but declares no business/staff audience`,
        ).toBe(true);
      }
    }
  });

  it('every key carries a human label that is not raw dev text', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      expect(def.label.trim().length, `${def.key} label must be set`).toBeGreaterThan(0);
      expect(def.label.length, `${def.key} label stays row-title sized`).toBeLessThanOrEqual(60);
      expect(def.label, `${def.key} label must not leak paths`).not.toMatch(/\/|\{\{|Channels:/);
    }
  });

  it('alwaysEnabledStreams is a subset of audiences and only set with alwaysEnabled', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      if (!def.alwaysEnabledStreams) continue;
      expect(def.alwaysEnabled, `${def.key} alwaysEnabledStreams requires alwaysEnabled`).toBe(true);
      for (const stream of ['kinfolk', 'business', 'staff'] as const) {
        if (def.alwaysEnabledStreams[stream] === true) {
          expect(
            def.audiences[stream] === true,
            `${def.key} alwaysEnabledStreams.${stream} must be a served audience`,
          ).toBe(true);
        }
      }
    }
  });

  it('alwaysEnabledForStream scopes the flat flag per stream', () => {
    const confirm = NOTIFICATION_CATALOG['kincare.booking.confirm']!;
    expect(alwaysEnabledForStream(confirm, 'kinfolk')).toBe(true);
    expect(alwaysEnabledForStream(confirm, 'business')).toBe(false);
    const security = NOTIFICATION_CATALOG['security.breach_attempt.kinfolk']!;
    expect(alwaysEnabledForStream(security, 'business')).toBe(true);
    const requested = NOTIFICATION_CATALOG['kincare.requested']!;
    expect(alwaysEnabledForStream(requested, 'business')).toBe(false);
  });

  it('any key resolved via kinfolkAcct carries the kinfolk audience', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      const resolvers = [def.recipientResolver, def.secondaryResolver];
      if (resolvers.includes('kinfolkAcct')) {
        expect(
          def.audiences?.kinfolk === true,
          `${def.key} resolves to kinfolkAcct but lacks the kinfolk audience`,
        ).toBe(true);
      }
    }
  });
});
