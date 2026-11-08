import { getNotificationDef } from './catalog';
import { humanizeKey } from '../lib/activityWords';
/**
 * A notification's name for an Activity Log sentence (#1752): its catalog
 * label, else its key as words, else '' (the sentence then says "a
 * notification"). Never the key itself.
 */
export function notificationName(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') return '';
  try {
    const label = getNotificationDef(key.trim()).label;
    if (typeof label === 'string' && label.trim() !== '') return label.trim();
  } catch {
    // Not in the catalog (a retired key): fall through to its words.
  }
  return humanizeKey(key);
}
