import { describe, it, expect } from 'vitest';
import {
  TRIBAL_INTEL_ATTACHMENTS_MAX,
  TRIBAL_INTEL_CONTENT_MAX,
  TRIBAL_INTEL_NOTES_MAX,
  TRIBAL_INTEL_TARGET_TYPES,
  TRIBAL_INTEL_TITLE_MAX,
  blankTribalIntelDraft,
  canSaveTribalIntelDraft,
  tribalIntelCallableArgs,
  tribalIntelStaleOptionLabel,
  tribalIntelStaleTargetMessage,
  tribalIntelTargetTypeLabel,
  validateTribalIntelDraft,
  validateTribalIntelTargetRoster,
  type TribalIntelDraft,
} from './tribalIntelDraftSchema';

function draft(over: Partial<TribalIntelDraft> = {}): TribalIntelDraft {
  return {
    ...blankTribalIntelDraft(),
    content: 'Mrs. Whitfield mentioned Biscuit limps after long walks.',
    targetKinfolkId: 'kf1',
    ...over,
  };
}

describe('tribalIntelDraftSchema', () => {
  it('mirrors the server maxima exactly', () => {
    expect(TRIBAL_INTEL_TITLE_MAX).toBe(200);
    expect(TRIBAL_INTEL_CONTENT_MAX).toBe(20000);
    expect(TRIBAL_INTEL_NOTES_MAX).toBe(4000);
    expect(TRIBAL_INTEL_ATTACHMENTS_MAX).toBe(25);
  });

  it('accepts a household-targeted draft with content', () => {
    expect(validateTribalIntelDraft(draft())).toEqual({});
    expect(canSaveTribalIntelDraft(draft())).toBe(true);
  });

  // ── refinement 1: must have title OR content OR an attachment ──────────────

  it('rejects a draft with no title, no content, and no attachment (server refinement 1)', () => {
    const errors = validateTribalIntelDraft(draft({ title: '', content: '', attachments: [] }));
    expect(errors.content).toBe('Add a title, some intel, or an attachment before saving.');
    expect(canSaveTribalIntelDraft(draft({ title: '', content: '', attachments: [] }))).toBe(false);
  });

  it('treats whitespace-only title and content as empty, same as the server trim', () => {
    const errors = validateTribalIntelDraft(draft({ title: '   ', content: '\n\t ' }));
    expect(errors.content).toBe('Add a title, some intel, or an attachment before saving.');
  });

  it('accepts a title-only draft', () => {
    expect(validateTribalIntelDraft(draft({ title: 'Gate code changed', content: '' }))).toEqual({});
  });

  it('accepts an attachment-only draft (no title, no content)', () => {
    const withAttachment = draft({
      title: '',
      content: '',
      attachments: [
        {
          storageUrl: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg',
          cloudinaryPublicId: 'tribetails/tribal_intel/pending/a',
          fileType: 'IMAGE',
          mimeType: 'image/jpeg',
          fileName: 'a.jpg',
        },
      ],
    });
    expect(validateTribalIntelDraft(withAttachment)).toEqual({});
    expect(canSaveTribalIntelDraft(withAttachment)).toBe(true);
  });

  // ── refinement 2: targetKinId required when targetType is KIN ──────────────

  it('rejects targetType KIN with no targetKinId (server refinement 2)', () => {
    const errors = validateTribalIntelDraft(draft({ targetType: 'KIN', targetKinId: '' }));
    expect(errors.targetKinId).toBe('Pick which pet this intel is about.');
    expect(canSaveTribalIntelDraft(draft({ targetType: 'KIN', targetKinId: '' }))).toBe(false);
  });

  it('accepts targetType KIN once a pet is chosen', () => {
    expect(validateTribalIntelDraft(draft({ targetType: 'KIN', targetKinId: 'kin9' }))).toEqual({});
  });

  it('does not require a pet when targetType is KINFOLK', () => {
    expect(validateTribalIntelDraft(draft({ targetType: 'KINFOLK', targetKinId: '' }))).toEqual({});
  });

  // ── target household ──────────────────────────────────────────────────────

  it('requires a household, matching the server min(1) on targetKinfolkId', () => {
    const errors = validateTribalIntelDraft(draft({ targetKinfolkId: '' }));
    expect(errors.targetKinfolkId).toBe('Pick the household this intel belongs to.');
  });

  // ── length caps ───────────────────────────────────────────────────────────

  it('rejects an over-length title before a round trip', () => {
    const errors = validateTribalIntelDraft(draft({ title: 'x'.repeat(201) }));
    expect(errors.title).toBe('Keep the title under 200 characters.');
  });

  it('rejects over-length content and notes', () => {
    expect(validateTribalIntelDraft(draft({ content: 'x'.repeat(20001) })).content).toBe(
      'Keep the intel under 20000 characters.',
    );
    expect(validateTribalIntelDraft(draft({ notes: 'x'.repeat(4001) })).notes).toBe(
      'Keep the notes under 4000 characters.',
    );
  });

  it('rejects more than 25 attachments', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      storageUrl: `https://res.cloudinary.com/x/image/upload/v1/${i}.jpg`,
      cloudinaryPublicId: `p${i}`,
      fileType: 'IMAGE',
      mimeType: 'image/jpeg',
      fileName: `${i}.jpg`,
    }));
    expect(validateTribalIntelDraft(draft({ attachments: many })).attachments).toBe(
      'Attach at most 25 files to one entry.',
    );
  });

  // ── callable args ─────────────────────────────────────────────────────────

  it('builds the exact callable payload for a household target, omitting targetKinId entirely', () => {
    expect(tribalIntelCallableArgs(draft({ title: '  Gate code  ', notes: ' seen at pickup ' }))).toEqual({
      title: 'Gate code',
      content: 'Mrs. Whitfield mentioned Biscuit limps after long walks.',
      notes: 'seen at pickup',
      communicationType: 'note',
      targetType: 'HOUSEHOLD',
      targetKinfolkId: 'kf1',
      attachments: [],
    });
  });

  it('includes targetKinId only when the target is a single pet', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'KIN', targetKinId: 'kin9' }));
    expect(args.targetType).toBe('KIN');
    expect(args.targetKinId).toBe('kin9');
  });

  it('never leaks a stale pet id onto a household-targeted save', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'HOUSEHOLD', targetKinId: 'kin9' }));
    expect('targetKinId' in args).toBe(false);
  });

  it('never leaks a stale pet id onto a kinfolk-targeted save', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'KINFOLK', targetKinId: 'kin9' }));
    expect('targetKinId' in args).toBe(false);
  });
});

