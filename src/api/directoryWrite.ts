import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The write half of api/directory.ts (that file stays read-only, matching the
 * account.ts / accountWrite.ts split). Directory's two "Add" flows create the
 * households (`kinfolk`) and pets (`kin`) the read side already streams.
 *
 * CREATE PATH, confirmed against BOTH ends before writing a line here:
 *
 *   No `createKinfolk` / `addKinfolk` / `createKin` callable exists anywhere in
 *   MyTribe/functions/src (grepped the whole tree). The only kin-create
 *   callable that exists, `addKin` in functions/src/portal/kinWrites.ts, is the
 *   KINFOLK PORTAL's own self-service callable: it resolves the target
 *   household from the CALLER's `clients/{uid}.kinfolkIds` allowlist before it
 *   ever checks a permission, so an admin operator (who has no `clients` doc,
 *   or one scoped to their own account, not an arbitrary household) cannot use
 *   it to create a pet into a household of the admin's choosing. It is the
 *   wrong tool for this screen, not a substitute.
 *
 *   The wasm admin itself creates both directly on the client:
 *   `FirestoreClient.createKinfolk` -> `platformCreateKinfolk` ->
 *   `jsAddDoc("kinfolk", ...)`, and `createKin` -> `platformCreateKin` ->
 *   `jsAddDoc("kin", ...)` (web/composeApp/.../FirestoreInterop.wasmJs.kt).
 *   `firestore.rules` backs this: `match /kinfolk/{kinfolkId} { allow write:
 *   if isAuntie() || ... }` and `match /kin/{docId} { allow create: if
 *   isAuntie() || ... }`. So this is a genuine, rules-backed DIRECT WRITE, not
 *   a missing callable this port has to invent one for.
 *
 * ONE DELIBERATE ADDITION beyond a literal port: `createKin` stamps
 * `updatedAt: serverTimestamp()` on the new doc, which neither the wasm's Kin
 * model nor its `jsAddDoc` payload includes. Reason: KIN_QUERY (api/directory.ts)
 * orders the flat `kin` collection by `updatedAt` with NO `where` filter, and
 * Firestore's `orderBy` excludes any doc missing the sort field entirely (the
 * KNOWN TRADEOFF that file already documents). The only writer that normally
 * stamps `updatedAt` on a flat `kin` doc is the `onFamilyKinWrite` trigger's
 * family -> flat mirror, which never fires for a pet created directly here
 * (no `families/{kinfolkId}/kin/{kinId}` doc exists for it, so there is no
 * family-side write to mirror). Skipping the stamp would mean a freshly
 * created kin silently never appears in the Kin tab's own live list, the exact
 * "created but invisible" failure this port refuses to ship. Every other field
 * is copied from the wasm `Kin`/`Kinfolk` write path as-is.
 */

// ── Kinfolk (household) ──────────────────────────────────────────────────────

/** Ports the wasm create-only status choice (`KinfolkEditScreen.kt`'s
 * `SegmentedPicker(options = listOf("prospect", "active"), ...)`, shown ONLY
 * on the create path). Kinfolk gains "inactive" / "archived" later, through
 * the (not yet ported) edit/archive screen, not here. */
export type NewKinfolkStatus = 'prospect' | 'active';

export const NEW_KINFOLK_STATUS_OPTIONS: readonly NewKinfolkStatus[] = ['prospect', 'active'];

export interface NewKinfolkInput {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  status: NewKinfolkStatus;
  /** The wasm/rules field name is `serviceAddress`; this screen's field label is "Address". */
  serviceAddress: string;
}

