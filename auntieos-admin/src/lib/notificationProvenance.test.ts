import { describe, it, expect } from 'vitest';
import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  type NotificationCatalogEntry,
} from '../api/myNotifications';
import {
  alwaysOnBadge,
  deliveryPhrase,
  hasPartialDataNote,
  mergeFieldNames,
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
    expect(badges.map((b) => b.label)).toContain('Sent by another system');
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
    const [line] = recipientLines(businessRow, 3, 'businessSettings/admins.uids');
    expect(line).toContain('3 people');
  });

  it('says one person, not one people', () => {
    const [line] = recipientLines(businessRow, 1, 'businessSettings/admins.uids');
    expect(line).toContain('1 person');
  });

  it('reports an unreadable roster as unknown, never as zero', () => {
    const [line] = recipientLines(businessRow, null, 'businessSettings/admins.uids');
    expect(line).toContain('unknown');
    expect(line).not.toContain('0 people');
  });

  it('says where an empty roster actually sends instead', () => {
    const [line] = recipientLines(businessRow, 0, 'businessSettings/admins.uids');
    expect(line).toContain('operator allowlist');
  });

  it('leaves a household sentence alone', () => {
    const row = entry({ whoReceives: ["The household's own portal account."] });
    expect(recipientLines(row, 3, 'x')).toEqual(["The household's own portal account."]);
  });
});

describe('templateLines names the document that writes each body', () => {
  it('builds the collection path per channel', () => {
    const row = entry({
      allowedChannels: ['email', 'sms'],
      templates: { email: 'invoice.new', sms: 'invoice.new' },
    });
    expect(templateLines(row)).toEqual([
      { channel: 'email', path: 'emailTemplates/invoice.new', missing: false },
      { channel: 'sms', path: 'smsTemplates/invoice.new', missing: false },
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
      path: 'emailTemplates/invoice.new.v2',
      missing: false,
      retargetedFrom: 'invoice.new',
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
    expect(mergeFieldNames(row)).toEqual(['amount', 'invoiceId', 'kinfolkName', 'stripeEventId']);
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
describe('deliveryPhrase never promises a delivery it cannot prove', () => {
  it('calls a successful send handed over, not delivered', () => {
    const phrase = deliveryPhrase('sent', null, null);
    expect(phrase.label.toLowerCase()).not.toContain('delivered');
    expect(phrase.detail).toContain('not proof it arrived');
  });

  it('carries the skip reason', () => {
    expect(deliveryPhrase('skipped', 'no-email-on-file', null).detail).toContain('no-email-on-file');
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
