import { normClinicName } from './vetClinicCatalog';

/**
 * Near-match detection for `submitVetClinic` (operator ruling 2026-08-01):
 *
 *   "If the 'created' vet matches one already in the system, we give kinfolk to
 *    select the vet found in our system or to go ahead and create this new vet
 *    clinic"
 *
 * WHAT THIS REPLACES. `submitVetClinic` used to normalize the name, find the
 * first clinic with the same normalized name, and RETURN THAT CLINIC'S ID with
 * `created: false`. The caller asked to create a clinic and silently got
 * somebody else's record back. On a vet record that is a real hazard: two
 * practices genuinely can share a name in different cities, and a household
 * that thought it was adding its own vet would have been quietly pointed at a
 * different one, with a different phone number, on the record somebody reads
 * in an emergency.
 *
 * WHY THE TEST IS WIDER THAN NORMALIZED-NAME-ONLY. The old rule was wrong in
 * both directions: it fired on two different practices sharing a name (false
 * positive) and missed the SAME practice spelled differently (false negative),
 * which is the case that actually pollutes a shared catalog. Now that a match
 * only ever OFFERS a choice and never substitutes anything, a false positive
 * costs one extra tap while a false negative costs a duplicate clinic forever.
 * That asymmetry says: show more candidates, not fewer. So this matches on
 *
 *   name      identical once normalized (the old rule, kept)
 *   phone     the same dialable digits (catches "Riverside Animal Hospital"
 *             vs "Riverside Animal Hosp" vs "Riverside Vets")
 *   similar   one normalized name contains the other (catches an abbreviation
 *             or an added suffix, e.g. "Riverside Animal" vs
 *             "Riverside Animal Hospital")
 *
 * and returns them ranked, so the strongest evidence is what the user reads
 * first.
 */

/** Why a clinic is being offered as a possible match. Strongest first. */
export type MatchReason = 'name' | 'phone' | 'similar';

const REASON_RANK: Record<MatchReason, number> = { name: 0, phone: 1, similar: 2 };

/** A clinic being offered to the user as "did you mean this one?". */
export interface ClinicCandidate {
  id: string;
  name: string;
  address: string;
  phone: string;
  isEmergency: boolean;
  /** False for a pending kinfolk submission nobody has approved yet. */
  verified: boolean;
  reason: MatchReason;
}

/** A stored `vet_clinics` row, as the matcher needs it. */
export interface CatalogRow {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Digits only. A clinic phone is compared on digits so formatting differences
 * ("(512) 555-0100" vs "512.555.0100") do not hide the same practice.
 */
export function phoneDigits(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Seven digits, the length of a local subscriber number. Shorter than that is
 * an extension or a fragment, and matching on it would collide clinics that
 * merely share a suffix.
 */
const MIN_PHONE_DIGITS = 7;

/**
 * Four characters, so a containment test cannot fire on a stray token. "Vet"
 * appears in most clinic names and would otherwise match nearly everything.
 */
const MIN_CONTAIN_CHARS = 4;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** How many candidates a caller is offered. More than a handful is a wall, not a choice. */
export const MAX_CANDIDATES = 5;

/**
 * The clinics that might be the one the caller is trying to add.
 *
 * Archived rows are excluded: a retired clinic is not something to be offered
 * as an alternative, and the user could not have picked it from the list
 * either. Pending rows ARE included and flagged, because two households
 * submitting the same new clinic in the same week is exactly the duplicate
 * this is meant to catch.
 */
export function clinicMatchCandidates(
  name: string,
  phone: string,
  rows: readonly CatalogRow[],
): ClinicCandidate[] {
  const wantedName = normClinicName(name);
  const wantedPhone = phoneDigits(phone);
  if (wantedName === '') return [];

  const out: ClinicCandidate[] = [];

  for (const row of rows) {
    const data = row.data;
    if (data['archived'] === true) continue;

    const rowName = normClinicName(str(data['name']));
    if (rowName === '') continue;
    const rowPhone = phoneDigits(str(data['phone']));

    let reason: MatchReason | null = null;
    if (rowName === wantedName) {
      reason = 'name';
    } else if (
      wantedPhone.length >= MIN_PHONE_DIGITS &&
      rowPhone.length >= MIN_PHONE_DIGITS &&
      rowPhone === wantedPhone
    ) {
      reason = 'phone';
    } else if (
      Math.min(rowName.length, wantedName.length) >= MIN_CONTAIN_CHARS &&
      (rowName.includes(wantedName) || wantedName.includes(rowName))
    ) {
      reason = 'similar';
    }
    if (reason === null) continue;

    out.push({
      id: row.id,
      name: str(data['name']),
      address: str(data['address']),
      phone: str(data['phone']),
      isEmergency: data['isEmergency'] === true,
      // Missing means approved: the seeded catalog predates the field.
      verified: data['verified'] !== false,
      reason,
    });
  }

  out.sort((a, b) => {
    const r = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * Whether the caller has genuinely seen [candidates] already.
 *
 * THIS IS THE ENFORCEMENT, not a courtesy. The operator's requirement is that
 * "the confirm flag can never be set by the client without the user having seen
 * the match". A bare `confirmCreate: true` boolean could be sent by any client
 * that never rendered anything, so the confirmation is not a boolean: the
 * caller must echo back the IDS the server offered it. Since the only way to
 * learn those ids is to have received them from the previous call, echoing them
 * is proof the choice was presented.
 *
 * The check is recomputed against the CURRENT candidate set, so if another
 * household added a matching clinic between the two calls, the new one is not
 * in the acknowledged list and the caller is asked again rather than creating a
 * duplicate of a clinic it was never shown.
 */
export function acknowledgesAll(
  candidates: readonly ClinicCandidate[],
  acknowledgedIds: readonly string[],
): boolean {
  const seen = new Set(acknowledgedIds);
  return candidates.every((c) => seen.has(c.id));
}
