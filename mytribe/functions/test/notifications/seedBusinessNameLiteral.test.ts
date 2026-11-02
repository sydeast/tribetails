import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SEED_CORPUS } from '../../src/notifications/seedCorpus.generated';
import { TEMPLATE_FIELDS } from '../../src/notifications/enrichTemplateData';

/**
 * #1451: household text names the business from settings (#1381), so no seed
 * may carry the product name as a literal. The seeds open with `{{Business}}`
 * and the enricher supplies it for every channel.
 */
describe('seed corpus never hard-codes the business name', () => {
  const seedsDir = join(__dirname, '..', '..', '..', 'seeds', 'notificationTemplates');

  it('the generated corpus is non-empty (the checks below are not vacuous)', () => {
    expect(SEED_CORPUS.length).toBeGreaterThan(0);
  });

  it('no generated seed field contains the literal "Tribe Tails"', () => {
    const offenders: string[] = [];
    for (const entry of SEED_CORPUS) {
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === 'string' && value.includes('Tribe Tails')) offenders.push(`${entry.key}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no seed file on disk contains the literal "Tribe Tails"', () => {
    const offenders: string[] = [];
    for (const key of readdirSync(seedsDir)) {
      for (const file of readdirSync(join(seedsDir, key))) {
        if (readFileSync(join(seedsDir, key, file), 'utf8').includes('Tribe Tails')) offenders.push(`${key}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every sms.txt that uses {{Business}} has it listed in TEMPLATE_FIELDS so the enricher supplies it', () => {
    const missing: string[] = [];
    for (const key of readdirSync(seedsDir)) {
      const sms = readFileSync(join(seedsDir, key, 'sms.txt'), 'utf8');
      if (sms.includes('{{Business}}') && !(TEMPLATE_FIELDS[key] ?? []).includes('Business')) missing.push(key);
    }
    expect(missing).toEqual([]);
  });
});
