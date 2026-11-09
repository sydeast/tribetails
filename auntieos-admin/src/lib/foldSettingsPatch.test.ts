import { describe, it, expect } from 'vitest';
import { DEFAULT_BUSINESS_SETTINGS } from '../api/settings';
import { foldSettingsPatch } from './foldSettingsPatch';
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
