import { describe, it, expect } from 'vitest';
import {
  CHANNEL_LABEL,
  SAVE_TEMPLATE_FIRST,
  TEMPLATE_CHANNELS,
  addChannelLabel,
  channelSavedNotice,
  channelUnavailableReason,
  characterCount,
  localWordingError,
  saveChannelLabel,
  smsSegmentHint,
  smsSegments,
} from './templateChannelFormat';

describe('templateChannelFormat (#1935)', () => {
  it('names the three channels in operator words, email first', () => {
    expect(TEMPLATE_CHANNELS.map((c) => CHANNEL_LABEL[c])).toEqual(['Email', 'Text message', 'Push notification']);
  });

  it('names the add and save buttons and the saved notice for each channel', () => {
    expect(addChannelLabel('sms')).toBe('Add text message');
    expect(addChannelLabel('push')).toBe('Add push notification');
    expect(saveChannelLabel('sms')).toBe('Save text message');
    expect(saveChannelLabel('push')).toBe('Save push notification');
    expect(channelSavedNotice('sms')).toBe('Text message saved.');
    expect(channelSavedNotice('push')).toBe('Push notification saved.');
  });

  it('tells a template nothing sends apart from a notification not sent this way', () => {
    expect(channelUnavailableReason('sms', null)).toBe(
      'No notification sends this template, so it has no text message.',
    );
    expect(channelUnavailableReason('push', null)).toBe(
      'No notification sends this template, so it has no push notification.',
    );
    expect(channelUnavailableReason('sms', 'Password reset')).toBe('This notification is not sent by text message.');
    expect(channelUnavailableReason('push', 'Password reset')).toBe(
      'This notification is not sent as a push notification.',
    );
  });

  it('counts the way the server does, without the spaces at either end', () => {
    expect(characterCount('  hello  ', 1600)).toBe('5 of 1600 characters');
    expect(characterCount('', 100)).toBe('0 of 100 characters');
  });

  it("catches empty and over-long wording in the server's own sentences", () => {
    expect(localWordingError('Text message', '   ', 1600)).toBe('Text message cannot be empty.');
    expect(localWordingError('Title', 'x'.repeat(101), 100)).toBe('Title is 101 characters. The limit is 100.');
    expect(localWordingError('Message', ` ${'x'.repeat(500)} `, 500)).toBeNull();
    // Fields and brackets are the server's to judge.
    expect(localWordingError('Message', 'Hi {{{anything}}}', 500)).toBeNull();
  });

  it('counts texts the way carriers split them: 160, then 153 a text', () => {
    expect(smsSegments('')).toEqual({ segments: 0, unicode: false });
    expect(smsSegments('   ')).toEqual({ segments: 0, unicode: false });
    expect(smsSegments('a'.repeat(160))).toEqual({ segments: 1, unicode: false });
    expect(smsSegments('a'.repeat(161))).toEqual({ segments: 2, unicode: false });
    expect(smsSegments('a'.repeat(306))).toEqual({ segments: 2, unicode: false });
    expect(smsSegments('a'.repeat(307))).toEqual({ segments: 3, unicode: false });
    // Spaces at either end are not sent, so they are not counted.
    expect(smsSegments(`  ${'a'.repeat(160)}  `).segments).toBe(1);
  });

  it('counts a bracket or euro sign as two places, and a field as its own letters', () => {
    // 159 + one "{" (two places) = 161 places: two texts.
    expect(smsSegments(`${'a'.repeat(159)}{`).segments).toBe(2);
    expect(smsSegments(`${'a'.repeat(158)}€`).segments).toBe(1);
  });

  it('an emoji or curly quote drops each text to 70, then 67', () => {
    expect(smsSegments(`${'a'.repeat(69)}’`)).toEqual({ segments: 1, unicode: true });
    expect(smsSegments(`${'a'.repeat(70)}’`)).toEqual({ segments: 2, unicode: true });
    // An emoji is two UTF-16 units: 133 + 2 = 135, one over two 67-unit parts.
    expect(smsSegments(`${'a'.repeat(133)}🐾`).segments).toBe(3);
  });

  it('says how many texts in plain words, and why they got shorter', () => {
    expect(smsSegmentHint('')).toBeNull();
    expect(smsSegmentHint('Hi {{kinName}}')).toBe('Sends as 1 text.');
    expect(smsSegmentHint('a'.repeat(200))).toBe('Sends as 2 texts.');
    expect(smsSegmentHint('Hi 🐾')).toBe('Sends as 1 text. An emoji or special character makes each text shorter.');
  });

  it('carries no developer word and no em dash in any sentence', () => {
    const all = [
      ...Object.values(CHANNEL_LABEL),
      SAVE_TEMPLATE_FIRST,
      smsSegmentHint('a'.repeat(200)),
      smsSegmentHint('🐾'),
      addChannelLabel('sms'),
      addChannelLabel('push'),
      channelUnavailableReason('sms', null),
      channelUnavailableReason('push', 'x'),
    ].join(' ');
    expect(all).not.toMatch(/\bsms\b|handlebars|template id|—/i);
  });
});
