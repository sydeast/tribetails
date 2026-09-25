// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LOOP_CHANGED_ERROR, canonicalContent, editorCanRoundTrip, loopGuardError } from './emailRoundTrip';

const seedsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../mytribe/seeds/notificationTemplates');
const seedKeys = readdirSync(seedsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const seed = (key: string) => readFileSync(join(seedsDir, key, 'content.html'), 'utf8').trimEnd();

describe('editorCanRoundTrip (#953 C5a), through a real headless editor', () => {
  it('finds all 52 seeds', () => {
    expect(seedKeys).toHaveLength(52);
  });

  it.each(seedKeys)('%s opens editable (not locked)', (key) => {
    expect(editorCanRoundTrip(seed(key))).toBe(true);
  });

  it('an empty template (create mode) is editable', () => {
    expect(editorCanRoundTrip('')).toBe(true);
  });

  it('locks a list carrying an {{#if}} block the editor would split into items', () => {
    expect(editorCanRoundTrip('<ul><li>a</li>{{#if x}}<li>b</li>{{/if}}</ul>')).toBe(false);
  });

  it('locks a loop whose tags are not the first and last thing in the list', () => {
    expect(editorCanRoundTrip('<ul><li>Intro</li>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>')).toBe(false);
  });

  it('locks content with an element the editor drops', () => {
    expect(editorCanRoundTrip('<p>Hi</p><table><tr><td>cell</td></tr></table>')).toBe(false);
  });
});

describe('canonicalContent', () => {
  it('ignores attribute order and whitespace between tags', () => {
    expect(canonicalContent('<p><a class="button" href="{{x}}">Go</a></p>\n  <ul>\n <li>a</li>\n</ul>')).toBe(
      canonicalContent('<p><a href="{{x}}" class="button">Go</a></p><ul><li>a</li></ul>'),
    );
  });

  it('keeps the words: a changed letter or a lost space between words differs', () => {
    expect(canonicalContent('<p>Hi there</p>')).not.toBe(canonicalContent('<p>Hi thera</p>'));
    expect(canonicalContent('<p><strong>a</strong> <em>b</em></p>')).not.toBe(
      canonicalContent('<p><strong>a</strong><em>b</em></p>'),
    );
  });

  it('keeps attribute values: a changed href differs', () => {
    expect(canonicalContent('<p><a href="https://a.com">x</a></p>')).not.toBe(
      canonicalContent('<p><a href="https://b.com">x</a></p>'),
    );
  });
});

describe('loopGuardError', () => {
  const LOOP = '<ul>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>';

  it('passes when the loop count is unchanged', () => {
    expect(loopGuardError(LOOP, LOOP.replace('{{this.date}}', '{{this.date}}!'))).toBeNull();
    expect(loopGuardError('<p>a</p>', '<p>b</p>')).toBeNull();
  });

  it('refuses a lost loop', () => {
    expect(loopGuardError(LOOP, '<ul><li>{{this.date}}</li></ul>')).toBe(LOOP_CHANGED_ERROR);
  });

  it('refuses a split loop (an extra opener and closer)', () => {
    expect(loopGuardError(LOOP, LOOP + LOOP)).toBe(LOOP_CHANGED_ERROR);
  });

  it('refuses a lone extra closer that would end the loop early', () => {
    expect(loopGuardError(LOOP, LOOP.replace('</li>', '</li><li>{{/each}}</li>'))).toBe(LOOP_CHANGED_ERROR);
  });

  it('names the change in the operator words the ruling set', () => {
    expect(LOOP_CHANGED_ERROR).toBe(
      'This change would remove or split a repeating list ({{#each}}). Undo it, or edit the list items only.',
    );
  });
});
