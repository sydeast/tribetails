import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The FULL pet record at `kin/{id}` (rules: `allow read: if isAuntie()`), for the
 * kin detail view. The Directory LIST type (`api/directory.ts#Kin`) carries only
 * list fields; a pet profile needs the care / health / behavior fields the wasm
 * `Kin` model holds, read directly via a one-shot getDoc (the `api/kinfolkProfile.ts`
 * pattern). A subset of the doc (formValues/timestamps omitted); every field is
 * defaulted so a legacy/partial doc never renders `undefined`. `checklist` is
 * included because the KinTale condition engine (`lib/kinTale/engine.ts`) reads
 * it as a catalogued attribute.
 */
export interface KinDetail {
  _id: string;
  kinfolkId: string;
  name: string;
  species: string;
  breed: string;
  age: string;
  sex: string;
  weight: string;
  status: string;
  profilePictureUrl: string;
  colorMarkings: string;
  spayedNeutered: boolean;
  reactive: boolean;
  staysAs: string;
  routine: string;
  trainingCommands: string;
  feedingBrand: string;
  vaccinations: string;
  medicationHealthNotes: string;
  vetInfo: string;
  officeNotes: string;
  /**
   * Free-text care checklist on the pet doc. Read by the KinTale condition
   * engine (`lib/kinTale/engine.ts`, KIN_ATTRIBUTE key `checklist`). It exists
   * in Firestore on the `kin` doc (the Kotlin `Kin` model carries it); modeled
   * here so the engine can resolve the catalogued `checklist` attribute rather
   * than reading it as blank.
   */
  checklist: string;
  ownerEmail: string;
  ownerPhone: string;
}

const EMPTY: Omit<KinDetail, '_id'> = {
  kinfolkId: '', name: '', species: 'Dog', breed: '', age: '', sex: '', weight: '', status: 'active',
  profilePictureUrl: '', colorMarkings: '', spayedNeutered: false, reactive: false,
  staysAs: '', routine: '', trainingCommands: '', feedingBrand: '', vaccinations: '',
  medicationHealthNotes: '', vetInfo: '', officeNotes: '', checklist: '', ownerEmail: '', ownerPhone: '',
};

/** Defensive field-by-field merge (never `undefined`, never fabricates a value). */
export function mergeKinDetail(id: string, raw: Record<string, unknown> | undefined | null): KinDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown, def: string): string => (typeof v === 'string' ? v : def);
  const b = (v: unknown): boolean => v === true;
  return {
    _id: id,
    kinfolkId: s(r.kinfolkId, EMPTY.kinfolkId),
    name: s(r.name, EMPTY.name),
    species: s(r.species, EMPTY.species),
    breed: s(r.breed, EMPTY.breed),
    age: s(r.age, EMPTY.age),
    sex: s(r.sex, EMPTY.sex),
    weight: s(r.weight, EMPTY.weight),
    status: s(r.status, EMPTY.status),
    profilePictureUrl: s(r.profilePictureUrl, EMPTY.profilePictureUrl),
    colorMarkings: s(r.colorMarkings, EMPTY.colorMarkings),
    spayedNeutered: b(r.spayedNeutered),
    reactive: b(r.reactive),
    staysAs: s(r.staysAs, EMPTY.staysAs),
    routine: s(r.routine, EMPTY.routine),
    trainingCommands: s(r.trainingCommands, EMPTY.trainingCommands),
    feedingBrand: s(r.feedingBrand, EMPTY.feedingBrand),
    vaccinations: s(r.vaccinations, EMPTY.vaccinations),
    medicationHealthNotes: s(r.medicationHealthNotes, EMPTY.medicationHealthNotes),
    vetInfo: s(r.vetInfo, EMPTY.vetInfo),
    officeNotes: s(r.officeNotes, EMPTY.officeNotes),
    checklist: s(r.checklist, EMPTY.checklist),
    ownerEmail: s(r.ownerEmail, EMPTY.ownerEmail),
    ownerPhone: s(r.ownerPhone, EMPTY.ownerPhone),
  };
}

/**
 * One-shot read of `kin/{id}`. A MISSING doc throws (a kin is only ever opened
 * from an existing Directory card, so a missing pet is a real fail-loud error,
 * not a silent empty). A read rejection propagates.
 */
export async function getKin(id: string): Promise<KinDetail> {
  const snap = await getDoc(doc(db, 'kin', id));
  if (!snap.exists()) throw new Error(`Kin not found: ${id}`);
  return mergeKinDetail(id, snap.data() as Record<string, unknown>);
}
