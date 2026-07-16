/**
 * Pure display helpers for the Den, ported 2026-07-15 from the LIVE Compose source:
 *   ui/components/DenScreenKit.kt   denCurrentHour, greetingForHour, serviceTone,
 *                                   statusLabel, formatTime
 *   ui/components/AuntieTones.kt    AuntieStatusTone + its color() resolver
 *
 * Kept out of the components so the mapping logic has direct vitest coverage: the
 * greeting boundaries and the serviceTone key matching are the parts that actually
 * break, and neither needs a DOM to prove.
 *
 * Tones are NAMES, never colors. Nothing here maps a tone to a value: the component
 * writes `data-tone="teal"` and DenScreenKit.css resolves it to a token, which is
 * where that mapping already lives and where it should stay. A helper returning a
 * hex would be wrong in one of the two themes by construction, since tokens.css
 * re-points every brand role for dark.
 */

/** The Den's status tone palette (AuntieTones.kt `enum class AuntieStatusTone`). */
export type AuntieStatusTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'error'
  | 'teal'
  | 'purple'
  | 'orange'
  | 'muted';

/**
 * Hour-of-day [0..23] for an instant, falling back to 9 for an Invalid Date.
 *
 * Injected rather than read from the clock: the greeting boundaries below are the
 * only interesting thing here, and a helper that called `new Date()` itself could
 * not be tested at 11:59 or at midnight.
 *
 * DIVERGENCE, deliberate. The Kotlin reads `nowIso().substring(11, 13)`, and on
 * wasm `nowIso()` is `new Date().toISOString()`, which is UTC. So the LIVE WEB app
 * greets on the UTC hour: an operator in US/Pacific at 17:00 local is 00:00 UTC and
 * is told "Good morning". The JVM target uses LocalDateTime.now() and is correct.
 * This port follows the JVM (and the docstring's stated intent, "local"), so it
 * intentionally does NOT reproduce the wasm bug.
 */
export function denCurrentHour(now: Date): number {
  const hour = now.getHours();
  return Number.isNaN(hour) ? 9 : hour;
}

/**
 * "Good morning" / "Good afternoon" / "Good evening" for an hour-of-day.
 *
 * Boundaries are the Kotlin's, verbatim, and they are lopsided on purpose:
 * morning runs 0..11 (so 00:00 is "Good morning", not "Good evening") and
 * afternoon ends at 16, so evening starts at 17:00 rather than the more usual 18.
 * Do not "tidy" these without changing DenScreenKit.kt in the same breath.
 *
 * Returns the salutation only. The Home heading's ", Auntie." tail is appended
 * downstream by `homeHeading` in branding/Branding.kt, which is a separate helper.
 */
export function greetingForHour(hour: number): string {
  if (hour >= 0 && hour <= 11) return 'Good morning';
  if (hour >= 12 && hour <= 16) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Free-text service type to a brand tone for pills, swatches, and avatars.
 *
 * Substring matching in priority order, ported as-is. The order is load-bearing:
 * "walk" wins before "sit" so a "dog_walk_sitting" reads as a walk.
 *
 * KNOWN COLLISION, ported faithfully because Schedule's legend and the grid must
 * keep painting the same swatch: the word "visit" CONTAINS "sit", so every
 * visit-shaped key ("visit_60", "visit") resolves to Purple, the house-sitting
 * tone. DenScreenKit's own comment in ScheduleScreen.kt claims "visit_60" falls
 * through to Orange. It does not. The comment is wrong, the code is what ships.
 */
export function serviceTone(serviceType: string): AuntieStatusTone {
  const s = serviceType.toLowerCase();
  if (s.includes('walk')) return 'teal';
  if (s.includes('drop')) return 'orange';
  if (s.includes('sit') || s.includes('house') || s.includes('overnight')) return 'purple';
  if (s.includes('meet') || s.includes('greet')) return 'success';
  return 'orange';
}

/**
 * Human label for a KinCare session status.
 *
 * Unknown and absent statuses both fall to "scheduled", matching the Kotlin. That
 * is a real product decision, not laziness: a session whose status failed to sync
 * is still one the auntie is expected to show up for.
 */
export function statusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'done';
    case 'ON_MY_WAY':
      return 'on the way';
    case 'ARRIVED':
      return 'arrived';
    case 'DEPARTED':
      return 'departed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'scheduled';
  }
}

/**
 * ISO timestamp to a compact "9:05a" / "5:30p", echoing the input unchanged when it
 * cannot be read.
 *
 * Positional slicing, not Date parsing, ported deliberately: it renders the wall
 * time as written in the string. A stored "...Z" therefore displays as UTC, which
 * is the same zone question flagged on denCurrentHour, but changing it here would
 * silently shift every rendered visit time and belongs in its own change.
 *
 * The minute is passed through WITHOUT validation, exactly as the Kotlin does: it
 * only ever slices, so a malformed minute renders as-is rather than throwing.
 */
export function formatTime(iso: string): string {
  // Kotlin: `if (iso.length < 16) return iso` before touching any index.
  if (iso.length < 16) return iso;
  const rawHour = iso.slice(11, 13);
  // Kotlin's `toInt()` throws on non-numeric and runCatching echoes the input.
  if (!/^\d{2}$/.test(rawHour)) return iso;
  const hour = Number(rawHour);
  const minute = iso.slice(14, 16);
  const ampm = hour >= 12 ? 'p' : 'a';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute}${ampm}`;
}
