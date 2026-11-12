import type { BusinessSettings } from '../api/settings';
import { hoursRangeError } from './settingsChecks';

/**
 * #1783: a save sends only the fields the operator edited, and the server merges
 * the nested maps below key by key, so the screen's baseline has to fold the
 * same way. A plain spread would swap a whole `mytribePortal` for the one slice
 * that was sent.
 */
const MERGED_MAP_FIELDS = ['mytribePortal', 'paymentOptions', 'businessHours'] as const;

/**
 * #1978: `closedDayHours` after a save of `sentHours`, by the rule the server
 * applies (`closedDayHoursChanges` in `businessSettingsChecks.ts`): a day saved
 * as Closed keeps the readable range it had stored, and a day saved with hours
 * drops what was kept for it. The server writes the field; this keeps the
 * screen's copy the same until the next load.
 */
export function foldClosedDayHours(
  storedHours: Record<string, string>,
  kept: Record<string, string>,
  sentHours: Record<string, string>,
): Record<string, string> {
  const next = { ...kept };
  for (const [day, value] of Object.entries(sentHours)) {
    if (typeof value !== 'string') continue;
    if (value.trim() !== '') {
      delete next[day];
      continue;
    }
    const was = storedHours[day];
    if (typeof was !== 'string') continue;
    const range = was.trim();
    if (range !== '' && hoursRangeError(range) === null) next[day] = range;
  }
  return next;
}

export function foldSettingsPatch(base: BusinessSettings, patch: Partial<BusinessSettings>): BusinessSettings {
  const next: BusinessSettings = { ...base, ...patch };
  for (const field of MERGED_MAP_FIELDS) {
    const sent = patch[field];
    if (sent !== undefined) (next as unknown as Record<string, unknown>)[field] = { ...base[field], ...sent };
  }
  if (patch.businessHours !== undefined) {
    next.closedDayHours = foldClosedDayHours(base.businessHours, base.closedDayHours, patch.businessHours);
  }
  return next;
}
