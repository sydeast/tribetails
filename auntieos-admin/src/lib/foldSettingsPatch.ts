import type { BusinessSettings } from '../api/settings';

/**
 * #1783: a save sends only the fields the operator edited, and the server merges
 * the nested maps below key by key, so the screen's baseline has to fold the
 * same way. A plain spread would swap a whole `mytribePortal` for the one slice
 * that was sent.
 */
const MERGED_MAP_FIELDS = ['mytribePortal', 'paymentOptions', 'businessHours'] as const;
export function foldSettingsPatch(base: BusinessSettings, patch: Partial<BusinessSettings>): BusinessSettings {
  const next: BusinessSettings = { ...base, ...patch };
  for (const field of MERGED_MAP_FIELDS) {
    const sent = patch[field];
    if (sent !== undefined) (next as unknown as Record<string, unknown>)[field] = { ...base[field], ...sent };
  }
  return next;
}
