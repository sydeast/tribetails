import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emailTemplateIssues, unquotedAttributeIssue } from '../src/lib/templateValidation';

/**
 * #892 review: `renderEmailParts` lets a plain https URL through unescaped, which
 * is safe inside a quoted attribute. An UNQUOTED attribute is escape-bypassable
 * either way (Handlebars never escapes spaces), so both template doors refuse it.
 */

const email = (html: string) => ({ subject: 's', body: 'b', html });

describe('unquotedAttributeIssue', () => {
  it('refuses a merge field written straight into href, src or any attribute', () => {
    expect(unquotedAttributeIssue('html', '<a href={{link}}>x</a>')).toMatch(/without quotes/);
    expect(unquotedAttributeIssue('html', '<img src = {{logo}}>')).toMatch(/without quotes/);
    expect(unquotedAttributeIssue('html', '<a class=button href={{portalUrl}}>x</a>')).toMatch(/without quotes/);
  });

  it('allows quoted attributes and merge fields in text', () => {
    expect(unquotedAttributeIssue('html', `<a href='{{link}}'>x</a>`)).toBeNull();
    expect(unquotedAttributeIssue('html', '<a href="{{portalUrl}}">x</a>')).toBeNull();
    expect(unquotedAttributeIssue('html', '<p>Total = {{amount}}</p>')).toBeNull();
    expect(unquotedAttributeIssue('html', null)).toBeNull();
  });

  it('is reported by emailTemplateIssues, which both doors call', () => {
    expect(emailTemplateIssues(email('<a href={{link}}>x</a>'))).toEqual([
      expect.stringMatching(/html puts a merge field straight into an attribute/),
    ]);
    expect(emailTemplateIssues(email(`<a href='{{link}}'>x</a>`))).toEqual([]);
  });

  it('passes every html template in the seed corpus', () => {
    const root = join(__dirname, '..', '..', 'seeds', 'notificationTemplates');
    for (const key of readdirSync(root)) {
      const html = readFileSync(join(root, key, 'content.html'), 'utf8');
      expect(unquotedAttributeIssue('html', html), key).toBeNull();
    }
  });
});
