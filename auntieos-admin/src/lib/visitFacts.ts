/**
 * #1581: two facts Auntie Time's visit detail read wrong.
 *
 * "Visit length 0" for a 20:00 to 20:30 visit: the detail showed the stored
 * `serviceDurationMinutes` and never fell back to the window, and a New visit
 * that stated no length stored 0 (the server now stores the window's span).
 *
 * "Kin covered: 1 (names not on file)" sat directly above QA-Pup with a tick:
 * the record carried the id and no name, while the household's roster, already
 * loaded for the picker below, had the name all along.
 */

/** The window's span in whole minutes, or null when either end is unreadable or the end is not after the start. */
function windowMinutes(startIso: string, endIso: string): number | null {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.round((e - s) / 60_000);
}

/**
 * The visit length the detail shows and prefills: the stored length when it is
 * a real one, else the window's span, else whatever was stored (a recorded 0
 * on a visit with no readable window stays 0), else null for nothing at all.
 */
export function shownVisitLengthMinutes(entry: {
  serviceDurationMinutes?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}): number | null {
  const stored = entry.serviceDurationMinutes;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;
  const span = windowMinutes(
    typeof entry.startTime === 'string' ? entry.startTime : '',
    typeof entry.endTime === 'string' ? entry.endTime : '',
  );
  if (span !== null) return span;
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
}

/**
 * "Kin covered", naming every Kin it can. Names on the record come first; an id
 * the record carries no name for is looked up in the household's roster; only
 * an id neither knows is counted as "without a name on file".
 */
export function kinCoveredLabel(
  kinIds: readonly string[],
  recordNames: readonly string[],
  rosterNameFor: (kinId: string) => string | null,
): string {
  if (kinIds.length === 0) {
    return recordNames.length > 0 ? recordNames.join(', ') : 'Every Kin in the home (the booking named none)';
  }
  // The record's names are positional when there is one per id; otherwise
  // they cannot be matched to ids, so the roster answers per id.
  const names: string[] = [];
  let unnamed = 0;
  kinIds.forEach((id, i) => {
    const fromRecord = recordNames.length === kinIds.length ? (recordNames[i] ?? '').trim() : '';
    const name = fromRecord !== '' ? fromRecord : (rosterNameFor(id) ?? '').trim();
    if (name !== '') names.push(name);
    else unnamed += 1;
  });
  if (names.length === 0 && recordNames.length > 0) {
    // Names the record holds but cannot tie to ids are still names.
    names.push(...recordNames);
    unnamed = Math.max(0, kinIds.length - recordNames.length);
  }
  if (names.length === 0) return `${String(kinIds.length)} (names not on file)`;
  return unnamed > 0 ? `${names.join(', ')} · ${String(unnamed)} without a name on file` : names.join(', ');
}
