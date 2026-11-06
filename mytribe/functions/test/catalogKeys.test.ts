import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIRECT_SEND_KEYS,
  buildCatalogKeyRows,
  catalogKeyEmailTemplateDrift,
  explainUnbindableKey,
  isLiveCatalogKey,
  liveCatalogKeys,
  missingTemplateEffect,
} from '../src/notifications/catalogKeys';
import {
  NOTIFICATION_CATALOG,
  canonicalNotificationKey,
  isRetiredNotificationKey,
  listNotificationKeys,
} from '../src/notifications/catalog';

/**
 * The key set behind #382/#383. These are the invariants that make "a binding at
 * this key does something" a checkable claim rather than a hope.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('catalog key identity', () => {
  it('every catalog row dispatches under its own key (templates.email === key)', () => {
    // If this ever fails, the doc id dispatch reads stops being the catalog key
    // and every binding on the drifted row goes dead silently. buildCatalogKeyRows
    // and liveCatalogKeys both assume this holds.
    expect(catalogKeyEmailTemplateDrift()).toEqual([]);
  });

  it('DIRECT_SEND_KEYS lists exactly the literals the source hands to sendFromTemplate', () => {
    const found = new Set<string>();
    for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/sendFromTemplate\(\s*'([^']+)'/g)) found.add(m[1]!);
    }
    expect([...found].sort()).toEqual(DIRECT_SEND_KEYS.map((d) => d.key).slice().sort());
  });

  it('the live key set is the catalog plus the direct-send literals, nothing else', () => {
    const live = liveCatalogKeys();
    expect(live.size).toBe(Object.keys(NOTIFICATION_CATALOG).length + DIRECT_SEND_KEYS.length);
    expect(live.has('kincare.booking.confirm')).toBe(true);
    expect(live.has('invite.primary')).toBe(true);
    expect(isLiveCatalogKey('kincare.bookng.confirm')).toBe(false);
  });
});

describe('explainUnbindableKey', () => {
  it('accepts a real catalog key and a real direct-send key', () => {
    expect(explainUnbindableKey('kincare.booking.confirm')).toBeNull();
    expect(explainUnbindableKey('invite.primary')).toBeNull();
  });

  it('names the offending key on a typo', () => {
    const msg = explainUnbindableKey('kincare.bookng.confirm');
    expect(msg).toContain("'kincare.bookng.confirm'");
    expect(msg).toContain('Unknown catalog key');
  });

  it('points a retired alias key at the key that replaced it', () => {
    // A binding stored at the alias doc id would never be read: dispatch resolves
    // the alias to its canonical row and looks up THAT row's template id.
    const msg = explainUnbindableKey('kincare.report.sent');
    expect(msg).toContain('retired');
    expect(msg).toContain("'kintale.published'");
  });

  it('tells a withdrawn key apart from a typo, and offers no replacement to bind', () => {
    // `account.welcome.business` was not merged into anything, it was withdrawn.
    // "Unknown catalog key, pick one from the list" would read as a typo the
    // admin should correct; it is a decision the operator made.
    const msg = explainUnbindableKey('account.welcome.business');
    expect(msg).toContain('retired');
    expect(msg).toContain('2026-08-18');
    expect(msg).toContain('no replacement');
    expect(msg).not.toContain('Unknown catalog key');
  });

  it('a withdrawn key is not live, and is not an alias for anything', () => {
    expect(isLiveCatalogKey('account.welcome.business')).toBe(false);
    expect(liveCatalogKeys().has('account.welcome.business')).toBe(false);
    expect(canonicalNotificationKey('account.welcome.business')).toBe('account.welcome.business');
    expect(listNotificationKeys()).not.toContain('account.welcome.business');
    expect(isRetiredNotificationKey('account.welcome.business')).toBe(true);
  });
});

describe('buildCatalogKeyRows', () => {
  it('returns the whole catalog with no bindings at all', () => {
    const rows = buildCatalogKeyRows(new Set(), new Map(), new Set());
    expect(rows.length).toBe(Object.keys(NOTIFICATION_CATALOG).length + DIRECT_SEND_KEYS.length);
    expect(rows.every((r) => r.bound === false)).toBe(true);
    const confirm = rows.find((r) => r.key === 'kincare.booking.confirm')!;
    expect(confirm.label).toBe('KinCare booking confirmed');
    expect(confirm.category).toBe('visit');
    expect(confirm.source).toBe('catalog');
    expect(confirm.defaultTemplateId).toBe('kincare.booking.confirm');
    expect(confirm.resolvedTemplateId).toBe('kincare.booking.confirm');
  });

  it('flags a default template that does not exist in the bank', () => {
    const rows = buildCatalogKeyRows(new Set(), new Map(), new Set(['kincare.booking.confirm']));
    expect(rows.find((r) => r.key === 'kincare.booking.confirm')!.hasDefaultTemplate).toBe(true);
    expect(rows.find((r) => r.key === 'invoice.new')!.hasDefaultTemplate).toBe(false);
  });

  it('reports the bound template as what a key resolves to today', () => {
    const rows = buildCatalogKeyRows(
      new Set(['invoice.new']),
      new Map([['invoice.new', 'tmpl_custom']]),
      new Set(['tmpl_custom']),
    );
    const row = rows.find((r) => r.key === 'invoice.new')!;
    expect(row.bound).toBe(true);
    expect(row.resolvedTemplateId).toBe('tmpl_custom');
  });

  it('keeps a stray key from the bindings collection, marked legacy', () => {
    const rows = buildCatalogKeyRows(new Set(['booking.confirmed']), new Map(), new Set());
    const stray = rows.find((r) => r.key === 'booking.confirmed')!;
    expect(stray.source).toBe('legacy');
    expect(stray.bound).toBe(true);
    expect(explainUnbindableKey(stray.key)).not.toBeNull();
  });

  it('sorts by key and never repeats one', () => {
    const rows = buildCatalogKeyRows(new Set(['invite.primary', 'zzz.stray']), new Map(), new Set());
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.filter((r) => r.key === 'invite.primary')).toHaveLength(1);
  });
});

/**
 * #1586: Manage assignments said five keys would throw for want of a template.
 * Only invite.verify-email did. These pin what each kind of key really does.
 */
