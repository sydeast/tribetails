import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The FULL household record at `kinfolk/{id}` (rules: `allow read: if isAuntie()`),
 * for the profile detail view. The Directory LIST type (`api/directory.ts#Kinfolk`)
 * carries only list fields; a household profile needs the rich contact / home-access
 * / emergency / vet fields the wasm `KinfolkProfileScreen` renders, so this is read
 * directly via a one-shot getDoc (the `api/account.ts` pattern; there is no
 * getKinfolkProfile callable, and useCollection is collection-only).
 *
 * A subset of the real doc, not a blind mirror: booking/dossier fields belong to
 * other surfaces and are intentionally omitted (the directory.ts convention).
 * `tags` IS modeled: the KinTale condition engine (`lib/kinTale/engine.ts`)
 * evaluates KINFOLK_TAG conditions against it, and it exists on the `kinfolk`
 * doc in Firestore (the Kotlin `Kinfolk` model carries `tags: List<String>`).
 * Every field is defaulted so a legacy/partial doc never renders `undefined`.
 */
export interface KinfolkProfile {
  _id: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  profilePictureUrl: string;
  status: string;
  joinDate: string;
  /** Household tags (e.g. "VIP"); the KinTale engine's KINFOLK_TAG source. */
  tags: string[];
  // Contact & Identity
  secondaryPhone: string;
  secondaryEmail: string;
  preferredContactMethod: string;
  bestTimeToContact: string;
  // Home & Access
  serviceAddress: string;
  gateCode: string;
  parkingInstructions: string;
  entryNotes: string;
  wifiName: string;
  wifiPassword: string;
  // Emergency
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  // Vet clinic (household-level)
  vetClinicName: string;
  vetClinicAddress: string;
  vetClinicPhone: string;
  /**
   * The `vet_clinics` doc this household's vet is joined to, or '' for a legacy
   * record whose vet is a plain typed string. The three fields above stay
   * DENORMALIZED alongside it on purpose: an Auntie on a doorstep needs the
   * clinic phone off the household doc without a second read, and a clinic
   * renamed or removed from the shared bank must not blank the number on file.
   * Every household predating 2026-07-25 has the strings and no id, which is a
   * valid state the UI renders rather than treating as broken.
   */
  vetClinicId: string;
  // Emergency vet (household-level, same id + denormalized shape)
  emergencyVetClinicId: string;
  emergencyVetClinicName: string;
  emergencyVetClinicAddress: string;
  emergencyVetClinicPhone: string;
}

const EMPTY: Omit<KinfolkProfile, '_id'> = {
  firstName: '', lastName: '', phoneNumber: '', email: '', profilePictureUrl: '', status: 'active', joinDate: '', tags: [],
  secondaryPhone: '', secondaryEmail: '', preferredContactMethod: '', bestTimeToContact: '',
  serviceAddress: '', gateCode: '', parkingInstructions: '', entryNotes: '', wifiName: '', wifiPassword: '',
  emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelation: '',
  vetClinicName: '', vetClinicAddress: '', vetClinicPhone: '', vetClinicId: '',
  emergencyVetClinicId: '', emergencyVetClinicName: '', emergencyVetClinicAddress: '',
  emergencyVetClinicPhone: '',
};

/** Defensive field-by-field merge over the empty shape (never `undefined`, never fabricates). */
export function mergeKinfolkProfile(id: string, raw: Record<string, unknown> | undefined | null): KinfolkProfile {
  const r = (raw ?? {}) as Partial<KinfolkProfile>;
  const s = (v: unknown, def: string): string => (typeof v === 'string' ? v : def);
  /** Keep only string entries; a legacy/malformed `tags` never yields `undefined` rows. */
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    _id: id,
    tags: arr(r.tags),
    firstName: s(r.firstName, EMPTY.firstName),
    lastName: s(r.lastName, EMPTY.lastName),
    phoneNumber: s(r.phoneNumber, EMPTY.phoneNumber),
    email: s(r.email, EMPTY.email),
    profilePictureUrl: s(r.profilePictureUrl, EMPTY.profilePictureUrl),
    status: s(r.status, EMPTY.status),
    joinDate: s(r.joinDate, EMPTY.joinDate),
    secondaryPhone: s(r.secondaryPhone, EMPTY.secondaryPhone),
    secondaryEmail: s(r.secondaryEmail, EMPTY.secondaryEmail),
    preferredContactMethod: s(r.preferredContactMethod, EMPTY.preferredContactMethod),
    bestTimeToContact: s(r.bestTimeToContact, EMPTY.bestTimeToContact),
    serviceAddress: s(r.serviceAddress, EMPTY.serviceAddress),
    gateCode: s(r.gateCode, EMPTY.gateCode),
    parkingInstructions: s(r.parkingInstructions, EMPTY.parkingInstructions),
    entryNotes: s(r.entryNotes, EMPTY.entryNotes),
    wifiName: s(r.wifiName, EMPTY.wifiName),
    wifiPassword: s(r.wifiPassword, EMPTY.wifiPassword),
    emergencyContactName: s(r.emergencyContactName, EMPTY.emergencyContactName),
    emergencyContactPhone: s(r.emergencyContactPhone, EMPTY.emergencyContactPhone),
    emergencyContactRelation: s(r.emergencyContactRelation, EMPTY.emergencyContactRelation),
    vetClinicName: s(r.vetClinicName, EMPTY.vetClinicName),
    vetClinicAddress: s(r.vetClinicAddress, EMPTY.vetClinicAddress),
    vetClinicPhone: s(r.vetClinicPhone, EMPTY.vetClinicPhone),
    vetClinicId: s(r.vetClinicId, EMPTY.vetClinicId),
    emergencyVetClinicId: s(r.emergencyVetClinicId, EMPTY.emergencyVetClinicId),
    emergencyVetClinicName: s(r.emergencyVetClinicName, EMPTY.emergencyVetClinicName),
    emergencyVetClinicAddress: s(r.emergencyVetClinicAddress, EMPTY.emergencyVetClinicAddress),
    emergencyVetClinicPhone: s(r.emergencyVetClinicPhone, EMPTY.emergencyVetClinicPhone),
  };
}

/**
 * One-shot read of `kinfolk/{id}`. A MISSING doc throws (a profile is only ever
 * opened from an existing Directory card, so a missing household is a real error
 * the screen surfaces fail-loud, not a silent empty). A read rejection propagates.
 */
export async function getKinfolkProfile(id: string): Promise<KinfolkProfile> {
  const snap = await getDoc(doc(db, 'kinfolk', id));
  if (!snap.exists()) throw new Error(`Household not found: ${id}`);
  return mergeKinfolkProfile(id, snap.data() as Record<string, unknown>);
}
