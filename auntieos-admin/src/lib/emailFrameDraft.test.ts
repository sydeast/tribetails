import { describe, it, expect } from 'vitest';
import { draftFrom, draftFrame, draftProblems, fieldProblem, frameChanges } from './emailFrameDraft';
import { EMAIL_FRAME_FIELDS } from '../api/emailFrame';

describe('#957 email frame draft', () => {
  it('seeds every field, blank where nothing is stored (a default is never a draft value)', () => {
    const d = draftFrom({ accentColor: '#123456' });
    expect(Object.keys(d).sort()).toEqual([...EMAIL_FRAME_FIELDS].sort());
    expect(d.accentColor).toBe('#123456');
    expect(d.footerText).toBe('');
  });

  it('an untouched draft has no changes', () => {
    const stored = { accentColor: '#123456', footerText: 'Hi' };
    expect(frameChanges(draftFrom(stored), stored)).toEqual({});
  });

  it('sends only what changed: a new value, or null to go back to the default', () => {
    const stored = { accentColor: '#123456', footerText: 'Hi', headerText: 'Top' };
    const d = { ...draftFrom(stored), accentColor: '#ABCDEF', footerText: '   ', textColor: '#000000' };
    expect(frameChanges(d, stored)).toEqual({ accentColor: '#abcdef', footerText: null, textColor: '#000000' });
  });

  it('does not count case or surrounding spaces as a change', () => {
    const stored = { accentColor: '#abcdef', headerText: 'Top' };
    expect(frameChanges({ ...draftFrom(stored), accentColor: '#ABCDEF', headerText: ' Top ' }, stored)).toEqual({});
  });

  it('the preview frame carries only set fields', () => {
    expect(draftFrame({ ...draftFrom({}), accentColor: '#123456', footerText: ' ' })).toEqual({ accentColor: '#123456' });
  });

  it('flags what the server would refuse', () => {
    expect(fieldProblem('accentColor', 'red')).toMatch(/#df8431/);
    expect(fieldProblem('accentColor', '#12345')).not.toBeNull();
    expect(fieldProblem('accentColor', '#12AB5f')).toBeNull();
    expect(fieldProblem('headerText', 'x'.repeat(81))).toMatch(/80/);
    expect(fieldProblem('footerText', 'Hi {{name}}')).toMatch(/Merge fields/);
    expect(fieldProblem('footerText', '')).toBeNull();
    expect(draftProblems({ ...draftFrom({}), textColor: 'blue' })).toEqual({ textColor: expect.any(String) });
  });
});
