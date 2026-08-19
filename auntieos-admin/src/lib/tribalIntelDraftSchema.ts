import { z } from 'zod';

/**
 * Client-side mirror of the Tribal Intel write contract, executable rather than
 * described (the `lib/kinTaleDraftSchema.ts` convention).
 *
 * The authority is the deployed backend, field for field:
 *   `MyTribe/functions/src/admin/createTrainingDocument.ts#TrainingDocumentArgs`
 *   `MyTribe/functions/src/admin/updateTrainingDocument.ts#UpdateTrainingDocumentArgs`
 * Both carry the same object shape plus the same two `.refine`s, so one schema
 * covers create and update; update only adds `docId`, which the api layer folds
 * in rather than the draft carrying it.
 *
 * WHY MIRROR AT ALL, given `firestore.rules` makes the callable the only write
 * path: the server answers a refinement failure with `invalid-argument` and a
 * `validationErrors` detail array, which surfaces to the operator as a raw
 * "createTrainingDocument validation failed" after a full round trip. Catching
 * the same two rules locally turns that into a message beside the field, before
 * the request leaves. The server still enforces everything; this never becomes
 * the only check.
 *
 * NOTHING HERE IS STRICTER THAN THE SERVER, on purpose (same rule
 * `lib/audienceSegmentEdit.ts` states): a client rule the server does not
 * enforce blocks a save the server would have accepted, and the operator has no
 * way to find out why.
 *
 * That rule is why `tribalIntelStaleTargetMessage` below is a MIRROR and not an
 * addition. As of issue #460 the server reads the referenced documents and
 * refuses a save whose target does not resolve
 * (`mytribe/functions/src/lib/resolveTribalIntelTarget.ts`), so a roster check
 * on this side blocks exactly the saves the server would have rejected — and
 * blocks them beside the picker, where the operator can see which value went
 * stale, instead of after a round trip.
 */

/** Server: `title: z.string().max(200)`. */
export const TRIBAL_INTEL_TITLE_MAX = 200;
/** Server: `content: z.string().max(20000)`. */
export const TRIBAL_INTEL_CONTENT_MAX = 20000;
/** Server: `notes: z.string().max(4000)`. */
export const TRIBAL_INTEL_NOTES_MAX = 4000;
/** Server: `attachments: z.array(AttachmentSchema).max(25)`. */
export const TRIBAL_INTEL_ATTACHMENTS_MAX = 25;

/**
 * The three targeting modes the server enum accepts, verbatim.
 *
 * HOUSEHOLD is the whole family under one roof, KINFOLK is one human client,
 * KIN is one animal (issue #393). The enum used to hold two values, and the
 * form labelled KINFOLK "Whole household", so an entry about one person was
 * stored and displayed as an entry about everyone.
 */
export type TribalIntelTargetType = 'HOUSEHOLD' | 'KINFOLK' | 'KIN';

/** Every target, in the order the form offers them. Widest first. */
export const TRIBAL_INTEL_TARGET_TYPES: readonly TribalIntelTargetType[] = ['HOUSEHOLD', 'KINFOLK', 'KIN'];

/**
 * The chip copy for each target. Byte-identical to Android's
 * `TrainingDocumentsScreen.kt#targetChipLabel`, so the same entry is described
 * with the same word on both clients.
 */
export function tribalIntelTargetTypeLabel(targetType: TribalIntelTargetType): string {
  switch (targetType) {
    case 'HOUSEHOLD':
      return 'Household';
    case 'KINFOLK':
      return 'Kinfolk';
    case 'KIN':
      return 'Kin';
  }
}

/**
 * One Cloudinary attachment, mirroring the backend `AttachmentSchema`.
 *
 * The field-level rules there (`storageUrl` a URL, `cloudinaryPublicId`
 * non-blank, the three length caps) are all satisfied by construction: every
 * attachment on a draft is produced by `api/tribalIntelWrite.ts`'s upload
 * pipeline off a real Cloudinary response, never typed by the operator. So the
 * only rule that can actually fire on this side is the array cap, and the
 * shape below stays a plain structural mirror rather than re-litigating values
 * a human can never enter wrong.
 */
export interface TribalIntelAttachmentDraft {
  storageUrl: string;
  cloudinaryPublicId: string;
  fileType: string;
  mimeType: string;
  fileName: string;
}

const attachmentSchema: z.ZodType<TribalIntelAttachmentDraft> = z.object({
  storageUrl: z.string(),
  cloudinaryPublicId: z.string(),
  fileType: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
});

