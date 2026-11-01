import { describe, expect, it } from 'vitest';
import { looksLikeServiceCode, serviceEyebrowOf, serviceLabelOf, visitTitleOf } from './serviceLabel';
// #1297: screens print the server-resolved name and never a stored code.
describe('serviceLabel', () => {
  it('prefers the server-resolved name', () => {
    expect(serviceLabelOf({ serviceLabel: '60 Minute', serviceType: 'visit_60' })).toBe('60 Minute');
  });
  it('shows nothing rather than a code when the server resolved no name', () => {
    expect(serviceLabelOf({ serviceLabel: null, serviceType: 'visit_60' })).toBeNull();
  });
  it('on an older server with no serviceLabel key, uses serviceType only when it is a name', () => {
    expect(serviceLabelOf({ serviceType: 'Overnight' })).toBe('Overnight');
    expect(serviceLabelOf({ serviceType: 'VISIT_60' })).toBeNull();
  });
  it('treats a code-shaped title as no title', () => {
    expect(visitTitleOf({ title: 'visit_60', serviceLabel: '60 Minute' })).toBe('60 Minute');
    expect(visitTitleOf({ title: 'Midday drop-in', serviceLabel: '60 Minute' })).toBe('Midday drop-in');
  });
  it('draws the eyebrow only when it adds something, with no "Service Type" prefix', () => {
    expect(serviceEyebrowOf({ title: 'Midday drop-in', serviceLabel: '60 Minute' })).toBe('60 Minute');
    expect(serviceEyebrowOf({ title: null, serviceLabel: '60 Minute' })).toBeNull();
    expect(serviceEyebrowOf({ title: 'Midday drop-in', serviceLabel: null, serviceType: 'visit_60' })).toBeNull();
  });
  it('tells a code from a name', () => {
    expect(looksLikeServiceCode('visit_60')).toBe(true);
    expect(looksLikeServiceCode('30 Minute Quick Check')).toBe(false);
  });
});
