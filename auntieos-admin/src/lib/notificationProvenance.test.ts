import { describe, it, expect } from 'vitest';
import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  type NotificationCatalogEntry,
} from '../api/myNotifications';
import type { BusinessAdminRoster } from '../api/businessAdmins';
import {
  MEANT_TO_STAY_ON,
  OFF_AND_MEANT_TO_STAY_ON,
  alwaysOnBadge,
  businessAdminLines,
  businessEmailLine,
  businessAdminSourceNote,
  deliveryPhrase,
  deliveryRecipient,
  fieldWords,
  hasPartialDataNote,
  mergeFieldNames,
  reachesBusinessAdmins,
  recipientLines,
  rowBadges,
  templateLines,
} from './notificationProvenance';

function entry(over: Partial<NotificationCatalogEntry> = {}): NotificationCatalogEntry {
  return {
    key: 'invoice.new',
    label: 'New invoice',
    category: 'invoice',
    audience: 'both',
    audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]),
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    alwaysEnabledStreams: new Set(),
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    description: '',
    whoReceives: [],
    recipientResolver: 'kinfolkAcct',
    emitters: [],
    neverFires: false,
    templates: {},
    mergeFields: [],
    external: false,
    ...over,
  };
}

/**
 * The "Always on" caption was a lie, and this suite is what stops it coming
 * back. Nothing in `resolveChannels` checks `alwaysEnabled` — ruling #7,
 * 2026-06-08, warn-but-allow-off — so 14 catalog rows, password reset among
 * them, could be switched off from a screen that captioned them as protected.
 */
describe('alwaysOnBadge tells the truth about alwaysEnabled', () => {
  const critical = entry({ alwaysEnabled: true });

  it('says nothing at all on a row without the flag', () => {
    expect(alwaysOnBadge(entry(), STREAM_BUSINESS, true)).toBeNull();
  });

  it('never uses the words "always on", which the platform does not deliver', () => {
    const badge = alwaysOnBadge(critical, STREAM_BUSINESS, true);
    expect(badge).not.toBeNull();
    expect(badge!.label.toLowerCase()).not.toBe('always on');
    expect(`${badge!.label} ${badge!.detail}`.toLowerCase()).toContain('you can switch it off');
  });

  it('escalates to a warning once the row is actually switched off', () => {
    const on = alwaysOnBadge(critical, STREAM_BUSINESS, true);
    const off = alwaysOnBadge(critical, STREAM_BUSINESS, false);
    expect(on!.tone).toBe('info');
    expect(off!.tone).toBe('warn');
    expect(off!.detail).toContain('not sent to anyone');
  });

  /**
   * #451: the gate, the Android gate, and the operator's own prefs screen all
   * render the advisory flag from these two constants, so a wording change on
   * one surface can never leave the others saying something else. Neither may
   * be "Required" or "Always on", which are promises the flag cannot keep.
   */
  it('renders from the one shared vocabulary, which promises nothing', () => {
    expect(alwaysOnBadge(critical, STREAM_BUSINESS, true)!.label).toBe(MEANT_TO_STAY_ON);
    expect(alwaysOnBadge(critical, STREAM_BUSINESS, false)!.label).toBe(OFF_AND_MEANT_TO_STAY_ON);
    for (const label of [MEANT_TO_STAY_ON, OFF_AND_MEANT_TO_STAY_ON]) {
      expect(label.toLowerCase()).not.toContain('required');
      expect(label.toLowerCase()).not.toContain('always on');
    }
  });
  it('respects alwaysEnabledStreams, so a per-stream flag stays per-stream', () => {
    const scoped = entry({ alwaysEnabled: true, alwaysEnabledStreams: new Set([STREAM_KINFOLK]) });
    expect(alwaysOnBadge(scoped, STREAM_KINFOLK, true)).not.toBeNull();
    expect(alwaysOnBadge(scoped, STREAM_BUSINESS, true)).toBeNull();
  });
});

