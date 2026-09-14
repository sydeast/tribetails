import { StatusPill } from './DenScreenKit';

/**
 * Shown wherever a household has no Emergency Contact. Blocks nothing.
 *
 * #829 review item 14: the compact capsule everywhere (Directory card, profile,
 * edit), the same pill admin Android, desktop and the portals draw. Pass
 * `compact={false}` only where a full-size status pill is genuinely wanted.
 */
export function NoEmergencyContactFlag({ compact = true }: { compact?: boolean }) {
  return <StatusPill label="No Emergency Contact" tone="warning" {...(compact ? { size: 'compact' as const } : {})} />;
}
