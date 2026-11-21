/**
 * Which `media_files` an Auntie works with.
 *
 * One collection holds every upload, told apart by `entityType`. The owner
 * reads all of it. An Auntie reads the files of her own work: a visit's
 * KinTale photos, a Kin's photos and a household's photos. Everything else
 * there is the owner's (Tribal Intel attachments, company media, another
 * person's account photo).
 *
 * `firestore.rules` holds that line for a direct client read or write. A
 * callable runs on the Admin SDK, which evaluates no rules, so a callable an
 * Auntie may invoke with a media file's id asks here instead. The rule and
 * this file must not disagree: the same five values, in the same spellings,
 * compared as stored with no case folding. `kin` and `kinfolk` are listed
 * because the desktop console's Gallery writes them that way. A file with no
 * `entityType` is the owner's.
 *
 * `test/caretakerMedia.test.ts` reads the list back out of `firestore.rules`
 * and out of admin web's `lib/caretakerScope.ts`, so a value added to one and
 * not the others fails there.
 */
export const CARETAKER_MEDIA_TYPES: readonly string[] = ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk'];

/** The stored type of an account photo. Hers is the one file of this type she works with. */
const ACCOUNT_PHOTO_TYPE = 'USER';

/**
 * May an Auntie signed in as `uid` work with this stored media file?
 *
 * Yes for the three kinds above, and for her own account photo (a `USER` file
 * on her own id), which her Account page uploads and then asks
 * `setMediaProfilePhoto` to apply. No for anything else, a missing document
 * included.
 */
export function caretakerMayUseMedia(
  media: { entityType?: unknown; entityId?: unknown } | undefined | null,
  uid: string,
): boolean {
  if (!media) return false;
  const type = media.entityType;
  if (typeof type !== 'string') return false;
  if (CARETAKER_MEDIA_TYPES.includes(type)) return true;
  return type === ACCOUNT_PHOTO_TYPE && uid !== '' && media.entityId === uid;
}
