import { StatusPill } from './DenScreenKit';

/** Shown wherever a household has no Emergency Contact. Blocks nothing. */
export function NoEmergencyContactFlag({ compact = false }: { compact?: boolean }) {
  return <StatusPill label="No Emergency Contact" tone="warning" {...(compact ? { size: 'compact' as const } : {})} />;
}
