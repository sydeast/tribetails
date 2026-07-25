import { describe, it, expect } from 'vitest';
import {
  summaryLine,
  contextFieldShown,
  kinMetaLine,
  commsSnippet,
  latestCommunication,
  commsBoxState,
  type CommsRow,
} from './recipientContext';

function row(over: Partial<CommsRow> = {}): CommsRow {
  return { _id: 'c1', channel: 'sms', timestamp: '2026-07-01T10:00:00Z', ...over };
}

describe('summaryLine', () => {
  it('prefers the tldr, which is the reconciler’s own one-liner', () => {
    expect(summaryLine('Short version.', 'The much longer raw summary.', 280)).toBe('Short version.');
  });

  it('falls back to the raw summary when there is no tldr', () => {
    expect(summaryLine('   ', 'The raw summary.', 280)).toBe('The raw summary.');
  });

  it('returns empty when neither exists, rather than a placeholder sentence', () => {
    expect(summaryLine('', '  ', 280)).toBe('');
  });

  it('truncates past the cap and marks that it did', () => {
    expect(summaryLine('', 'abcdefghij', 4)).toBe('abcd…');
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(summaryLine('', 'ab cdefgh', 3)).toBe('ab…');
  });

  it('leaves text exactly at the cap alone, with no ellipsis', () => {
    expect(summaryLine('', 'abcd', 4)).toBe('abcd');
  });
});

describe('contextFieldShown', () => {
  it('hides a blank value', () => {
    expect(contextFieldShown('   ')).toBe(false);
  });

  it('hides the reconciler’s "Not yet documented." placeholder, which is not context', () => {
    expect(contextFieldShown('Not yet documented.')).toBe(false);
  });

  it('shows real content', () => {
    expect(contextFieldShown('Nova is reactive to skateboards.')).toBe(true);
  });
});

describe('kinMetaLine', () => {
  it('joins species and breed the archive way', () => {
    expect(kinMetaLine('Dog', 'Border Collie')).toBe('Dog · Border Collie');
  });

  it('drops the missing half rather than printing a dangling separator', () => {
    expect(kinMetaLine('Dog', '')).toBe('Dog');
    expect(kinMetaLine('', 'Border Collie')).toBe('Border Collie');
  });

  it('returns empty when neither is on file', () => {
    expect(kinMetaLine('', '  ')).toBe('');
  });
});

describe('commsSnippet', () => {
  it('uses the body for a text', () => {
    expect(commsSnippet(row({ channel: 'sms', body: 'On my way.' }))).toBe('On my way.');
  });

  it('prefers the subject for an email, falling back to the body', () => {
    expect(commsSnippet(row({ channel: 'email', subject: 'Nova update', body: 'long body' }))).toBe('Nova update');
    expect(commsSnippet(row({ channel: 'email', subject: '', body: 'long body' }))).toBe('long body');
  });

  it('prefers the transcript for a call, falling back to the status', () => {
    expect(commsSnippet(row({ channel: 'call', transcript: 'Talked about keys.', status: 'completed' }))).toBe(
      'Talked about keys.',
    );
    expect(commsSnippet(row({ channel: 'call', transcript: '', status: 'no-answer' }))).toBe('no-answer');
  });

  it('uses the transcript for a voicemail', () => {
    expect(commsSnippet(row({ channel: 'voicemail', transcript: 'Call me back.' }))).toBe('Call me back.');
  });

  it('truncates a long snippet', () => {
    const long = 'x'.repeat(200);
    const out = commsSnippet(row({ channel: 'sms', body: long }));
    expect(out).toHaveLength(141);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty rather than "undefined" when the row carries no text at all', () => {
    expect(commsSnippet(row({ channel: 'sms' }))).toBe('');
  });
});

describe('latestCommunication', () => {
  it('picks the newest across all four channels', () => {
    const latest = latestCommunication([
      row({ _id: 'a', channel: 'sms', timestamp: '2026-07-01T10:00:00Z', body: 'old' }),
      row({ _id: 'b', channel: 'email', timestamp: '2026-07-09T10:00:00Z', subject: 'new' }),
      row({ _id: 'c', channel: 'call', timestamp: '2026-07-05T10:00:00Z', transcript: 'mid' }),
    ]);
    expect(latest?.channel).toBe('email');
    expect(latest?.snippet).toBe('new');
  });

  it('ignores a row with no timestamp instead of letting it sort as newest', () => {
    const latest = latestCommunication([
      row({ _id: 'a', channel: 'sms', timestamp: '', body: 'undated' }),
      row({ _id: 'b', channel: 'email', timestamp: '2026-01-01T00:00:00Z', subject: 'dated' }),
    ]);
    expect(latest?.snippet).toBe('dated');
  });

  it('returns null when there is nothing on file', () => {
    expect(latestCommunication([])).toBeNull();
  });

  it('returns null when every row is undated, rather than picking one arbitrarily', () => {
    expect(latestCommunication([row({ timestamp: '' })])).toBeNull();
  });

  it('carries the channel label through so the box can name it', () => {
    expect(latestCommunication([row({ channel: 'voicemail', transcript: 'hi' })])?.channel).toBe('voicemail');
  });
});

describe('commsBoxState', () => {
  const latest = { channel: 'sms' as const, timestamp: '2026-07-01T10:00:00Z', snippet: 'On my way.' };

  it('shows the AI recap when the flag is on and the recap came back with something', () => {
    const s = commsBoxState(true, 'They asked about the holiday weekend.', latest);
    expect(s.kind).toBe('recap');
    if (s.kind === 'recap') expect(s.recap).toBe('They asked about the holiday weekend.');
  });

  it('falls back to the raw latest message when the flag is on but the recap came back blank, and DISCLOSES it', () => {
    const s = commsBoxState(true, '  ', latest);
    expect(s.kind).toBe('latest');
    if (s.kind === 'latest') expect(s.disclosedFallback).toBe(true);
  });

  it('shows the raw latest message with no disclosure when the flag is simply off', () => {
    const s = commsBoxState(false, '', latest);
    expect(s.kind).toBe('latest');
    // Nothing was promised, so there is nothing to apologise for.
    if (s.kind === 'latest') expect(s.disclosedFallback).toBe(false);
  });

  it('never shows a recap the flag did not authorise, even if one somehow arrived', () => {
    const s = commsBoxState(false, 'a recap nobody asked for', latest);
    expect(s.kind).toBe('latest');
  });

  it('is empty when there is no recap and no message', () => {
    expect(commsBoxState(true, '', null).kind).toBe('empty');
    expect(commsBoxState(false, '', null).kind).toBe('empty');
  });
});
