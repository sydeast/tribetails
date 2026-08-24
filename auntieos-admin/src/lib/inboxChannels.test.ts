import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CHANNEL_FILTERS,
  PREVIEW_MAX,
  awaitingReplyCount,
  callDuration,
  callEntry,
  callOutcome,
  channelDirection,
  emailEntry,
  entryLaunchers,
  entryMachineWhen,
  entryTitle,
  entryWhen,
  filterChannelEntries,
  mergeChannelEntries,
  smsEntry,
  voicemailEntry,
  voicemailReplyState,
  type InboxEntry,
} from './inboxChannels';
import type { CallRow, EmailRow, SmsRow, VoicemailRow } from '../api/inboxChannels';

// Pinned west of UTC so the local-time assertions below are meaningful on any
// runner (the same rationale as inboxFormat.test.ts / Sessions.test.tsx).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'e1',
    channel: 'sms',
    timestamp: '2026-07-20T14:00:00.000Z',
    kinfolkName: 'The Alvarez Household',
    counterpart: '+15551234567',
    preview: 'On my way',
    direction: 'inbound',
    statusHint: '',
    mediaCount: 0,
    replyPhone: '+15551234567',
    replyEmail: '',
    kinfolkId: 'kf1',
    playbackUrl: '',
    voicemailId: '',
    ...over,
  };
}

describe('CHANNEL_FILTERS', () => {
  it('mirrors the Android Channel enum, in the same order', () => {
    expect(CHANNEL_FILTERS.map((f) => f.key)).toEqual(['all', 'voicemail', 'call', 'sms', 'email']);
  });

  /**
   * The Messages section on the same screen has an "All" tab. Two controls
   * sharing one accessible name is a real navigation defect, not a test
   * convenience, so the distinct label is pinned here.
   */
  it('labels its own catch-all "All channels", never colliding with the Messages "All" tab', () => {
    expect(CHANNEL_FILTERS[0]?.label).toBe('All channels');
  });
});

describe('channelDirection', () => {
  it('matches the two real values positively', () => {
    expect(channelDirection('inbound')).toBe('inbound');
    expect(channelDirection('outbound')).toBe('outbound');
  });

  it('normalizes casing and padding IN MEMORY, since no writer enforces either', () => {
    expect(channelDirection('  Inbound ')).toBe('inbound');
    expect(channelDirection('OUTBOUND')).toBe('outbound');
  });

  it('reports unknown rather than guessing, for a missing or unrecognized value', () => {
    expect(channelDirection(undefined)).toBe('unknown');
    expect(channelDirection(null)).toBe('unknown');
    expect(channelDirection('')).toBe('unknown');
    expect(channelDirection('sideways')).toBe('unknown');
  });
});

describe('voicemailReplyState', () => {
  it('matches each stored state positively, casing normalized in memory', () => {
    expect(voicemailReplyState('unread')).toBe('unread');
    expect(voicemailReplyState('Read')).toBe('read');
    expect(voicemailReplyState(' REPLIED ')).toBe('replied');
    expect(voicemailReplyState('dismissed')).toBe('dismissed');
  });

  it('reads a MISSING replyStatus as unknown, not as unread', () => {
    // A legacy voicemail written before the field existed must not be counted
    // as work waiting on the operator.
    expect(voicemailReplyState(undefined)).toBe('unknown');
    expect(voicemailReplyState('')).toBe('unknown');
  });
});

describe('callOutcome', () => {
  it('folds Twilio CallStatus values onto the outcomes the row renders', () => {
    expect(callOutcome('completed')).toBe('answered');
    expect(callOutcome('no-answer')).toBe('missed');
    expect(callOutcome('busy')).toBe('declined');
    expect(callOutcome('voicemail')).toBe('voicemail');
  });

  it('normalizes casing, the trap a server equality would fall into', () => {
    // `where('status','==','missed')` would silently drop this row, and a
    // dropped row here is a call the operator never learns about.
    expect(callOutcome('Missed')).toBe('missed');
  });

  it('reports unknown for anything it does not recognize', () => {
    expect(callOutcome('queued')).toBe('unknown');
    expect(callOutcome(undefined)).toBe('unknown');
  });
});

