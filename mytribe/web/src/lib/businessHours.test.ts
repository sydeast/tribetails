import { describe, expect, it } from 'vitest';
import { HOURS_CLOSED, hoursLabel } from './businessHours';

/** #1411: one day of the public card's hours, as the About screen prints it. Twin of BusinessHoursLabelTest.kt. */
describe('hoursLabel', () => {
  it('reads a 24-hour range as a 12-hour one', () => {
    expect(hoursLabel('09:00-17:00')).toBe('9:00 AM to 5:00 PM');
    expect(hoursLabel('07:30-12:00')).toBe('7:30 AM to 12:00 PM');
    expect(hoursLabel('00:00-23:59')).toBe('12:00 AM to 11:59 PM');
    expect(hoursLabel(' 10:00 - 14:00 ')).toBe('10:00 AM to 2:00 PM');
  });

  it('reads a blank day as Closed', () => {
    expect(hoursLabel('')).toBe(HOURS_CLOSED);
    expect(hoursLabel('   ')).toBe('Closed');
  });

  it('shows anything it cannot parse as typed, never blank', () => {
    expect(hoursLabel('By appointment')).toBe('By appointment');
    expect(hoursLabel('25:00-26:00')).toBe('25:00-26:00');
    expect(hoursLabel('9-5')).toBe('9-5');
  });
});
