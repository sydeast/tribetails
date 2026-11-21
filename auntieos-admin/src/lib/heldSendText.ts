/**
 * #1834 (operator ruling, 2026-11-20): what the owner reads when a broadcast or
 * a marketing blast is held because notices to households are switched off,
 * or because that notice is turned off in Settings.
 *
 * The server refuses with one of three tokens (`sendSwitchRules.ts`) and has
 * sent and stored nothing, so nothing goes out later. Android and the desktop
 * console carry the same sentences (`HeldSendText.kt`).
 */

export type HeldSendKind = 'broadcast' | 'blast';

const SWITCH_NAME = '"Send notices to households" in Settings, under Notifications';

/** The owner's sentence for a held send, or null when the message is not a hold. */
export function heldSendText(message: string, kind: HeldSendKind): string | null {
  const sent = kind === 'broadcast' ? 'This broadcast was not sent' : 'This blast was not scheduled';
  const again = kind === 'broadcast' ? 'send it again' : 'schedule it again';
  if (message.includes('held_household_notices_off')) {
    return `Held. Notices to households are switched off. ${sent} and will not go out later. To send it, switch on ${SWITCH_NAME}, then ${again}.`;
  }
  if (message.includes('held_notice_turned_off')) {
    const what = kind === 'broadcast' ? 'Broadcasts are' : 'This campaign is';
    return `Held. ${what} turned off in Settings, under Notifications. ${sent} and will not go out later.`;
  }
  if (message.includes('held_household_notices_unreadable')) {
    return `Held. The setting for notices to households could not be read. ${sent}. Try again in a minute.`;
  }
  return null;
}

/**
 * A campaign row's counts. `dispatched` counts every copy queued; the ones held
 * at the send time (notices to households, or the campaign, turned off since it
 * was scheduled) never went, so they are taken out of "sent" and named.
 */
export function blastCountsText(dispatched: number, suppressed: number, heldAtSend: number | undefined): string {
  const count = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
  const held = count(heldAtSend);
  const sent = Math.max(0, count(dispatched) - held);
  return `${sent} sent, ${count(suppressed)} suppressed${held === 0 ? '' : `, ${held} held and not sent`}`;
}