describe('rowBadges surfaces the rest of the risk', () => {
  it('marks a row nothing fires', () => {
    const badges = rowBadges(entry({ neverFires: true }), STREAM_BUSINESS, true);
    expect(badges.map((b) => b.label)).toContain('Never fires');
    expect(badges.find((b) => b.label === 'Never fires')?.tone).toBe('warn');
  });

  it('marks a row an outside system delivers', () => {
    const badges = rowBadges(entry({ external: true }), STREAM_BUSINESS, true);
    expect(badges.map((b) => b.label)).toContain('Sent directly');
  });

  it('marks marketing, and says the opt-in is not overridable', () => {
    const badges = rowBadges(entry({ marketingCategory: 'newsletter' }), STREAM_BUSINESS, true);
    const marketing = badges.find((b) => b.label === 'Marketing');
    expect(marketing?.detail).toContain('opted in');
  });

  it('gives a plain row no badges at all', () => {
    expect(rowBadges(entry(), STREAM_BUSINESS, true)).toEqual([]);
  });
});

describe('recipientLines answers "how many people is that"', () => {
  const businessRow = entry({
    whoReceives: ['Every business admin on the roster, one copy each.'],
  });

  it('appends the live roster size', () => {
    const [line] = recipientLines(businessRow, 3);
    expect(line).toContain('3 people');
  });

  it('says one person, not one people', () => {
    const [line] = recipientLines(businessRow, 1);
    expect(line).toContain('1 person');
  });

  it('reports an unreadable roster as unknown, never as zero', () => {
    const [line] = recipientLines(businessRow, null);
    expect(line).toContain('unknown');
    expect(line).not.toContain('0 people');
    // #1592: no database path in the sentence.
    expect(line).not.toContain('businessSettings');
  });

  it('says where an empty roster actually sends instead', () => {
    const [line] = recipientLines(businessRow, 0);
    expect(line).toContain('operator allowlist');
  });

  it('leaves a household sentence alone', () => {
    const row = entry({ whoReceives: ["The household's own portal account."] });
    expect(recipientLines(row, 3)).toEqual(["The household's own portal account."]);
  });
});

/**
 * Issue #450. "Every business admin" plus a count and a Firestore path was the
 * one audience the gate could not turn into people.
 */
