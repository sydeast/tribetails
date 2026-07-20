import { describe, it, expect } from 'vitest';
import {
  s2gProviderIdFromEvent,
  s2gEventToCounter,
  twilioStatusToCounter,
  s2gEventDedupeId,
  zeroCounters,
} from '../src/lib/engagement';

describe('engagement helpers', () => {
  it('extracts the providerMessageId from a smtp2go email_id', () => {
    expect(s2gProviderIdFromEvent('1m2n3o-4p5q6r-7s')).toBe('1m2n3o-4p5q6r-7s');
    expect(s2gProviderIdFromEvent('  1m2n3o-4p5q6r-7s  ')).toBe('1m2n3o-4p5q6r-7s');
    expect(s2gProviderIdFromEvent('')).toBe('');
    expect(s2gProviderIdFromEvent(undefined)).toBe('');
    expect(s2gProviderIdFromEvent(null)).toBe('');
  });

  it('maps smtp2go events to engagement counters', () => {
    expect(s2gEventToCounter('delivered')).toBe('delivered');
    expect(s2gEventToCounter('OPEN')).toBe('opened');
    expect(s2gEventToCounter('click')).toBe('clicked');
    expect(s2gEventToCounter('bounce')).toBe('bounced');
    expect(s2gEventToCounter('reject')).toBe('bounced');
    expect(s2gEventToCounter('spam')).toBe('bounced');
    expect(s2gEventToCounter('processed')).toBeNull();
    expect(s2gEventToCounter('unsubscribe')).toBeNull();
    expect(s2gEventToCounter('resubscribe')).toBeNull();
    expect(s2gEventToCounter('')).toBeNull();
    expect(s2gEventToCounter(undefined)).toBeNull();
  });

  it('maps Twilio statuses to engagement counters', () => {
    expect(twilioStatusToCounter('delivered')).toBe('delivered');
    expect(twilioStatusToCounter('read')).toBe('opened');
    expect(twilioStatusToCounter('failed')).toBe('failed');
    expect(twilioStatusToCounter('undelivered')).toBe('failed');
    expect(twilioStatusToCounter('sent')).toBeNull();
    expect(twilioStatusToCounter('queued')).toBeNull();
    expect(twilioStatusToCounter(undefined)).toBeNull();
  });

  it('derives a dedupe id from the webhook event id', () => {
    expect(s2gEventDedupeId({ id: 'wh_1' })).toBe('wh_1');
    expect(s2gEventDedupeId({ id: '  ' })).toBeNull();
    expect(s2gEventDedupeId({})).toBeNull();
  });

  it('falls back to email_id + event when the webhook id is missing', () => {
    expect(s2gEventDedupeId({ email_id: '1m2n3o', event: 'delivered' })).toBe('1m2n3o:delivered');
    expect(s2gEventDedupeId({ email_id: '1m2n3o' })).toBeNull();
    expect(s2gEventDedupeId({ event: 'delivered' })).toBeNull();
  });

  it('zeroCounters has all five counters at 0', () => {
    expect(zeroCounters()).toEqual({ delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 });
  });
});