describe('callDuration', () => {
  it('renders seconds under a minute and m/s above it', () => {
    expect(callDuration(45)).toBe('45s');
    expect(callDuration(90)).toBe('1m 30s');
    expect(callDuration(3600)).toBe('60m 0s');
  });

  it('treats a missing, negative or non-finite duration as zero seconds', () => {
    expect(callDuration(undefined)).toBe('0s');
    expect(callDuration(-5)).toBe('0s');
    expect(callDuration(Number.NaN)).toBe('0s');
  });
});

describe('voicemailEntry', () => {
  it('maps a full voicemail onto the unified row', () => {
    const row: VoicemailRow = {
      _id: 'vm1',
      kinfolkId: 'kf1',
      kinfolkName: 'The Alvarez Household',
      callerNumber: '+15551234567',
      transcript: 'Hi Auntie, can you come Thursday?',
      audioUrl: 'https://api.twilio.com/rec1',
      timestamp: '2026-07-20T14:00:00.000Z',
      replyStatus: 'unread',
    };
    const e = voicemailEntry(row);
    expect(e).toMatchObject({
      id: 'vm1',
      channel: 'voicemail',
      counterpart: '+15551234567',
      preview: 'Hi Auntie, can you come Thursday?',
      direction: 'inbound',
      statusHint: 'unread',
      replyPhone: '+15551234567',
      playbackUrl: 'https://api.twilio.com/rec1',
      voicemailId: 'vm1',
    });
  });

  it('says a recording has no transcript yet rather than rendering a blank line', () => {
    expect(voicemailEntry({ _id: 'vm2' }).preview).toBe('(no transcript yet)');
  });

  it('reads a null kinfolkId as blank, the value the webhook writes on a no-match', () => {
    // twilioInboundVoicemail writes a literal null when the caller matches no
    // household, which is the common case for a first-time caller.
    expect(voicemailEntry({ _id: 'vm3', kinfolkId: null }).kinfolkId).toBe('');
  });

  it('flags replied, unread and dismissed distinctly, and none of them for a read voicemail', () => {
    expect(voicemailEntry({ _id: 'a', replyStatus: 'replied' }).statusHint).toBe('replied');
    expect(voicemailEntry({ _id: 'b', replyStatus: 'read' }).statusHint).toBe('');
    expect(voicemailEntry({ _id: 'c' }).statusHint).toBe('');
    // Carried, not flattened: a dismissed voicemail nobody can distinguish from
    // a read one is indistinguishable from one nobody has touched, and this is
    // also what gates the Dismiss action off in ThreadActionsCard.
    expect(voicemailEntry({ _id: 'd', replyStatus: 'dismissed' }).statusHint).toBe('dismissed');
    expect(voicemailEntry({ _id: 'e', replyStatus: 'DISMISSED' }).statusHint).toBe('dismissed');
  });

  it('leaves a dismissed voicemail out of the waiting-on-a-reply count', () => {
    // The whole point of the state: it is a way OFF the operator's queue that
    // does not have to pretend somebody listened.
    expect(
      awaitingReplyCount([
        { _id: 'a', replyStatus: 'unread' },
        { _id: 'b', replyStatus: 'dismissed' },
      ]),
    ).toBe(1);
  });

  it('truncates an over-long transcript with an ellipsis', () => {
    const long = 'x'.repeat(PREVIEW_MAX + 40);
    const p = voicemailEntry({ _id: 'vm4', transcript: long }).preview;
    expect(p.endsWith('…')).toBe(true);
    expect(p.length).toBeLessThanOrEqual(PREVIEW_MAX + 1);
  });
});

describe('callEntry', () => {
  it('prefers a transcript when there is one', () => {
    const row: CallRow = { _id: 'c1', transcript: 'Left a note about the gate code', status: 'completed' };
    expect(callEntry(row).preview).toBe('Left a note about the gate code');
  });

  it('describes the outcome when there is no transcript', () => {
    expect(callEntry({ _id: 'c2', status: 'missed' }).preview).toBe('Missed call');
    expect(callEntry({ _id: 'c3', status: 'voicemail' }).preview).toBe('Left a voicemail');
    expect(callEntry({ _id: 'c4', status: 'completed', durationSec: 75 }).preview).toBe('Call (1m 15s)');
  });

  it('prints an unrecognized status verbatim rather than inventing a bucket', () => {
    expect(callEntry({ _id: 'c5', status: 'queued' }).preview).toBe('Call · queued');
  });

  it('says just "Call" when there is no transcript and no status at all', () => {
    expect(callEntry({ _id: 'c6' }).preview).toBe('Call');
  });

  it('flags only a missed call', () => {
    expect(callEntry({ _id: 'c7', status: 'MISSED' }).statusHint).toBe('missed');
    expect(callEntry({ _id: 'c8', status: 'completed' }).statusHint).toBe('');
  });
});