describe('the business admin roster, resolved to people', () => {
  function roster(over: Partial<BusinessAdminRoster> = {}): BusinessAdminRoster {
    return {
      members: [],
      source: 'roster',
      rosterPath: 'businessSettings/admins.uids',
      reason: null,
      businessEmail: 'pawsome@hanasamku.com',
      ...over,
    };
  }
  function member(over: Partial<BusinessAdminRoster['members'][number]> = {}) {
    return {
      uid: 'op1',
      displayName: 'Auntie Nora',
      email: 'nora@tribetails.com',
      hasStaffRecord: true,
      defaultAssignee: false,
      ...over,
    };
  }
  it('offers the roster for a row whose primary resolver is businessAdmins', () => {
    expect(reachesBusinessAdmins(entry({ recipientResolver: 'businessAdmins' }))).toBe(true);
  });
  it('offers it for a SECONDARY businessAdmins resolver too', () => {
    expect(
      reachesBusinessAdmins(entry({ recipientResolver: 'kinfolkAcct', secondaryResolver: 'businessAdmins' })),
    ).toBe(true);
  });
  it('does not offer it for a row that never reaches business admins', () => {
    expect(reachesBusinessAdmins(entry({ recipientResolver: 'kinfolkAcct' }))).toBe(false);
  });
  it('names each person, and not their own email (#1564: business email goes to businessEmail)', () => {
    const [line] = businessAdminLines(roster({ members: [member()] }));
    expect(line).toBe('Auntie Nora');
    expect(line).not.toContain('nora@tribetails.com');
  });
  it('#1564: says business emails go to the business contact email', () => {
    expect(businessEmailLine(roster())).toBe('Emails go to the business email, pawsome@hanasamku.com.');
  });
  it('#1564: says business emails have nowhere to go while businessEmail is blank', () => {
    const line = businessEmailLine(roster({ businessEmail: '' }));
    expect(line).toContain('nowhere to go');
    expect(line).toContain('Settings > Business');
  });
  it('#1564: words the business_email_unset skip', () => {
    expect(deliveryPhrase('skipped', 'business_email_unset', null).detail).toContain('business email in Settings > Business was blank');
  });
  it('says which of them unassigned visits default to', () => {
    const [line] = businessAdminLines(roster({ members: [member({ defaultAssignee: true })] }));
    expect(line).toContain('unassigned visits default to them');
  });
  /**
   * An allowlist-seeded operator has no staff doc and therefore no name. They
   * receive every business notification anyway, so the line shows the uid and
   * says why there is nothing better to show.
   */
  it('falls back to the uid when there is no staff record to name', () => {
    const [line] = businessAdminLines(
      roster({ members: [member({ uid: 'op8', displayName: null, email: null, hasStaffRecord: false })] }),
    );
    expect(line).toContain('op8');
    expect(line).toContain('no staff record');
    expect(line).not.toContain('no email on file');
  });
  it('warns when the list is the allowlist fallback rather than the stored roster', () => {
    const note = businessAdminSourceNote(roster({ source: 'operatorAllowlist', members: [member()] }));
    expect(note).toContain('roster is empty');
    // #1592: no database path and no function name in operator copy.
    expect(note).not.toContain('businessSettings');
    expect(note).not.toContain('provisionBusinessAdmins');
  });
  it('adds no caveat when the stored roster answered', () => {
    expect(businessAdminSourceNote(roster({ members: [member()] }))).toBeNull();
  });
});
describe('templateLines names the document that writes each body', () => {
  it('names the template per channel in words, never a database path (#1592)', () => {
    const row = entry({
      allowedChannels: ['email', 'sms'],
      templates: { email: 'invoice.new', sms: 'invoice.reminder' },
    });
    expect(templateLines(row)).toEqual([
      // The row's own template carries the row's own name.
      { channel: 'email', name: 'New invoice', missing: false },
      { channel: 'sms', name: 'Invoice reminder', missing: false },
    ]);
  });

  it('flags a channel offered with nothing to render it', () => {
    const row = entry({ allowedChannels: ['email', 'push'], templates: { email: 'invoice.new' } });
    expect(templateLines(row).find((l) => l.channel === 'push')?.missing).toBe(true);
  });

  /**
   * The gate can retarget an email as data, with no deploy. Showing the new id
   * without saying it moved reads as though the catalog default were still in
   * play, which is the confident-but-wrong answer this whole surface exists to
   * stop. SMS and push consult no bindings, so they must never carry the note.
   */
  it('says when email has been retargeted off the catalog default', () => {
    const row = entry({
      allowedChannels: ['email', 'sms'],
      templates: { email: 'invoice.new.v2', sms: 'invoice.new' },
      emailTemplateRetargetedFrom: 'invoice.new',
    });
    const lines = templateLines(row);
    expect(lines[0]).toEqual({
      channel: 'email',
      name: 'Invoice new v2',
      missing: false,
      retargetedFrom: 'New invoice',
    });
    expect(lines[1]?.retargetedFrom).toBeUndefined();
  });
  it('says nothing about retargeting on an untouched row', () => {
    const row = entry({ allowedChannels: ['email'], templates: { email: 'invoice.new' } });
    expect(templateLines(row)[0]?.retargetedFrom).toBeUndefined();
  });
  it('never invents a line for a channel the row does not offer', () => {
    const row = entry({ allowedChannels: ['email'], templates: { email: 'a', sms: 'b' } });
    expect(templateLines(row).map((l) => l.channel)).toEqual(['email']);
  });
});

