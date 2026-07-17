import { describe, it, expect } from 'vitest';
import type { TemplateSummary } from '../api/templates';
import {
  templateRowTitle,
  templateSubjectPreview,
  previewTags,
  isUntagged,
  filterTemplates,
  templateCategoryState,
  templateCategoryDisplay,
  categoryMatchesFilter,
  categoryCount,
  templateToFormFields,
  blankFormFields,
  parseTagsInput,
  formatTagsInput,
  templateIdError,
  templateFormError,
  buildSaveTemplatePayload,
  type TemplateFormFields,
} from './templateFormat';

function tpl(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    templateId: 'booking.confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: null,
    title: 'Booking Confirmed',
    description: null,
    tags: [],
    category: null,
    ...over,
  };
}

function fields(over: Partial<TemplateFormFields> = {}): TemplateFormFields {
  return {
    templateId: 'booking.confirmed',
    title: 'Booking Confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: '',
    description: '',
    category: '',
    tagsInput: '',
    ...over,
  };
}

describe('templateRowTitle', () => {
  it('uses the title when present', () => {
    expect(templateRowTitle(tpl({ title: 'Booking Confirmed' }))).toBe('Booking Confirmed');
  });

  it('falls back to templateId when title is blank', () => {
    expect(templateRowTitle(tpl({ title: '  ', templateId: 'booking.confirmed' }))).toBe(
      'booking.confirmed',
    );
  });
});

describe('templateSubjectPreview', () => {
  it('returns the subject when present', () => {
    expect(templateSubjectPreview(tpl({ subject: 'Hello' }))).toBe('Hello');
  });

  it('falls back to "No subject set" when blank', () => {
    expect(templateSubjectPreview(tpl({ subject: '   ' }))).toBe('No subject set');
  });
});