/** What the form holds while the operator is typing. */
export interface TribalIntelDraft {
  title: string;
  content: string;
  notes: string;
  /**
   * Stamped `'note'` and not exposed as a field, matching the Android screen and
   * the archive ViewModel, which both hardcode `"note"` on save. Spec 23 item 3
   * rules that the comm-type source must be a real category list once one
   * exists, never operator free text, so no free-text input is invented here.
   */
  communicationType: string;
  targetType: TribalIntelTargetType;
  targetKinfolkId: string;
  targetKinId: string;
  attachments: TribalIntelAttachmentDraft[];
}

/**
 * A fresh, empty draft, targeted at the whole HOUSEHOLD.
 *
 * That is the same default the form has always had; only its name has been
 * corrected. It used to read `'KINFOLK'` under a chip that said "Whole
 * household", so the default silently claimed every new entry was about one
 * person. Household is also the safe default to leave untouched: it is the
 * widest target, so an operator who never opens the picker gets an entry
 * filed against everyone rather than against a person they did not name.
 */
export function blankTribalIntelDraft(): TribalIntelDraft {
  return {
    title: '',
    content: '',
    notes: '',
    communicationType: 'note',
    targetType: 'HOUSEHOLD',
    targetKinfolkId: '',
    targetKinId: '',
    attachments: [],
  };
}

export const tribalIntelDraftSchema = z
  .object({
    title: z.string().max(TRIBAL_INTEL_TITLE_MAX, `Keep the title under ${TRIBAL_INTEL_TITLE_MAX} characters.`),
    content: z
      .string()
      .max(TRIBAL_INTEL_CONTENT_MAX, `Keep the intel under ${TRIBAL_INTEL_CONTENT_MAX} characters.`),
    notes: z.string().max(TRIBAL_INTEL_NOTES_MAX, `Keep the notes under ${TRIBAL_INTEL_NOTES_MAX} characters.`),
    communicationType: z.string(),
    targetType: z.enum(['HOUSEHOLD', 'KINFOLK', 'KIN']),
    // Required for all three targets: `families/{kinfolkId}` is provisioned
    // under the same id as `kinfolk/{kinfolkId}`, so this one field anchors a
    // household note, a kinfolk note, and the household a kin belongs to.
    targetKinfolkId: z.string().min(1, 'Pick the household this intel belongs to.'),
    targetKinId: z.string(),
    attachments: z
      .array(attachmentSchema)
      .max(TRIBAL_INTEL_ATTACHMENTS_MAX, `Attach at most ${TRIBAL_INTEL_ATTACHMENTS_MAX} files to one entry.`),
  })
  // Server refinement 1: "Provide a title, content, or at least one attachment".
  // Reported on `content`, the field the operator is most likely looking at, so
  // the message lands somewhere rather than floating above the form.
  .refine((d) => d.title.trim() !== '' || d.content.trim() !== '' || d.attachments.length > 0, {
    message: 'Add a title, some intel, or an attachment before saving.',
    path: ['content'],
  })
  // Server refinement 2: "targetKinId is required when targetType is KIN".
  .refine((d) => d.targetType !== 'KIN' || d.targetKinId.trim() !== '', {
    message: 'Pick which pet this intel is about.',
    path: ['targetKinId'],
  });

/** Field name to its first message. An empty object means the draft is saveable. */
export type TribalIntelDraftErrors = Partial<Record<keyof TribalIntelDraft, string>>;

/**
 * Validates for inline display. Returns a field-keyed map rather than throwing,
 * because the form shows each message beside its own field and a thrown
 * ZodError would have to be caught and flattened by the caller anyway.
 */
export function validateTribalIntelDraft(draft: TribalIntelDraft): TribalIntelDraftErrors {
  const result = tribalIntelDraftSchema.safeParse(draft);
  if (result.success) return {};

  const errors: TribalIntelDraftErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    // First message per field wins: stacking several under one input is noise,
    // and the operator fixes them one at a time regardless.
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as keyof TribalIntelDraft] = issue.message;
    }
  }
  return errors;
}

// ── the stale target (issue #460) ────────────────────────────────────────

/** What the reference points at, for the wording of the message. */
export type TribalIntelTargetNoun = 'household' | 'kinfolk' | 'kin';

function targetNounCopy(noun: TribalIntelTargetNoun): { thing: string; action: string } {
  switch (noun) {
    case 'household':
      return { thing: 'household on the roster', action: 'Pick the right household' };
    case 'kinfolk':
      return { thing: 'kinfolk on the roster', action: 'Pick the right kinfolk' };
    case 'kin':
      return { thing: 'pet on the roster', action: 'Pick the right pet' };
  }
}