describe('smsEntry', () => {
  it('counts attachments from mediaUrls and survives the field being absent', () => {
    expect(smsEntry({ _id: 's1', mediaUrls: ['a', 'b'] }).mediaCount).toBe(2);
    expect(smsEntry({ _id: 's2' }).mediaCount).toBe(0);
    // A malformed row (wrong type) must not throw inside a render.
    expect(smsEntry({ _id: 's3', mediaUrls: 'nope' as unknown as string[] }).mediaCount).toBe(0);
  });
});

describe('emailEntry', () => {
  it('shows the recipient on an outbound email and the sender on an inbound one', () => {
    expect(
      emailEntry({ _id: 'm1', direction: 'outbound', toAddresses: ['them@example.com'], fromAddress: 'us@example.com' })
        .counterpart,
    ).toBe('them@example.com');
    expect(
      emailEntry({ _id: 'm2', direction: 'inbound', fromAddress: 'them@example.com' }).counterpart,
    ).toBe('them@example.com');
  });

  it('falls back to the sender when the direction is unknown', () => {
    expect(emailEntry({ _id: 'm3', fromAddress: 'them@example.com' }).counterpart).toBe(
      'them@example.com',
    );
  });

  it('joins subject and body, dropping either half that is missing', () => {
    expect(emailEntry({ _id: 'm4', subject: 'Thursday', body: 'Does 9am work?' }).preview).toBe(
      'Thursday · Does 9am work?',
    );
    expect(emailEntry({ _id: 'm5', body: 'Does 9am work?' }).preview).toBe('Does 9am work?');
    expect(emailEntry({ _id: 'm6', subject: 'Thursday' }).preview).toBe('Thursday');
  });
});

