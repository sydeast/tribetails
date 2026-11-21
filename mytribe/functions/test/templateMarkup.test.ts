import { describe, it, expect } from 'vitest';
import Handlebars from 'handlebars';
import {
  emailMarkupErrors,
  emailTemplateIssues,
  pushTemplateIssues,
  scanTemplate,
  smsTemplateIssues,
  templateMarkupIssue,
  visualEmailTemplateIssues,
} from '../src/lib/templateValidation';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { parsePushTxt } from '../src/notifications/templateParsers';
import { renderEmailParts } from '../src/lib/email';

/**
 * #2251: a template the sender cannot fill in must not save or import. Before
 * this, `{{#if isQuote}}Your quote is ready` with no `{{/if}}` saved, and every
 * send of that notice then threw, so the household heard nothing.
 */
describe('templateMarkupIssue', () => {
  it('HAPPY: plain fields, pairs of block tags and loop fields all send', () => {
    for (const ok of [
      'Hello {{kinfolkName}}',
      '{{#if isQuote}}Your quote{{else}}Your invoice{{/if}} is ready',
      '{{#unless paid}}Due {{dueDate}}{{/unless}}',
      '{{#each visits}}{{this.date}} at {{this.time}}{{/each}}',
      'No fields at all',
      '',
    ]) {
      expect(templateMarkupIssue('The subject', ok)).toBeNull();
    }
  });

  it('SAD: an {{#if}} with no {{/if}} names the field and the missing close', () => {
    expect(templateMarkupIssue('The subject', '{{#if isQuote}}Your quote is ready')).toBe(
      'The subject cannot be sent as written. {{#if}} is never closed. Add {{/if}} where that part ends.',
    );
  });

  it('SAD: a stray {{/if}} says it closes nothing', () => {
    expect(templateMarkupIssue('The body', 'Your invoice is ready{{/if}}')).toBe(
      'The body cannot be sent as written. {{/if}} closes a part that was never opened. Remove it, or add the {{#if}} it belongs to.',
    );
  });

  it('SAD: a block closed with the wrong tag says which close it needs', () => {
    expect(templateMarkupIssue('The body', '{{#if a}}x{{/unless}}')).toMatch(/\{\{#if\}\} is closed with \{\{\/unless\}\}/);
  });

  it('SAD: a lone {{else}} is named', () => {
    expect(templateMarkupIssue('The body', 'a {{else}} b')).toMatch(/\{\{else\}\} sits outside any \{\{#if\}\}/);
  });

  it('NEGATIVE: half a field, a helper call and a partial are each refused', () => {
    expect(templateMarkupIssue('The subject', 'Hi {{kinName')).toMatch(/^The subject cannot be sent as written\. A field is not written correctly/);
    expect(templateMarkupIssue('The subject', '{{upper kinName}}')).toMatch(/A field is not written correctly/);
    expect(templateMarkupIssue('The subject', '{{> footer}}')).toMatch(/A field is not written correctly/);
    expect(templateMarkupIssue('The subject', '{{#shout x}}y{{/shout}}')).toMatch(/is not something a notification can use/);
  });

  // Review of #2251: nothing that renders today is refused.
  it('HAPPY: nested blocks, else-if chains, loop extras and plain sections all send', () => {
    for (const ok of [
      '{{#if a}}x{{else if b}}y{{else}}z{{/if}}',
      '{{#if a}}{{#unless b}}{{#if c}}x{{/if}}{{/unless}}{{/if}}',
      '{{#each items}}{{name}} {{../kinName}} {{@index}}{{else}}none{{/each}}',
      '{{#each items as |item i|}}{{item.name}}{{/each}}',
      '{{#with booking}}{{date}}{{/with}}',
      '{{~#if a~}} x {{~/if~}}',
      '{{!-- a note --}}<a href="{{link}}">Open</a>',
      '{{#kinNames}}{{this}} {{/kinNames}}',
      '{{^note}}No note{{/note}}',
    ]) {
      expect(templateMarkupIssue('The body', ok)).toBeNull();
      expect(() => Handlebars.compile(ok, { noEscape: true })({ items: [{ name: 'x' }], kinNames: ['Rex'] })).not.toThrow();
    }
    expect(scanTemplate('{{#kinNames}}{{name}}{{/kinNames}}').fields).toEqual(['kinNames']);
  });

  it('NEGATIVE: a section with no close, or a helper block that is not one, is still refused', () => {
    expect(templateMarkupIssue('The body', '{{#kinNames}}{{this}}')).toMatch(/\{\{#kinNames\}\} is never closed/);
    expect(templateMarkupIssue('The body', '{{#each}}x{{/each}}')).toMatch(/is not something a notification can use/);
    expect(templateMarkupIssue('The body', '{{#each items}}{{> row}}{{/each}}')).toMatch(/A field is not written correctly/);
    expect(templateMarkupIssue('The body', '{{#if a}}{{upper kinName}}{{/if}}')).toMatch(/A field is not written correctly/);
  });

  it('NEGATIVE: a triple stash is left to its own sentence, never reported twice', () => {
    expect(templateMarkupIssue('The body', '{{{payload}}}')).toBeNull();
  });
});

describe('emailMarkupErrors', () => {
  it('keys each complaint by its field', () => {
    const e = emailMarkupErrors({ subject: '{{#if a}}x', body: 'fine', html: '<p>{{/if}}</p>' });
    expect(Object.keys(e).sort()).toEqual(['html', 'subject']);
    expect(e.subject).toMatch(/^The subject /);
    expect(e.html).toMatch(/^The HTML /);
  });

  it('a visual template is also checked as the sender joins headline and content', () => {
    // Each field parses on its own; the join does not.
    const e = emailMarkupErrors({ headline: 'Hi', content: '<p>{{#if a}}x</p>' });
    expect(e.content).toMatch(/^The email cannot be sent as written\. \{\{#if\}\} is never closed/);
    expect(emailMarkupErrors({ headline: 'Hi {{kinName}}', content: '<p>{{#if a}}x{{/if}}</p>' })).toEqual({});
  });
});

describe('importer doors refuse the same markup (#2251)', () => {
  it('old-format email, visual email, text message and push each report it', () => {
    expect(emailTemplateIssues({ subject: '{{#if a}}x', body: 'b', html: null }).join(' ')).toMatch(/The subject cannot be sent/);
    expect(visualEmailTemplateIssues({ subject: 's', headline: '{{#if a}}x', content: '<p>y</p>' }).join(' ')).toMatch(
      /The headline cannot be sent/,
    );
    expect(smsTemplateIssues('{{#if a}}x').join(' ')).toMatch(/The text message cannot be sent/);
    expect(pushTemplateIssues('t', '{{/if}}').join(' ')).toMatch(/The push message cannot be sent/);
  });

  it('every template in the shipped seed corpus passes, and renders', () => {
    const refused: string[] = [];
    for (const entry of SEED_CORPUS) {
      const email = emailMarkupErrors({
        subject: entry.emailSubject,
        headline: entry.emailHeadline,
        content: entry.emailContent,
      });
      for (const [field, msg] of Object.entries(email)) refused.push(`${entry.key} ${field}: ${msg}`);
      const sms = templateMarkupIssue('The text message', entry.smsTxt.trim());
      if (sms) refused.push(`${entry.key} sms: ${sms}`);
      const push = parsePushTxt(entry.pushTxt);
      for (const [field, value] of [['title', push.title], ['body', push.body]] as const) {
        const issue = templateMarkupIssue(field, value);
        if (issue) refused.push(`${entry.key} push ${field}: ${issue}`);
      }
      // The check and the renderer agree on every corpus template.
      expect(() => renderEmailParts({ subjectTemplate: entry.emailSubject, bodyTemplate: entry.emailContent, data: {} })).not.toThrow();
    }
    expect(SEED_CORPUS.length).toBeGreaterThan(10);
    expect(refused).toEqual([]);
  });
});
