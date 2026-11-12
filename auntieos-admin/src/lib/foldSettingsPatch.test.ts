import { describe, it, expect } from 'vitest';
import { DEFAULT_BUSINESS_SETTINGS } from '../api/settings';
import { foldClosedDayHours, foldSettingsPatch } from './foldSettingsPatch';
describe('foldSettingsPatch (#1783)', () => {
  const base = {
    ...DEFAULT_BUSINESS_SETTINGS,
    businessHours: { Monday: '09:00-17:00', Tuesday: '09:00-17:00' },
    mytribePortal: { ...DEFAULT_BUSINESS_SETTINGS.mytribePortal, themeId: 'calm' },
    serviceRates: { Walk: '15' },
  };
  it('merges a one-day hours patch into the stored week, as the server does', () => {
    const next = foldSettingsPatch(base, { businessHours: { Monday: '' } });
    expect(next.businessHours).toEqual({ Monday: '', Tuesday: '09:00-17:00' });
  });
  it('keeps the rest of the portal when only one slice was sent', () => {
    const next = foldSettingsPatch(base, {
      mytribePortal: { banner: { ...base.mytribePortal.banner, enabled: true } } as typeof base.mytribePortal,
    });
    expect(next.mytribePortal.themeId).toBe('calm');
    expect(next.mytribePortal.banner.enabled).toBe(true);
  });
  it('replaces a whole-map field outright, so a removed KinCare type goes', () => {
    const next = foldSettingsPatch(base, { serviceRates: { Overnight: '80' } });
    expect(next.serviceRates).toEqual({ Overnight: '80' });
  });
  it('leaves a map alone when the patch does not carry it', () => {
    expect(foldSettingsPatch(base, { businessName: 'X' }).businessHours).toEqual(base.businessHours);
  });
});

/** #1978: the screen's copy of the kept hours moves by the server's rule. */
describe('foldSettingsPatch: the hours a closed day had (#1978)', () => {
  const base = {
    ...DEFAULT_BUSINESS_SETTINGS,
    businessHours: { Monday: '09:00-17:00', Tuesday: '', Wednesday: 'by appointment' },
    closedDayHours: { Tuesday: '08:00-16:00' },
  };
  it('closing a day keeps the hours it had', () => {
    const next = foldSettingsPatch(base, { businessHours: { Monday: '' } });
    expect(next.businessHours.Monday).toBe('');
    expect(next.closedDayHours).toEqual({ Monday: '09:00-17:00', Tuesday: '08:00-16:00' });
  });
  it('opening a day drops what was kept for it', () => {
    const next = foldSettingsPatch(base, { businessHours: { Tuesday: '10:00-14:00' } });
    expect(next.closedDayHours).toEqual({});
  });
  it('a day with nothing readable stored keeps nothing, and what is kept stays', () => {
    const next = foldSettingsPatch(base, { businessHours: { Tuesday: '', Wednesday: '', Friday: '' } });
    expect(next.closedDayHours).toEqual({ Tuesday: '08:00-16:00' });
  });
  it('a save of another field leaves the kept hours as they were', () => {
    expect(foldSettingsPatch(base, { businessName: 'X' }).closedDayHours).toBe(base.closedDayHours);
  });
  it('foldClosedDayHours never changes the map it was given', () => {
    const kept = { Tuesday: '08:00-16:00' };
    foldClosedDayHours({ Monday: '09:00-17:00' }, kept, { Monday: '', Tuesday: '09:00-12:00' });
    expect(kept).toEqual({ Tuesday: '08:00-16:00' });
  });
});
