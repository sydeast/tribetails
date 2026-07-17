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
