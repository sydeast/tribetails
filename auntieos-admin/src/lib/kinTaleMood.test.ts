import { describe, it, expect } from 'vitest';
import { decodePetMoodSelections, petMoodRows } from './kinTaleMood';
import { DEFAULT_KINTALE_TEMPLATE, makeMoodOption, type KinTaleTemplate } from './kinTale/model';

function template(over: Partial<KinTaleTemplate> = {}): KinTaleTemplate {
  return {
    ...DEFAULT_KINTALE_TEMPLATE,
    moodOptions: [
      makeMoodOption({ key: 'happy', label: 'Happy', emoji: '😊', order: 0 }),
      makeMoodOption({ key: 'sleepy', label: 'Sleepy', emoji: '😴', order: 7 }),
    ],
    ...over,
  };
}

describe('decodePetMoodSelections', () => {
  it('keeps a well-formed kinId -> moodKey map', () => {
    expect(decodePetMoodSelections({ kin1: 'happy', kin2: 'sleepy' })).toEqual({
      kin1: 'happy',
      kin2: 'sleepy',
    });
  });

  it('returns an empty map for the shapes Firestore can actually hand back instead', () => {
    expect(decodePetMoodSelections(undefined)).toEqual({});
    expect(decodePetMoodSelections(null)).toEqual({});
    expect(decodePetMoodSelections('happy')).toEqual({});
    expect(decodePetMoodSelections(['happy'])).toEqual({});
  });

  it('drops non-string and blank values rather than coercing them', () => {
    expect(
      decodePetMoodSelections({ kin1: 'happy', kin2: 7, kin3: null, kin4: '', kin5: '   ', kin6: { key: 'x' } }),
    ).toEqual({ kin1: 'happy' });
  });
});

describe('petMoodRows', () => {
  it('joins a stored key to its template option, emoji first', () => {
    const rows = petMoodRows({ kin1: 'happy' }, template());
    expect(rows).toEqual([{ kinId: 'kin1', moodKey: 'happy', label: '😊 Happy', resolved: true }]);
  });

  it('renders every recorded kin, in the order the map stored them', () => {
    const rows = petMoodRows({ kin2: 'sleepy', kin1: 'happy' }, template());
    expect(rows.map((r) => r.kinId)).toEqual(['kin2', 'kin1']);
  });

  it('shows the raw key for a mood no template option matches, never dropping it', () => {
    // Not hypothetical: prod's `test-kinfolk-001-report-1` stores `relaxed`,
    // which is not one of the eight options the default template ships.
    const rows = petMoodRows({ kin1: 'relaxed' }, template());
    expect(rows).toEqual([{ kinId: 'kin1', moodKey: 'relaxed', label: 'relaxed', resolved: false }]);
  });

  it('falls back to the key when the matched option has neither emoji nor label', () => {
    const blank = template({ moodOptions: [makeMoodOption({ key: 'happy' })] });
    expect(petMoodRows({ kin1: 'happy' }, blank)).toEqual([
      { kinId: 'kin1', moodKey: 'happy', label: 'happy', resolved: false },
    ]);
  });

  it('uses the label alone when a template author left the emoji blank', () => {
    const noEmoji = template({ moodOptions: [makeMoodOption({ key: 'happy', label: 'Happy' })] });
    expect(petMoodRows({ kin1: 'happy' }, noEmoji)[0]?.label).toBe('Happy');
  });

  it('returns no rows at all when the template has pet mood turned off', () => {
    expect(petMoodRows({ kin1: 'happy' }, template({ petMoodEnabled: false }))).toEqual([]);
  });

  it('returns no rows when nothing was recorded', () => {
    expect(petMoodRows(undefined, template())).toEqual([]);
    expect(petMoodRows({}, template())).toEqual([]);
  });

  it('returns no rows when every recorded entry was malformed', () => {
    expect(petMoodRows({ kin1: 3, kin2: '' }, template())).toEqual([]);
  });
});
