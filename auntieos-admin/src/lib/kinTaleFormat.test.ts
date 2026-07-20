import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  bodyPreview,
  kinTaleDayKey,
  kinTaleHeadline,
  kinTaleHousehold,
  kinTaleState,
  kinTaleStateInfo,
  kinTaleTimeOf,
  kinTaleWhen,
  sentViaLabel,
  type KinTaleWhenInput,
} from './kinTaleFormat';

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are
// meaningful on any CI runner (the identical rationale as
// lib/sessionFormat.test.ts). Restored afterAll for any sibling test file
// sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function whenInput(over: Partial<KinTaleWhenInput>): KinTaleWhenInput {
  return { visitDate: '', arrivedAt: '', sentAt: '', createdAt: '', ...over };
}

describe('kinTaleTimeOf / kinTaleDayKey (AO-18: local, never a raw UTC slice)', () => {
  it('returns null for a blank or unparseable string, never a fabricated date', () => {
    expect(kinTaleTimeOf('')).toBeNull();
    expect(kinTaleTimeOf('   ')).toBeNull();
    expect(kinTaleTimeOf('not-a-date')).toBeNull();
  });

  it('groups a late-evening local instant under its LOCAL day, not the UTC-next day', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant, mirroring `nowIsoUtc()`'s write shape.
    expect(kinTaleDayKey('2026-07-17T01:00:00.000Z')).toBe('2026-07-16');
  });

  it("'Undated' for a blank field, never folded into today's group", () => {
    expect(kinTaleDayKey('')).toBe('Undated');
  });
});

describe('kinTaleWhen (visitDate > arrivedAt > sentAt > createdAt precedence)', () => {
  it('prefers visitDate when present', () => {
    const w = whenInput({
      visitDate: '2026-07-16T14:00:00.000Z',
      arrivedAt: '2026-07-16T15:00:00.000Z',
      sentAt: '2026-07-16T16:00:00.000Z',
      createdAt: '2026-07-16T17:00:00.000Z',
    });
    expect(kinTaleWhen(w)).toBe('07-16 09:00');
  });

  it('falls back to arrivedAt, then sentAt, then createdAt, in order', () => {
    expect(kinTaleWhen(whenInput({ arrivedAt: '2026-07-16T15:00:00.000Z' }))).toBe('07-16 10:00');
    expect(kinTaleWhen(whenInput({ sentAt: '2026-07-16T16:00:00.000Z' }))).toBe('07-16 11:00');
    expect(kinTaleWhen(whenInput({ createdAt: '2026-07-16T17:00:00.000Z' }))).toBe('07-16 12:00');
  });

  it("'Date TBD' when every field is blank or unparseable, never a fabricated time", () => {
    expect(kinTaleWhen(whenInput({}))).toBe('Date TBD');
    expect(kinTaleWhen(whenInput({ visitDate: 'garbage' }))).toBe('Date TBD');
  });

  it('shows the LOCAL clock hour, not the UTC hour (AO-18)', () => {
    // 2026-07-16 20:00 America/Chicago -> "...T01:00:00.000Z" the next UTC day.
    // A raw `.substring(11, 16)` slice (the wasm's shortDateTime) would read
    // "01:00" and the wrong calendar day; the LOCAL read is "07-16 20:00".
    expect(kinTaleWhen(whenInput({ visitDate: '2026-07-17T01:00:00.000Z' }))).toBe('07-16 20:00');
  });
});

describe('kinTaleHousehold', () => {
  it('passes a real name through', () => {
    expect(kinTaleHousehold('The Whitfields')).toBe('The Whitfields');
  });

  it('falls back to "Unnamed Kinfolk" for blank/whitespace-only names', () => {
    expect(kinTaleHousehold('')).toBe('Unnamed Kinfolk');
    expect(kinTaleHousehold('   ')).toBe('Unnamed Kinfolk');
  });
});

describe('bodyPreview', () => {
  it('collapses internal whitespace/newlines', () => {
    expect(bodyPreview('Biscuit  had\n\na great time today.')).toBe('Biscuit had a great time today.');
  });

  it('truncates past 80 characters with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const preview = bodyPreview(long);
    expect(preview).toBe(`${'x'.repeat(80)}…`);
    expect(preview.length).toBe(81);
  });

  it('leaves an 80-char-or-shorter body untouched (no trailing ellipsis)', () => {
    const exact = 'y'.repeat(80);
    expect(bodyPreview(exact)).toBe(exact);
  });

  it('reports an honest "(empty body)" for blank/whitespace-only text, never a blank string', () => {
    expect(bodyPreview('')).toBe('(empty body)');
    expect(bodyPreview('   \n  ')).toBe('(empty body)');
  });
});

describe('kinTaleHeadline', () => {
  it('prefers a non-blank title over the body', () => {
    expect(kinTaleHeadline('A great day at the park', 'body text here')).toBe('A great day at the park');
  });

  it('falls back to the body preview when title is blank', () => {
    expect(kinTaleHeadline('', 'Biscuit had a great time.')).toBe('Biscuit had a great time.');
    expect(kinTaleHeadline('   ', '')).toBe('(empty body)');
  });
});

describe('sentViaLabel', () => {
  it('passes a real channel through, lower-cased', () => {
    expect(sentViaLabel('EMAIL')).toBe('email');
    expect(sentViaLabel('sms')).toBe('sms');
  });

  it('collapses both legacy backfill markers to "imported", never leaking the raw collection name', () => {
    expect(sentViaLabel('legacy_orphan')).toBe('imported');
    expect(sentViaLabel('legacy_visit_logs')).toBe('imported');
  });

  it('reads blank as "imported" too (matches the wasm reference exactly)', () => {
    expect(sentViaLabel('')).toBe('imported');
    expect(sentViaLabel('   ')).toBe('imported');
  });
});

describe('kinTaleState (AO-12-style: enumerated, never a fabricated default)', () => {
  it.each([
    ['DRAFT', 'draft'],
    ['SENT', 'sent'],
    ['FAILED', 'failed'],
  ] as const)('%s classifies as %s', (status, state) => {
    expect(kinTaleState(status)).toBe(state);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(kinTaleState('  sent  ')).toBe('sent');
    expect(kinTaleState('Draft')).toBe('draft');
  });

  it('an unrecognized status is its own honest "unknown" bucket, never a fabricated draft/sent/failed guess', () => {
    expect(kinTaleState('some_new_code')).toBe('unknown');
    expect(kinTaleState('')).toBe('unknown');
  });
});

describe('kinTaleStateInfo', () => {
  it.each([
    ['draft', 'Draft', 'DRAFT', 'draft'],
    ['sent', 'Sent', 'SENT', 'sent'],
    ['failed', 'Needs another look', 'FAILED', 'failed'],
    ['unknown', 'Unknown', 'UNKNOWN', 'unknown'],
  ] as const)('%s -> label %s / chip %s / css %s', (state, label, chipLabel, cssClass) => {
    expect(kinTaleStateInfo(state)).toEqual({ label, chipLabel, cssClass });
  });
});
