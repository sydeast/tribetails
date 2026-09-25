// @vitest-environment jsdom
// #953: visualFormError -> hasTextBlock parses the content fragment with
// DOMParser, so this file needs jsdom, unlike the rest of its plain-logic
// tests (which run fine under either environment).
import { describe, it, expect } from 'vitest';
import type { TemplateSummary } from '../api/templates';
import {
  templateRowTitle,
  templateSubjectPreview,
  previewTags,
  isUntagged,
  filterTemplates,
  templateEmptyMessage,
  TEMPLATE_BANK_EMPTY_COPY,
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
  isOldFormat,
  visualFormError,
  buildVisualSavePayload,
  fieldsForTemplate,
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
    usageInstructions: '',
    sectionDefinitions: [],
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
    usageInstructions: '',
    sections: [],
    headline: '',
    content: '',
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
      usageInstructions: '',
      sections: [],
      headline: '',
      content: '',
    });
  });

  it('preserves non-null html/description/category verbatim', () => {
    const row = tpl({ html: '<p>Hi</p>', description: 'A note', category: 'Booking' });
    const result = templateToFormFields(row);
    expect(result.html).toBe('<p>Hi</p>');
    expect(result.description).toBe('A note');
    expect(result.category).toBe('Booking');
  });

  it('carries usageInstructions + sectionDefinitions through, copying section rows (no shared reference)', () => {
    const sections = [{ title: 'Greeting', description: 'Hello' }];
    const row = tpl({ usageInstructions: 'Send after first visit.', sectionDefinitions: sections });
    const result = templateToFormFields(row);
    expect(result.usageInstructions).toBe('Send after first visit.');
    expect(result.sections).toEqual(sections);
    expect(result.sections[0]).not.toBe(sections[0]); // copied, not the same object
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
      usageInstructions: '',
      sections: [],
      headline: '',
      content: '',
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

  // ── I9 usageInstructions + sectionDefinitions ──────────────────────────────

  it('always sends usageInstructions (trimmed, possibly empty) so a save can clear it', () => {
    expect(buildSaveTemplatePayload(fields({ usageInstructions: '  Send after visit.  ' })).usageInstructions).toBe(
      'Send after visit.',
    );
    const blank = buildSaveTemplatePayload(fields({ usageInstructions: '   ' }));
    expect(blank).toHaveProperty('usageInstructions');
    expect(blank.usageInstructions).toBe('');
  });

  it('trims sections and drops any row whose title is blank (mirrors parseTagsInput)', () => {
    const payload = buildSaveTemplatePayload(
      fields({
        sections: [
          { title: '  Greeting  ', description: '  Hello  ' },
          { title: '   ', description: 'orphan description with no title' },
          { title: 'Body', description: '' },
        ],
      }),
    );
    expect(payload.sectionDefinitions).toEqual([
      { title: 'Greeting', description: 'Hello' },
      { title: 'Body', description: '' },
    ]);
  });

  it('always sends sectionDefinitions (possibly empty) so a save can clear them', () => {
    const payload = buildSaveTemplatePayload(fields({ sections: [] }));
    expect(payload).toHaveProperty('sectionDefinitions');
    expect(payload.sectionDefinitions).toEqual([]);
  });
});
describe('templateEmptyMessage: what the bank searched over', () => {
  // #716: the two settled no-search cases speak the mock's own line. The mock
  // counts "All" among its category chips, so an empty bank and an empty
  // category read the same sentence there.
  it('says the bank is empty when nothing has loaded at all', () => {
    expect(templateEmptyMessage({ loaded: 0, category: null, query: '', hasMore: false })).toBe(
      TEMPLATE_BANK_EMPTY_COPY,
    );
  });
  it('a category with no templates is not a failed search', () => {
    expect(
      templateEmptyMessage({ loaded: 12, category: 'Bookings', query: '', hasMore: false }),
    ).toBe(TEMPLATE_BANK_EMPTY_COPY);
  });
  it('the mock copy is the mock copy, verbatim', () => {
    expect(TEMPLATE_BANK_EMPTY_COPY).toBe('No templates in this category yet. Click New to create one.');
  });
  it('names the loaded page when a category looks empty but the cursor is still open', () => {
    expect(templateEmptyMessage({ loaded: 50, category: 'Bookings', query: '', hasMore: true })).toBe(
      'No templates in Bookings among the 50 loaded so far. Load more to check the rest.',
    );
  });
  it('a search that matched nothing says so, and says what it searched', () => {
    expect(templateEmptyMessage({ loaded: 12, category: null, query: 'refund', hasMore: false })).toBe(
      'Nothing matches "refund". Searched all 12 templates, by title and key.',
    );
  });
  it('a search over a page that has more behind it says the search is bounded', () => {
    expect(templateEmptyMessage({ loaded: 50, category: null, query: 'refund', hasMore: true })).toBe(
      'Nothing matches "refund". Searched the 50 templates loaded so far, by title and key. Load more to search further.',
    );
  });
  it('carries the active category into the search message', () => {
    expect(
      templateEmptyMessage({ loaded: 12, category: 'Bookings', query: 'refund', hasMore: false }),
    ).toBe('Nothing in Bookings matches "refund". Searched all 12 templates, by title and key.');
  });
  it('reports the typed query trimmed, never the raw padding', () => {
    expect(
      templateEmptyMessage({ loaded: 12, category: null, query: '  refund  ', hasMore: false }),
    ).toBe('Nothing matches "refund". Searched all 12 templates, by title and key.');
  });
  it('counts one template in the singular', () => {
    expect(templateEmptyMessage({ loaded: 1, category: null, query: 'refund', hasMore: false })).toBe(
      'Nothing matches "refund". Searched all 1 template, by title and key.',
    );
    expect(templateEmptyMessage({ loaded: 1, category: null, query: 'refund', hasMore: true })).toBe(
      'Nothing matches "refund". Searched the 1 template loaded so far, by title and key. Load more to search further.',
    );
  });
});

