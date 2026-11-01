import { describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ collection: () => ({ doc: () => ({ get: h.get }) }) }),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
import {
  BUSINESS_FALLBACK,
  businessLabel,
  businessTokens,
  fillBusinessPlaceholders,
  loadBusinessName,
} from '../src/lib/businessName';
describe('businessLabel (#1381)', () => {
  it('uses the settings name as written, trimmed', () => {
    expect(businessLabel('  Test Business ')).toBe('Test Business');
    expect(businessLabel('Test Business', { capital: true })).toBe('Test Business');
  });
  it('falls back to "your Auntie" for an unset, blank or absent name', () => {
    expect(BUSINESS_FALLBACK).toBe('your Auntie');
    expect(businessLabel(undefined)).toBe('your Auntie');
    expect(businessLabel(null)).toBe('your Auntie');
    expect(businessLabel('   ')).toBe('your Auntie');
  });
  it('capitalises only when asked, and forms the possessive for both labels', () => {
    expect(businessLabel('', { capital: true })).toBe('Your Auntie');
    expect(businessLabel('', { possessive: true })).toBe("your Auntie's");
    expect(businessLabel('Test Business', { possessive: true })).toBe("Test Business's");
  });
});
describe('fillBusinessPlaceholders', () => {
  it('fills every placeholder form', () => {
    const text = "{Business} sends {business}'s news; {business's} queue; {Business's} desk.";
    expect(fillBusinessPlaceholders(text, 'Test Business')).toBe(
      "Test Business sends Test Business's news; Test Business's queue; Test Business's desk.",
    );
    expect(fillBusinessPlaceholders('{Business} and {business}', '')).toBe('Your Auntie and your Auntie');
    expect(fillBusinessPlaceholders("{business's} and {Business's}", '')).toBe("your Auntie's and Your Auntie's");
  });
});
describe('businessTokens', () => {
  it('gives the mid-sentence and sentence-opening merge fields', () => {
    expect(businessTokens('Test Business')).toEqual({ business: 'Test Business', Business: 'Test Business' });
    expect(businessTokens('')).toEqual({ business: 'your Auntie', Business: 'Your Auntie' });
  });
});
describe('loadBusinessName', () => {
  it('reads business_settings.businessName, trimmed', async () => {
    h.get.mockResolvedValue({ data: () => ({ businessName: ' Test Business ' }) });
    await expect(loadBusinessName('test')).resolves.toBe('Test Business');
  });
  it('is blank when the doc, the field or its type is missing', async () => {
    h.get.mockResolvedValue({ data: () => undefined });
    await expect(loadBusinessName('test')).resolves.toBe('');
    h.get.mockResolvedValue({ data: () => ({ businessName: 42 }) });
    await expect(loadBusinessName('test')).resolves.toBe('');
  });
  it('is blank, never a throw, when the read fails', async () => {
    h.get.mockImplementation(async () => {
      throw new Error('unavailable');
    });
    await expect(loadBusinessName('test')).resolves.toBe('');
  });
});