describe('whenTemplateMissing (#1586)', () => {
  const rows = buildCatalogKeyRows(new Set(['old.legacy.key']), new Map(), new Set());
  const row = (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r) throw new Error(`no row ${key}`);
    return r;
  };

  it('a catalog row sent by the email channel falls back to generic wording, never a throw', () => {
    for (const key of ['kin.removal.archived', 'kin.removal.declined', 'kin.removal.requested']) {
      expect(row(key).whenTemplateMissing, key).toBe('generic');
      expect(row(key).inRepoCorpus, key).toBe(true);
    }
  });

  it('broadcast.message composes its own email, so a missing template is unused', () => {
    expect(row('broadcast.message').whenTemplateMissing).toBe('unused');
  });

  it('invite.verify-email now has a repo copy, so it sends that instead of throwing', () => {
    expect(row('invite.verify-email')).toMatchObject({
      source: 'direct-send',
      inRepoCorpus: true,
      whenTemplateMissing: 'repoCopy',
    });
  });

  it('a direct send with no repo copy still fails', () => {
    expect(row('invite.primary')).toMatchObject({ inRepoCorpus: false, whenTemplateMissing: 'fails' });
  });

  it('the external password reset row uses its repo copy', () => {
    expect(row('auth.password.reset').whenTemplateMissing).toBe('repoCopy');
  });

  it('a legacy key nothing sends is unused', () => {
    expect(row('old.legacy.key').whenTemplateMissing).toBe('unused');
  });

  it('table: the pure helper agrees with the rows', () => {
    expect(missingTemplateEffect('x', 'direct-send', false)).toBe('fails');
    expect(missingTemplateEffect('x', 'direct-send', true)).toBe('repoCopy');
    expect(missingTemplateEffect('x', 'legacy', true)).toBe('unused');
    expect(missingTemplateEffect('kincare.requested', 'catalog', false)).toBe('generic');
  });

  it('exactly one key on the walk list still fails: none of the five', () => {
    const walked = [
      'broadcast.message',
      'invite.verify-email',
      'kin.removal.archived',
      'kin.removal.declined',
      'kin.removal.requested',
    ];
    expect(walked.filter((k) => row(k).whenTemplateMissing === 'fails')).toEqual([]);
  });
});