/**
 * Creates a new household in the top-level `kinfolk` collection. Mirrors
 * `KinfolkEditScreen.kt#build()` -> `client.createKinfolk(draft)` for the
 * fields this screen actually collects (name/first/last, phone, email,
 * status, address); every other field on the full wasm `Kinfolk` model
 * (emergency contact, vet clinic, wifi/gate access, referral, internal notes,
 * formValues, ...) is left at its real Kotlin default rather than fabricated
 * here, so a later full edit screen finds exactly the blanks the wasm editor
 * would have left too.
 *
 * `joinDate` is left `''` on purpose: neither the wasm (`KinfolkEditScreen.kt`,
 * grepped for `joinDate`, zero hits) nor the Android editor auto-stamps it on
 * create, and no MyTribe function stamps it either (see the `joinDate` doc on
 * `Kinfolk` in api/directory.ts). That is a real, verified cross-platform quirk,
 * not something this port silently "fixes" by inventing a default the source
 * never had.
 *
 * Requires firstName + lastName (ports `firstNameError` / `lastNameError`,
 * the two fields the wasm's `canSave` always enforces regardless of which
 * other optional fields this trimmed-down form omits).
 */
export async function createKinfolk(input: NewKinfolkInput): Promise<string> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (firstName === '') throw new Error('createKinfolk requires a first name');
  if (lastName === '') throw new Error('createKinfolk requires a last name');

  const ref = await addDoc(collection(db, 'kinfolk'), {
    firstName,
    lastName,
    phoneNumber: input.phoneNumber.trim(),
    email: input.email.trim(),
    status: input.status,
    serviceAddress: input.serviceAddress.trim(),
    profilePictureUrl: '',
    joinDate: '',
  });
  return ref.id;
}

// ── Kin (pet) ────────────────────────────────────────────────────────────────

/** Ports `KinEditScreen.kt`'s `SPECIES_OPTIONS` verbatim. */
export const NEW_KIN_SPECIES_OPTIONS: readonly string[] = [
  'Dog',
  'Cat',
  'Bird',
  'Rabbit',
  'Reptile',
  'Small mammal',
  'Other',
];

/** Ports `KinEditScreen.kt`'s `GENDER_OPTIONS` verbatim (model key stays `sex`, the source's own note: "relabel Sex -> Gender, model key kept to avoid a schema migration"). */
export const NEW_KIN_SEX_OPTIONS: readonly string[] = ['Male', 'Female', 'Unknown'];

export interface NewKinInput {
  /** The household this pet belongs to. Required, there is no ownerless kin in this schema. */
  kinfolkId: string;
  name: string;
  species: string;
  breed: string;
  age: string;
  sex: string;
}

/**
 * Creates a new pet in the top-level `kin` collection (the flat mirror
 * collection this admin reads, see api/directory.ts's KIN_QUERY doc). Mirrors
 * `KinEditScreen.kt#build()` -> `client.createKin(draft)`: `status` is NEVER
 * user-editable on create in the source (`build()`'s `status = existing?.status
 * ?: "active"`, always `"active"` when `existing` is null; the only status
 * control anywhere on this screen is the separate archive action), so this
 * function does not accept a status input either, it always writes "active".
 *
 * Requires kinfolkId (a household must be chosen), name, species, and sex,
 * ports the wasm's `canSave = name.isNotBlank() && species.isNotBlank() &&
 * sex.isNotBlank()` exactly. Breed and age stay optional, same as the source.
 */
export async function createKin(input: NewKinInput): Promise<string> {
  const kinfolkId = input.kinfolkId.trim();
  const name = input.name.trim();
  const species = input.species.trim();
  const sex = input.sex.trim();
  if (kinfolkId === '') throw new Error('createKin requires a household (kinfolkId)');
  if (name === '') throw new Error('createKin requires a name');
  if (species === '') throw new Error('createKin requires a species');
  if (sex === '') throw new Error('createKin requires a gender');

  const ref = await addDoc(collection(db, 'kin'), {
    kinfolkId,
    name,
    species,
    breed: input.breed.trim(),
    age: input.age.trim(),
    sex,
    status: 'active',
    profilePictureUrl: '',
    // See the file header: stamped here so this pet is not silently invisible
    // to KIN_QUERY's `orderBy('updatedAt', 'desc')` the instant it is created.
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}