// ── the three targets (issue #393) ────────────────────────────────────────

describe('Tribal Intel targets', () => {
  it('offers exactly household, kinfolk and kin, widest first', () => {
    expect([...TRIBAL_INTEL_TARGET_TYPES]).toEqual(['HOUSEHOLD', 'KINFOLK', 'KIN']);
  });

  it('labels each target with the operator\'s own word', () => {
    expect(tribalIntelTargetTypeLabel('HOUSEHOLD')).toBe('Household');
    expect(tribalIntelTargetTypeLabel('KINFOLK')).toBe('Kinfolk');
    expect(tribalIntelTargetTypeLabel('KIN')).toBe('Kin');
  });

  it('starts a new entry on the household, the widest target', () => {
    // It used to start on KINFOLK under a chip reading "Whole household", so
    // every untouched entry claimed to be about one person.
    expect(blankTribalIntelDraft().targetType).toBe('HOUSEHOLD');
  });

  it('accepts a saveable draft for each of the three targets', () => {
    expect(canSaveTribalIntelDraft(draft({ targetType: 'HOUSEHOLD' }))).toBe(true);
    expect(canSaveTribalIntelDraft(draft({ targetType: 'KINFOLK' }))).toBe(true);
    expect(canSaveTribalIntelDraft(draft({ targetType: 'KIN', targetKinId: 'kin9' }))).toBe(true);
  });

  it('builds a household payload that names the household and no animal', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'HOUSEHOLD' }));
    expect(args.targetType).toBe('HOUSEHOLD');
    expect(args.targetKinfolkId).toBe('kf1');
    expect('targetKinId' in args).toBe(false);
  });

  it('builds a kinfolk payload that names one human client and no animal', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'KINFOLK' }));
    expect(args.targetType).toBe('KINFOLK');
    expect(args.targetKinfolkId).toBe('kf1');
    expect('targetKinId' in args).toBe(false);
  });

  it('builds a kin payload that names the animal and the household it lives in', () => {
    const args = tribalIntelCallableArgs(draft({ targetType: 'KIN', targetKinId: 'kin9' }));
    expect(args.targetType).toBe('KIN');
    expect(args.targetKinfolkId).toBe('kf1');
    expect(args.targetKinId).toBe('kin9');
  });

  it('still demands a pet id from a kin-targeted draft, and only from that one', () => {
    expect(validateTribalIntelDraft(draft({ targetType: 'KIN', targetKinId: '' })).targetKinId).toBe(
      'Pick which pet this intel is about.',
    );
    expect(validateTribalIntelDraft(draft({ targetType: 'HOUSEHOLD', targetKinId: '' }))).toEqual({});
    expect(validateTribalIntelDraft(draft({ targetType: 'KINFOLK', targetKinId: '' }))).toEqual({});
  });

  it('demands a household anchor for every target, kin included', () => {
    for (const targetType of TRIBAL_INTEL_TARGET_TYPES) {
      const errors = validateTribalIntelDraft(
        draft({ targetType, targetKinfolkId: '', targetKinId: 'kin9' }),
      );
      expect(errors.targetKinfolkId).toBe('Pick the household this intel belongs to.');
    }
  });
});

