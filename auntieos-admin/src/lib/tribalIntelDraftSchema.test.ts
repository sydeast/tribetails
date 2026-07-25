import { describe, it, expect } from 'vitest';
import {
  TRIBAL_INTEL_ATTACHMENTS_MAX,
  TRIBAL_INTEL_CONTENT_MAX,
  TRIBAL_INTEL_NOTES_MAX,
  TRIBAL_INTEL_TITLE_MAX,
  blankTribalIntelDraft,
  canSaveTribalIntelDraft,
  tribalIntelCallableArgs,
  validateTribalIntelDraft,
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
      targetType: 'KINFOLK',
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
    const args = tribalIntelCallableArgs(draft({ targetType: 'KINFOLK', targetKinId: 'kin9' }));
    expect('targetKinId' in args).toBe(false);
  });
});