describe('previewTags', () => {
  it('returns all tags when at or under the max', () => {
    expect(previewTags(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('caps at 4 by default, ported from tpl.tags.take(4)', () => {
    expect(previewTags(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('honors a custom max', () => {
    expect(previewTags(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('isUntagged', () => {
  it('is true for an empty tags array', () => {
    expect(isUntagged(tpl({ tags: [] }))).toBe(true);
  });

  it('is false once any tag is present', () => {
    expect(isUntagged(tpl({ tags: ['booking'] }))).toBe(false);
  });
});

describe('filterTemplates (pure)', () => {
  const rows = [
    tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
    tpl({ templateId: 'invoice.reminder', title: 'Invoice Reminder' }),
  ];

  it('is a no-op on a blank query', () => {
    expect(filterTemplates(rows, '   ')).toEqual(rows);
  });

  it('matches by title, case-insensitively', () => {
    expect(filterTemplates(rows, 'invoice')).toEqual([rows[1]]);
  });

  it('matches by templateId, case-insensitively', () => {
    expect(filterTemplates(rows, 'BOOKING.CONFIRMED')).toEqual([rows[0]]);
  });

  it('does not match on subject/body/description (the wasm does not search them either)', () => {
    const withSubjectMatch = [tpl({ templateId: 'x', title: 'X', subject: 'invoice inside subject' })];
    expect(filterTemplates(withSubjectMatch, 'invoice')).toEqual([]);
  });
});

describe('templateCategoryState (positive enumeration, no negation)', () => {
  it('is "categorized" for a non-blank category', () => {
    expect(templateCategoryState('Booking')).toBe('categorized');
  });

  it('is "uncategorized" for null', () => {
    expect(templateCategoryState(null)).toBe('uncategorized');
  });

  it('is "uncategorized" for a blank/whitespace-only category', () => {
    expect(templateCategoryState('   ')).toBe('uncategorized');
  });
});

describe('templateCategoryDisplay', () => {
  it('returns the trimmed category when categorized', () => {
    expect(templateCategoryDisplay('  Booking  ')).toBe('Booking');
  });

  it('returns null when uncategorized, never a fabricated label', () => {
    expect(templateCategoryDisplay(null)).toBeNull();
    expect(templateCategoryDisplay('  ')).toBeNull();
  });
});

describe('categoryMatchesFilter', () => {
  it('matches case-insensitively', () => {
    expect(categoryMatchesFilter('booking', 'Booking')).toBe(true);
    expect(categoryMatchesFilter('BOOKING', 'booking')).toBe(true);
  });

  it('does not match a different category', () => {
    expect(categoryMatchesFilter('Booking', 'Reminder')).toBe(false);
  });

  it('never matches for an uncategorized template, mirroring Kotlin String?.equals null-safety', () => {
    expect(categoryMatchesFilter(null, 'Booking')).toBe(false);
    expect(categoryMatchesFilter('   ', 'Booking')).toBe(false);
  });
});

describe('categoryCount', () => {
  it('counts templates matching the named category, case-insensitively', () => {
    const rows = [
      tpl({ templateId: 'a', category: 'Booking' }),
      tpl({ templateId: 'b', category: 'booking' }),
      tpl({ templateId: 'c', category: 'Reminder' }),
      tpl({ templateId: 'd', category: null }),
    ];
    expect(categoryCount(rows, 'Booking')).toBe(2);
    expect(categoryCount(rows, 'Reminder')).toBe(1);
  });
});

// ── editor form (create/edit) ────────────────────────────────────────────────

describe('templateToFormFields', () => {
  it('carries every field through, substituting "" for null html/description/category', () => {
    const row = tpl({
      html: null,
      description: null,
      category: null,
      tags: ['a', 'b'],
    });
    expect(templateToFormFields(row)).toEqual({
      templateId: 'booking.confirmed',
      title: 'Booking Confirmed',
      subject: 'Your booking is confirmed',
      body: 'Hi {{kinfolk_name}}',
      html: '',
      description: '',
      category: '',
      tagsInput: 'a, b',
    });
  });

  it('preserves non-null html/description/category verbatim', () => {
    const row = tpl({ html: '<p>Hi</p>', description: 'A note', category: 'Booking' });
    const result = templateToFormFields(row);
    expect(result.html).toBe('<p>Hi</p>');
    expect(result.description).toBe('A note');
    expect(result.category).toBe('Booking');
  });
});

describe('blankFormFields', () => {
  it('every field starts empty, nothing pre-filled', () => {
    expect(blankFormFields()).toEqual({
      templateId: '',
      title: '',
      subject: '',
      body: '',
      html: '',
      description: '',
      category: '',
      tagsInput: '',
    });
  });
});

describe('parseTagsInput / formatTagsInput', () => {
  it('splits a comma-separated line into trimmed tags', () => {
    expect(parseTagsInput('booking, confirmation')).toEqual(['booking', 'confirmation']);
  });

  it('drops blank entries from doubled/trailing commas', () => {
    expect(parseTagsInput('a, , b,')).toEqual(['a', 'b']);
  });

  it('returns [] for a blank line', () => {
    expect(parseTagsInput('   ')).toEqual([]);
  });

  it('formatTagsInput is the inverse, joined with ", "', () => {
    expect(formatTagsInput(['a', 'b'])).toBe('a, b');
    expect(formatTagsInput([])).toBe('');
  });
});

describe('templateIdError', () => {
  it('is null for a valid key', () => {
    expect(templateIdError('booking.confirmed-v2')).toBeNull();
  });

  it('requires a non-blank key', () => {
    expect(templateIdError('   ')).toBe('Template key is required.');
  });

  it('rejects characters outside [a-zA-Z0-9_.-], matching the backend regex exactly', () => {
    expect(templateIdError('booking confirmed')).toMatch(/letters, numbers, underscore, period, and hyphen/);
    expect(templateIdError('booking/confirmed')).toMatch(/letters, numbers, underscore, period, and hyphen/);
  });

  it('rejects a key over 120 characters, matching the backend max', () => {
    expect(templateIdError('a'.repeat(121))).toBe('Template key must be 120 characters or fewer.');
    expect(templateIdError('a'.repeat(120))).toBeNull();
  });
});

describe('templateFormError', () => {
  it('is null for a complete create-mode form', () => {
    expect(templateFormError(fields(), { isCreate: true })).toBeNull();
  });

  it('is null for a complete edit-mode form even with a blank templateId (not checked in edit mode)', () => {
    expect(templateFormError(fields({ templateId: '' }), { isCreate: false })).toBeNull();
  });

  it('requires templateId only in create mode', () => {
    expect(templateFormError(fields({ templateId: '' }), { isCreate: true })).toBe(
      'Template key is required.',
    );
  });

  it('requires subject', () => {
    expect(templateFormError(fields({ subject: '  ' }), { isCreate: true })).toBe('Subject is required.');
  });

  it('requires body', () => {
    expect(templateFormError(fields({ body: '  ' }), { isCreate: true })).toBe('Body is required.');
  });

  it('checks templateId before subject/body, so the operator sees the earliest blocking error first', () => {
    expect(templateFormError(fields({ templateId: '', subject: '', body: '' }), { isCreate: true })).toBe(
      'Template key is required.',
    );
  });
});

describe('buildSaveTemplatePayload', () => {
  it('trims templateId/subject/body and always includes tags (possibly empty)', () => {
    const payload = buildSaveTemplatePayload(
      fields({ templateId: '  booking.confirmed  ', subject: '  Hi  ', body: '  Body  ' }),
    );
    expect(payload.templateId).toBe('booking.confirmed');
    expect(payload.subject).toBe('Hi');
    expect(payload.body).toBe('Body');
    expect(payload.tags).toEqual([]);
  });

  it('omits title/description/category when blank, never sending them as null (backend rejects null for these)', () => {
    const payload = buildSaveTemplatePayload(fields({ title: '  ', description: '  ', category: '  ' }));
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('category');
  });

  it('includes trimmed title/description/category when present', () => {
    const payload = buildSaveTemplatePayload(
      fields({ title: '  Booking Confirmed  ', description: '  A note  ', category: '  Booking  ' }),
    );
    expect(payload.title).toBe('Booking Confirmed');
    expect(payload.description).toBe('A note');
    expect(payload.category).toBe('Booking');
  });

  it('sends html as null (not omitted) when blank, so a save can clear existing HTML', () => {
    const payload = buildSaveTemplatePayload(fields({ html: '   ' }));
    expect(payload.html).toBeNull();
    expect(payload).toHaveProperty('html');
  });

  it('sends the trimmed html string when present', () => {
    const payload = buildSaveTemplatePayload(fields({ html: '  <p>Hi</p>  ' }));
    expect(payload.html).toBe('<p>Hi</p>');
  });

  it('parses tagsInput into the tags array', () => {
    const payload = buildSaveTemplatePayload(fields({ tagsInput: 'booking, confirmation' }));
    expect(payload.tags).toEqual(['booking', 'confirmation']);
  });
});