describe('mergeChannelEntries', () => {
  it('interleaves the four streams newest first', () => {
    const merged = mergeChannelEntries([
      [entry({ id: 'a', channel: 'voicemail', timestamp: '2026-07-20T10:00:00.000Z' })],
      [entry({ id: 'b', channel: 'call', timestamp: '2026-07-20T12:00:00.000Z' })],
      [entry({ id: 'c', channel: 'sms', timestamp: '2026-07-20T11:00:00.000Z' })],
      [entry({ id: 'd', channel: 'email', timestamp: '2026-07-20T13:00:00.000Z' })],
    ]);
    expect(merged.map((e) => e.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('sorts an UNDATED row last instead of dropping it', () => {
    // Unlike latestCommunication in lib/recipientContext.ts, which must name one
    // newest message, this list shows everything: an undated voicemail is still
    // a voicemail somebody left.
    const merged = mergeChannelEntries([
      [entry({ id: 'undated', timestamp: '' })],
      [entry({ id: 'dated', timestamp: '2026-07-20T10:00:00.000Z' })],
    ]);
    expect(merged.map((e) => e.id)).toEqual(['dated', 'undated']);
  });

  it('breaks ties on id so four independent snapshots cannot reshuffle the list', () => {
    const merged = mergeChannelEntries([
      [entry({ id: 'zz', timestamp: '2026-07-20T10:00:00.000Z' })],
      [entry({ id: 'aa', timestamp: '2026-07-20T10:00:00.000Z' })],
    ]);
    expect(merged.map((e) => e.id)).toEqual(['aa', 'zz']);
  });

  it('does not mutate the input arrays', () => {
    const one = [entry({ id: 'a', timestamp: '2026-07-20T10:00:00.000Z' })];
    const two = [entry({ id: 'b', timestamp: '2026-07-20T12:00:00.000Z' })];
    mergeChannelEntries([one, two]);
    expect(one.map((e) => e.id)).toEqual(['a']);
    expect(two.map((e) => e.id)).toEqual(['b']);
  });

  it('is empty for four empty streams', () => {
    expect(mergeChannelEntries([[], [], [], []])).toEqual([]);
  });
});

describe('filterChannelEntries', () => {
  const rows = [
    entry({ id: 'v', channel: 'voicemail' }),
    entry({ id: 'c', channel: 'call' }),
    entry({ id: 's', channel: 'sms' }),
    entry({ id: 'm', channel: 'email' }),
  ];

  it('returns everything under "all"', () => {
    expect(filterChannelEntries(rows, 'all').map((e) => e.id)).toEqual(['v', 'c', 's', 'm']);
  });

  it('is a positive membership test per channel, never a negation of the others', () => {
    expect(filterChannelEntries(rows, 'voicemail').map((e) => e.id)).toEqual(['v']);
    expect(filterChannelEntries(rows, 'email').map((e) => e.id)).toEqual(['m']);
  });

  it('is empty for a channel with no rows, rather than falling back to everything', () => {
    expect(filterChannelEntries([entry({ channel: 'sms' })], 'call')).toEqual([]);
  });
});

describe('awaitingReplyCount', () => {
  it('counts only voicemails that really say unread', () => {
    const rows: VoicemailRow[] = [
      { _id: '1', replyStatus: 'unread' },
      { _id: '2', replyStatus: 'UNREAD' },
      { _id: '3', replyStatus: 'read' },
      { _id: '4', replyStatus: 'replied' },
      { _id: '5' },
    ];
    expect(awaitingReplyCount(rows)).toBe(2);
  });

  it('is 0, not null, for a genuinely empty voicemail list', () => {
    expect(awaitingReplyCount([])).toBe(0);
  });
});

describe('entryTitle', () => {
  it('leads with the household when one matched', () => {
    expect(entryTitle(entry({ kinfolkName: 'The Alvarez Household' }))).toBe('The Alvarez Household');
  });

  it('falls back to the raw contact when no household matched', () => {
    expect(entryTitle(entry({ kinfolkName: '', counterpart: '+15551234567' }))).toBe('+15551234567');
  });

  it('says so honestly when there is neither', () => {
    expect(entryTitle(entry({ kinfolkName: '', counterpart: '' }))).toBe('Unknown contact');
  });
});

describe('entryWhen / entryMachineWhen', () => {
  it('renders the LOCAL clock, not the UTC one', () => {
    // 2026-07-20T14:00Z is 09:00 in America/Chicago (CDT).
    expect(entryWhen('2026-07-20T14:00:00.000Z')).toBe('07-20 09:00');
    expect(entryMachineWhen('2026-07-20T14:00:00.000Z')).toBe('2026-07-20T09:00');
  });

  it('degrades honestly for a row with no timestamp', () => {
    expect(entryWhen('')).toBe('(no time)');
    expect(entryMachineWhen('')).toBeUndefined();
  });
});

describe('entryLaunchers', () => {
  it('offers tel and sms for a row with a phone number', () => {
    const l = entryLaunchers(entry({ replyPhone: '+15551234567', replyEmail: '' }));
    expect(l.tel).toBe('tel:%2B15551234567');
    expect(l.sms).toBe('sms:%2B15551234567');
    expect(l.mailto).toBeNull();
  });

  it('offers mailto for an email row and refuses to fake a phone launcher', () => {
    const l = entryLaunchers(entry({ channel: 'email', replyPhone: '', replyEmail: 'them@example.com' }));
    expect(l.mailto).toBe('mailto:them%40example.com');
    expect(l.tel).toBeNull();
    expect(l.sms).toBeNull();
  });

  it('encodes an untrusted counterpart rather than letting it change the URL', () => {
    const l = entryLaunchers(entry({ replyPhone: '+1 555 123 4567' }));
    expect(l.tel).toBe('tel:%2B1%20555%20123%204567');
  });

  it('returns null, never a "#" href, when a row has nothing to launch', () => {
    const l = entryLaunchers(entry({ replyPhone: '', replyEmail: '' }));
    expect(l).toEqual({ tel: null, sms: null, mailto: null });
  });
});

describe('the channel row shapes, read defensively', () => {
  /**
   * Every *Row interface is a CAST over Firestore data, not a validation of it.
   * A legacy document missing every optional field must not throw inside a
   * render (the lib/coerce.ts rationale, verified live on Invoices and
   * Bookings).
   */
  it('maps a document carrying nothing but an id, on all four channels', () => {
    expect(() => voicemailEntry({ _id: 'v' } as VoicemailRow)).not.toThrow();
    expect(() => callEntry({ _id: 'c' } as CallRow)).not.toThrow();
    expect(() => smsEntry({ _id: 's' } as SmsRow)).not.toThrow();
    expect(() => emailEntry({ _id: 'm' } as EmailRow)).not.toThrow();
    expect(voicemailEntry({ _id: 'v' }).timestamp).toBe('');
  });
});
