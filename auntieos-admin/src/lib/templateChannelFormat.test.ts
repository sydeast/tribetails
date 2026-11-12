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

  it('carries no developer word and no em dash in any sentence', () => {
    const all = [
      ...Object.values(CHANNEL_LABEL),
      SAVE_TEMPLATE_FIRST,
      addChannelLabel('sms'),
      addChannelLabel('push'),
      channelUnavailableReason('sms', null),
      channelUnavailableReason('push', 'x'),
    ].join(' ');
    expect(all).not.toMatch(/\bsms\b|handlebars|template id|—/i);
  });
});