describe('mergeFieldNames merges the two halves of the leak surface', () => {
  it('unions the server merge fields with every emitter data key', () => {
    const row = entry({
      mergeFields: ['amount', 'kinfolkName'],
      emitters: [
        { trigger: 'x', source: 'src/a.ts', dataKeys: ['invoiceId', 'amount'] },
        { trigger: 'y', source: 'src/b.ts', dataKeys: ['stripeEventId'] },
      ],
    });
    // #1592: in words, not keys. No server labels here, so the client splits them.
    expect(mergeFieldNames(row)).toEqual([
      'Amount',
      'Invoice reference',
      'Kinfolk name',
      'Stripe event reference',
    ]);
  });
  it('#1592: uses the server words when it sends them, and folds two keys that mean one thing', () => {
    const row = entry({
      mergeFields: ['Business', 'business', 'ip'],
      emitters: [{ trigger: 'x', source: 'src/a.ts', dataKeys: ['startTimeMsList'] }],
      mergeFieldLabels: {
        Business: 'Business name',
        business: 'Business name',
        ip: 'Sign-in IP address',
      },
    });
    expect(mergeFieldNames(row)).toEqual(['Business name', 'Sign-in IP address', 'Start time']);
  });

  it('reports when an emitter admits the list is incomplete', () => {
    expect(hasPartialDataNote(entry())).toBe(false);
    const row = entry({
      emitters: [
        { trigger: 'x', source: 'src/a.ts', dataKeys: ['audienceUid'], dataNote: 'Plus more.' },
      ],
    });
    expect(hasPartialDataNote(row)).toBe(true);
  });
});

/**
 * The delivery pipeline records "the provider accepted this". No webhook in
 * this repo ever writes a receipt back to a notification's channel subdoc, so
 * a green "Delivered" here would be a guess printed as a fact.
 */
describe('fieldWords and deliveryRecipient (#1592)', () => {
  it('splits a key the server sent no words for', () => {
    expect(fieldWords('startTimeMs')).toBe('Start time');
    expect(fieldWords('nextVisit.date')).toBe('Next visit date');
    expect(fieldWords('kinfolkId')).toBe('Kinfolk reference');
    expect(fieldWords('portalUrl')).toBe('Portal link');
  });
  it('names the recipient, and keeps the uid only when nobody answers to it', () => {
    expect(deliveryRecipient({ recipientName: 'Dre East', recipientUid: 'kin1' })).toBe('Dre East');
    expect(deliveryRecipient({ recipientName: null, recipientUid: 'ghost' })).toBe('ghost');
    expect(deliveryRecipient({ recipientName: null, recipientUid: '' })).toBe('an unknown recipient');
  });
});
describe('deliveryPhrase never promises a delivery it cannot prove', () => {
  it('calls a successful send handed over, not delivered', () => {
    const phrase = deliveryPhrase('sent', null, null);
    expect(phrase.label.toLowerCase()).not.toContain('delivered');
    expect(phrase.detail).toContain('not proof it arrived');
  });

  it('carries the skip reason, in words (#1592)', () => {
    expect(deliveryPhrase('skipped', 'no-email-on-file', null).detail).toContain('no email on file');
    expect(deliveryPhrase('skipped', 'recipient_no_phone', null).detail).toBe(
      'Not sent on this channel: the recipient has no phone number on file.',
    );
    for (const code of [
      'recipient_no_email',
      'recipient_no_phone',
      'recipient_hard_bounced',
      'template_missing',
      'template_text_empty',
      'unknown',
    ]) {
      expect(deliveryPhrase('skipped', code, null).detail).not.toContain(code);
    }
  });

  it('carries the failure text', () => {
    expect(deliveryPhrase('failed', null, 'Twilio 21610').detail).toContain('Twilio 21610');
  });

  it('says so when a skip or failure recorded no reason at all', () => {
    expect(deliveryPhrase('skipped', null, null).detail).toContain('no reason was recorded');
    expect(deliveryPhrase('failed', null, null).detail).toContain('no message recorded');
  });

  it('reports a statusless record as unknown rather than assuming it went', () => {
    const phrase = deliveryPhrase('', null, null);
    expect(phrase.label).toBe('Unknown');
    expect(phrase.tone).toBe('warn');
  });

  it('treats pending as waiting, not as a failure', () => {
    expect(deliveryPhrase('pending', null, null).tone).toBe('neutral');
  });
});
