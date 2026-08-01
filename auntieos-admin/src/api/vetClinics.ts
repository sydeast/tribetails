import { type CollectionSpec } from '../lib/firestore';

/**
 * The shared vet-clinic catalog ("the vet bank"), read side.
 *
 * The admin reads `vet_clinics` DIRECTLY rather than through the deployed
 * `getVetClinics` callable, and the difference is deliberate. That callable
 * withholds any doc with `verified === false`, which is the kinfolk pending
 * queue; the operator is the person who approves those, so hiding them from the
 * operator would hide the work. `firestore.rules:131` is
 * `allow read: if signedIn()` on this collection, so a direct bounded listener
 * is both permitted and live, which a one-shot callable is not: a clinic
 * created from the picker appears in the same listener without a refetch.
 *
 * Cast, not validated, same rule as `api/directory.ts`: these are raw map
 * entries off a document that predates half its own fields. A clinic curated
 * before `isEmergency` or `verified` existed must still read without throwing,
 * so everything but the id is optional and every consumer supplies the default.
 */
export interface VetClinic {
  _id: string;
  name?: string | undefined;
  phone?: string | undefined;
  address?: string | undefined;
  website?: string | undefined;
  googleMapsUrl?: string | undefined;
  /** 24 hour / emergency / urgent care. Absent on legacy curated rows. */
  isEmergency?: boolean | undefined;
  /**
   * Approval gate. Admin-authored and staff-submitted entries are `true`; a
   * kinfolk `submitVetClinic` lands `false` and waits for the operator. MISSING
   * means approved: the seeded catalog predates the field.
   */
  verified?: boolean | undefined;
  submittedBy?: string | undefined;
  notes?: string | undefined;
  /**
   * Opening hours, e.g. "Mon to Fri 8a to 6p". Lives HERE and not on the
   * household, because hours are a property of the practice: every household
   * using Riverside shares Riverside's hours. `household_data.primaryVetHours`
   * stored them per household, which meant one clinic's hours were recorded N
   * times and corrected zero times. Absent on every row before 2026-08-01.
   */
  hours?: string | undefined;
  /**
   * Retired from the bank by `archiveVetClinic`. Absent means active: the field
   * is newer than the catalog. An archived clinic is hidden from the pickers but
   * NEVER from a household already linked to it, which keeps its own copy of the
   * name, phone and address regardless.
   */
  archived?: boolean | undefined;
}

/**
 * Bounded, ordered live query, per the `useCollection` contract. 500 is the same
 * cap Directory uses and is far above the real catalog size; if a metro's bank
 * ever passes it, the picker's search is a client-side filter over what the
 * listener returned, so the cap would start hiding clinics and this becomes a
 * server-side search instead.
 */
export const VET_CLINICS_QUERY: CollectionSpec = {
  path: 'vet_clinics',
  order: ['name', 'asc'],
  max: 500,
};

/** True unless the doc is an explicit pending kinfolk submission. */
export function isApprovedClinic(c: VetClinic): boolean {
  return c.verified !== false;
}

/** True unless the operator has retired the clinic from the bank. */
export function isActiveClinic(c: VetClinic): boolean {
  return c.archived !== true;
}

/**
 * The clinics a household may PICK: approved, and not retired.
 *
 * The currently-selected clinic is deliberately NOT filtered back in. A
 * household already on an archived clinic keeps its denormalized name, phone and
 * address, so the picker still displays what is on file; it simply cannot be
 * re-selected from the list, which is the whole point of archiving.
 */
export function selectableClinics(all: readonly VetClinic[]): VetClinic[] {
  return all.filter((c) => isApprovedClinic(c) && isActiveClinic(c));
}

/** The clinic name, or a stable placeholder, never a blank row. */
export function clinicName(c: VetClinic): string {
  return (c.name ?? '').trim();
}

/** Phone and address as one secondary line, omitting whichever is missing. */
export function clinicDetail(c: VetClinic): string {
  return [(c.phone ?? '').trim(), (c.address ?? '').trim()].filter((s) => s !== '').join(' · ');
}