/**
 * The message for a stored reference the roster cannot place, or `null` when
 * there is nothing wrong with it.
 *
 * WHY THIS EXISTS (issue #460): rows imported from the old system store a
 * person's NAME where newer rows store an id. Opening one seeded the picker
 * with that name, no `<option>` matched, and the picker fell back to its
 * placeholder — so the editor showed a blank target for a note that did name
 * somebody, and saving wrote the name straight back. The form now keeps the
 * stored value on screen and says why it cannot be saved, because a note
 * silently detached from whoever it was about is worse than one that says it is
 * pointing at something unresolvable.
 *
 * `null` WHILE THE ROSTER IS EMPTY, deliberately. An empty list means the
 * directory has not loaded yet, not that every id in the world is stale;
 * without this guard every edit opened during that first moment would accuse
 * its own target of being broken.
 */
export function tribalIntelStaleTargetMessage(
  storedId: string,
  rosterIds: readonly string[],
  noun: TribalIntelTargetNoun,
): string | null {
  const id = storedId.trim();
  if (id === '') return null;
  if (rosterIds.length === 0) return null;
  if (rosterIds.includes(id)) return null;
  const { thing, action } = targetNounCopy(noun);
  return `This entry points at "${id}", which is not a ${thing}. ${action}. It cannot be saved as it stands.`;
}

/**
 * The label the picker shows for a stale value, so the operator can read what
 * the note was filed against rather than an empty select.
 */
export function tribalIntelStaleOptionLabel(storedId: string): string {
  return `Unresolved: "${storedId.trim()}"`;
}

/**
 * The roster half of validation: which target fields name nothing the directory
 * holds. Separate from `validateTribalIntelDraft` because it needs the loaded
 * directory, which the schema has no business knowing about.
 *
 * `kinIds` must be EVERY pet, archived ones included. The server checks the pet
 * exists, not that it is active, so narrowing this to the active list would
 * block a save the server would have accepted — the one thing this module
 * promises never to do.
 */
export function validateTribalIntelTargetRoster(
  draft: TribalIntelDraft,
  kinfolkIds: readonly string[],
  kinIds: readonly string[],
): TribalIntelDraftErrors {
  const errors: TribalIntelDraftErrors = {};
  const anchor = tribalIntelStaleTargetMessage(
    draft.targetKinfolkId,
    kinfolkIds,
    draft.targetType === 'KINFOLK' ? 'kinfolk' : 'household',
  );
  if (anchor !== null) errors.targetKinfolkId = anchor;
  if (draft.targetType === 'KIN') {
    const pet = tribalIntelStaleTargetMessage(draft.targetKinId, kinIds, 'kin');
    if (pet !== null) errors.targetKinId = pet;
  }
  return errors;
}

/** Whether Save can run at all. Ports the archive `TribalIntelDraft.canSave`. */
export function canSaveTribalIntelDraft(draft: TribalIntelDraft): boolean {
  return tribalIntelDraftSchema.safeParse(draft).success;
}

/** The wire shape of a create, and of an update once `docId` is folded in. */
export interface TribalIntelCallableArgs {
  title: string;
  content: string;
  notes: string;
  communicationType: string;
  targetType: TribalIntelTargetType;
  targetKinfolkId: string;
  targetKinId?: string;
  attachments: TribalIntelAttachmentDraft[];
}

/**
 * Builds the callable payload from a draft.
 *
 * `targetKinId` is OMITTED entirely on a household-targeted save rather than
 * sent blank: the server's own write already coerces it to `''` when
 * `targetType` is KINFOLK, so shipping a stale pet id would be a value the
 * server has to throw away, and shipping `undefined` under a present key is a
 * shape the callable serializer treats differently from an absent one.
 *
 * Text is trimmed here, matching the fields the server refinements themselves
 * `.trim()` before judging.
 */
export function tribalIntelCallableArgs(draft: TribalIntelDraft): TribalIntelCallableArgs {
  const base: TribalIntelCallableArgs = {
    title: draft.title.trim(),
    content: draft.content.trim(),
    notes: draft.notes.trim(),
    communicationType: draft.communicationType.trim() === '' ? 'note' : draft.communicationType.trim(),
    targetType: draft.targetType,
    targetKinfolkId: draft.targetKinfolkId.trim(),
    attachments: draft.attachments,
  };
  if (draft.targetType !== 'KIN') return base;
  return { ...base, targetKinId: draft.targetKinId.trim() };
}
