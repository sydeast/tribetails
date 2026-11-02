// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1321: the pre-auth business card read. The mapping mirrors
 * functions/src/lib/businessPublicCard.ts; the cache is what lets a cold open
 * show the business name with the headline rather than after the read.
 */
const fs = vi.hoisted(() => ({
  doc: vi.fn((..._segments: unknown[]) => ({ path: 'business_public/card' })),
  getDoc: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => fs.doc(...args),
  getDoc: (...args: unknown[]) => fs.getDoc(...args),
}));
vi.mock('./firebase', () => ({ firestore: { name: 'test-firestore' } }));

import {
  BUSINESS_PUBLIC_CARD_CACHE_KEY,
  businessPublicCardFromDoc,
  cacheBusinessPublicCard,
  emptyBusinessPublicCard,
  readBusinessPublicCardDirect,
  readCachedBusinessPublicCard,
} from './businessPublicCard';

const WEEK = { Monday: '', Tuesday: '', Wednesday: '', Thursday: '', Friday: '', Saturday: '', Sunday: '' };

beforeEach(() => {
  localStorage.clear();
});

describe('businessPublicCardFromDoc', () => {
  it('copies the four public fields and fills every day', () => {
    expect(
      businessPublicCardFromDoc({
        name: 'Sunny Paws',
        phone: '555-0142',
        hours: { Monday: '09:00-17:00', Saturday: '10:00-14:00' },
        privacyPolicyUrl: 'https://example.test/privacy',
      }),
    ).toEqual({
      name: 'Sunny Paws',
      phone: '555-0142',
      hours: { ...WEEK, Monday: '09:00-17:00', Saturday: '10:00-14:00' },
      privacyPolicyUrl: 'https://example.test/privacy',
    });
  });

  it('reads a missing document, a blank name and a bad value as unset', () => {
    expect(businessPublicCardFromDoc(undefined)).toEqual(emptyBusinessPublicCard());
    expect(businessPublicCardFromDoc({ name: '   ', phone: 42, hours: 'nine to five' })).toEqual(emptyBusinessPublicCard());
  });

  it('never forwards a key the card does not carry', () => {
    const card = businessPublicCardFromDoc({ name: 'Sunny Paws', venmoHandle: '@x', email: 'a@b.test' }) as unknown as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual(['hours', 'name', 'phone', 'privacyPolicyUrl']);
  });

  it('keeps only an https privacy policy link', () => {
    expect(businessPublicCardFromDoc({ privacyPolicyUrl: 'http://example.test/p' }).privacyPolicyUrl).toBe('');
    expect(businessPublicCardFromDoc({ privacyPolicyUrl: 'javascript:alert(1)' }).privacyPolicyUrl).toBe('');
  });
});

describe('readBusinessPublicCardDirect', () => {
  it('reads business_public/card and maps it', async () => {
    fs.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ name: 'Sunny Paws', phone: '555-0142' }) });
    const card = await readBusinessPublicCardDirect();
    expect(fs.doc).toHaveBeenCalledWith({ name: 'test-firestore' }, 'business_public', 'card');
    expect(card.name).toBe('Sunny Paws');
    expect(card.phone).toBe('555-0142');
  });

  it('reads a document that is not there yet as the empty card', async () => {
    fs.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    expect(await readBusinessPublicCardDirect()).toEqual(emptyBusinessPublicCard());
  });

  it('lets a Firestore failure through for the caller to decide', async () => {
    fs.getDoc.mockRejectedValue(new Error('unavailable'));
    await expect(readBusinessPublicCardDirect()).rejects.toThrow('unavailable');
  });
});

describe('the local cache', () => {
  it('round-trips the card', () => {
    const card = { ...emptyBusinessPublicCard(), name: 'Sunny Paws' };
    cacheBusinessPublicCard(card);
    expect(readCachedBusinessPublicCard()).toEqual(card);
  });

  it('is empty on a first visit', () => {
    expect(readCachedBusinessPublicCard()).toBeNull();
  });

  it('shrugs off a corrupt entry', () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, '{not json');
    expect(readCachedBusinessPublicCard()).toBeNull();
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, '"a string"');
    expect(readCachedBusinessPublicCard()).toBeNull();
  });

  it('survives a storage that refuses writes', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => cacheBusinessPublicCard(emptyBusinessPublicCard())).not.toThrow();
    spy.mockRestore();
  });
});