/**
 * Issue #460: the target must be an id the roster holds, and a stored value it
 * cannot place has to stay readable rather than vanish.
 */
describe('tribalIntelStaleTargetMessage', () => {
  const roster = ['kf1', 'kf2'];
  it('is silent about an id the roster holds', () => {
    expect(tribalIntelStaleTargetMessage('kf1', roster, 'household')).toBeNull();
  });
  it('is silent about a blank value: an unset target is a different complaint', () => {
    expect(tribalIntelStaleTargetMessage('', roster, 'household')).toBeNull();
    expect(tribalIntelStaleTargetMessage('   ', roster, 'household')).toBeNull();
  });
  it('is silent while the roster is empty, because that means "not loaded yet"', () => {
    expect(tribalIntelStaleTargetMessage('Marla Whitfield', [], 'household')).toBeNull();
  });
  it('names the value and the fix for a stored NAME', () => {
    const msg = tribalIntelStaleTargetMessage('Marla Whitfield', roster, 'household');
    expect(msg).toContain('"Marla Whitfield"');
    expect(msg).toContain('not a household on the roster');
    expect(msg).toContain('Pick the right household');
  });
  it('uses the noun the picker uses for each target', () => {
    expect(tribalIntelStaleTargetMessage('x', roster, 'kinfolk')).toContain('kinfolk on the roster');
    expect(tribalIntelStaleTargetMessage('x', roster, 'kin')).toContain('pet on the roster');
  });
  it('labels the stale option with the value itself', () => {
    expect(tribalIntelStaleOptionLabel('Marla Whitfield')).toBe('Unresolved: "Marla Whitfield"');
  });
});
describe('validateTribalIntelTargetRoster', () => {
  const kinfolkIds = ['kf1'];
  const kinIds = ['kin1', 'kin-archived'];
  it('passes a draft whose ids are all on the roster', () => {
    expect(validateTribalIntelTargetRoster(draft(), kinfolkIds, kinIds)).toEqual({});
  });
  it('flags an anchor the roster cannot place', () => {
    const errors = validateTribalIntelTargetRoster(
      draft({ targetKinfolkId: 'Marla Whitfield' }),
      kinfolkIds,
      kinIds,
    );
    expect(errors.targetKinfolkId).toContain('"Marla Whitfield"');
  });
  it('only judges the pet on a KIN-targeted draft', () => {
    expect(
      validateTribalIntelTargetRoster(draft({ targetKinId: 'Biscuit' }), kinfolkIds, kinIds).targetKinId,
    ).toBeUndefined();
    expect(
      validateTribalIntelTargetRoster(
        draft({ targetType: 'KIN', targetKinId: 'Biscuit' }),
        kinfolkIds,
        kinIds,
      ).targetKinId,
    ).toContain('"Biscuit"');
  });
  it('accepts an ARCHIVED pet, because the server checks existence and not status', () => {
    // Stricter than the server is the one thing this module promises never to be.
    expect(
      validateTribalIntelTargetRoster(
        draft({ targetType: 'KIN', targetKinId: 'kin-archived' }),
        kinfolkIds,
        kinIds,
      ),
    ).toEqual({});
  });
});