describe('#953 visual templates', () => {
  const visualFields = (over: Partial<TemplateFormFields> = {}): TemplateFormFields => ({
    ...blankFormFields(),
    templateId: 'auth.password.reset',
    subject: 'Reset your password',
    headline: 'Reset your password',
    content: '<p>Hi {{displayName}}</p>',
    ...over,
  });

  it('isOldFormat is true unless the template says visual', () => {
    expect(isOldFormat({})).toBe(true);
    expect(isOldFormat({ format: 'visual' })).toBe(false);
  });

  it('templateToFormFields carries headline and content, defaulting to empty', () => {
    const base = { templateId: 't', subject: 's', body: '', html: null, title: 't', description: null, tags: [], category: null, usageInstructions: '', sectionDefinitions: [] };
    expect(templateToFormFields({ ...base, format: 'visual', headline: 'H', content: '<p>x</p>' })).toMatchObject({ headline: 'H', content: '<p>x</p>' });
    expect(templateToFormFields(base)).toMatchObject({ headline: '', content: '' });
  });

  it('visualFormError checks key (create only), subject, headline, then content', () => {
    expect(visualFormError(visualFields({ templateId: '' }), { isCreate: true })).toBe('Template key is required.');
    expect(visualFormError(visualFields({ templateId: '' }), { isCreate: false })).toBeNull();
    expect(visualFormError(visualFields({ subject: ' ' }), { isCreate: false })).toBe('Subject is required.');
    expect(visualFormError(visualFields({ headline: ' ' }), { isCreate: false })).toBe('Headline is required.');
    expect(visualFormError(visualFields({ content: '<p> </p>' }), { isCreate: false })).toBe('The email needs some content.');
    expect(visualFormError(visualFields(), { isCreate: true })).toBeNull();
  });

  it('buildVisualSavePayload is the PR 2 shape exactly: format visual, no body or html keys', () => {
    const p = buildVisualSavePayload(visualFields({ title: ' Reset ', tagsInput: 'auth, reset', category: '' }), { isCreate: true });
    expect(p).toEqual({
      templateId: 'auth.password.reset',
      subject: 'Reset your password',
      format: 'visual',
      headline: 'Reset your password',
      content: '<p>Hi {{displayName}}</p>',
      title: 'Reset',
      tags: ['auth', 'reset'],
      usageInstructions: '',
      sectionDefinitions: [],
      expectNew: true,
    });
    expect('body' in p).toBe(false);
    expect('html' in p).toBe(false);
  });

  it('fieldsForTemplate unions the fields of every notification that sends this template', () => {
    const catalog = [
      { key: 'auth.password.reset', templates: { email: 'auth.password.reset' }, mergeFields: ['link', 'displayName'] },
      { key: 'other', templates: { email: 'auth.password.reset' }, mergeFields: ['email'] },
      { key: 'unrelated', templates: { email: 'x' }, mergeFields: ['nope'] },
    ];
    expect(fieldsForTemplate(catalog, 'auth.password.reset', [])).toEqual({
      catalogKey: 'auth.password.reset',
      fields: ['displayName', 'email', 'link'],
      source: 'catalog',
    });
  });

  it('fieldsForTemplate falls back to the fields the template already uses when no notification sends it', () => {
    expect(fieldsForTemplate([], 'invite.kinfolk', ['inviteLink', 'businessName'])).toEqual({
      catalogKey: null,
      fields: ['businessName', 'inviteLink'],
      source: 'template',
    });
  });
});
