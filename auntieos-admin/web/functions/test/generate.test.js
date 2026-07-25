// Tests for the Auntie copy generator Cloud Function core (web/functions/generate.js).
// Uses Node's built-in test runner (node:test) so the deployed function carries
// ZERO dev-dependency tree — the cloud functions buildpack only installs runtime
// deps. Pure units + runGenerate() with an injected mock Firestore + mock Anthropic;
// no network, no real key, no admin SDK. Covers happy / sad / negative / error.
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const gen = require('../generate.js');
// The brand-voice corpus (web/functions/voice/) is gitignored on purpose: it
// carries per-client material and must not reach a CI runner. Every test that
// builds a real prompt needs it, so those blocks SKIP when it is absent rather
// than failing and training everyone to ignore a red suite. Locally the corpus
// is present and they all run, which is where they earn their keep.
const VOICE_PRESENT = fs.existsSync(
  path.join(__dirname, '..', 'voice', '01_Voice_Bible.md'),
);
const needsVoice = VOICE_PRESENT
  ? {}
  : { skip: 'brand-voice corpus not present (gitignored; expected on CI)' };

// MyTribe's TITLE_INSTRUCTION is the ORIGINAL; generate.js carries a verbatim
// copy (they deploy in different function bundles, so it cannot be imported).
// Both trees are prefixes in this one monorepo now, so the guard test reads the
// real MyTribe source instead of a hardcoded literal: that way an edit on EITHER
// side is caught, not just an edit to the AuntieOS copy.
const MYTRIBE_BACKFILL_SRC = path.join(
  __dirname, '..', '..', '..', '..',
  'mytribe', 'functions', 'src', 'admin', 'aiBackfillTaleTitles.ts',
);

// Pull the runtime string VALUE of a `const NAME = 'a' + 'b' + ...;` assignment
// out of TS/JS SOURCE TEXT: fold the concatenation, decode the escapes. This
// compares the string the code PRODUCES, not the exact source bytes, so a
// reformat of the MyTribe file does not spuriously fail, but any change to the
// instruction itself does.
function extractStringConst(source, name) {
  const m = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*([\\s\\S]*?);'));
  if (!m) throw new Error(`${name} assignment not found in ${MYTRIBE_BACKFILL_SRC}`);
  const literals = m[1].match(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g);
  if (!literals) throw new Error(`${name} assignment has no string literals`);
  return literals
    .map((lit) => lit.slice(1, -1).replace(/\\(["'\\nrt])/g, (_, c) =>
      (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c)))
    .join('');
}

// ---- tiny in-memory Firestore double -------------------------------------
// Supports: collection(name).get(), .doc(id).get(), .doc().set(),
//           .where(field, op, value).get()  (op 'in' and '==').

function makeDb(data) {
  const drafts = [];
  function coll(name) {
    const rows = (data[name] || []).slice();
    const api = {
      _filters: [],
      where(field, op, value) {
        return { ...api, _filters: [...api._filters, { field, op, value }] };
      },
      async get() {
        // `this`, not `api`: .where() returns a NEW object carrying the filters,
        // so reading api._filters here always saw the empty base array and every
        // .where() in this file silently matched everything. The fixture hid it
        // (all KIN share one kinfolkId); the training-docs test caught it.
        let out = rows;
        for (const f of this._filters) {
          out = out.filter((r) =>
            f.op === 'in' ? f.value.includes(r[f.field]) : r[f.field] === f.value,
          );
        }
        return { docs: out.map((r) => ({ id: r.id, exists: true, data: () => r })) };
      },
      doc(id) {
        if (!id) {
          const newId = `draft_${drafts.length + 1}`;
          return { id: newId, async set(obj) { drafts.push({ id: newId, ...obj }); } };
        }
        const found = rows.find((r) => r.id === id);
        return {
          id,
          async get() { return { id, exists: !!found, data: () => found }; },
          async set(obj) { drafts.push({ id, ...obj }); },
        };
      },
    };
    return api;
  }
  return { collection: coll, _drafts: drafts };
}

const KINFOLK = [
  { id: '9', firstName: 'Dana', lastName: 'Delgado' },
  { id: '3', firstName: 'Nora', lastName: 'Halbrook' },
];
const DOSSIERS = {
  '9': { id: '9', kinfolkId: '9', rawSummary: 'Dana trusts Auntie with Nova and Otis.', communicationStyle: 'wants reassurance', householdNotes: 'Two cats, upstairs litter box.' },
};
const KIN = [
  { id: '22', kinfolkId: '9', name: 'Nova', species: 'cat' },
  { id: '23', kinfolkId: '9', name: 'Otis', species: 'cat' },
];
const FOUR11 = [
  { id: '411_22', kinId: '22', rawSummary: 'Nova hits you with the pretty eyes.' },
  { id: '411_23', kinId: '23', rawSummary: 'Otis wants belly rubs, leaves a third of his food.' },
];
const VISIT_LOGS = [
  { id: '10', kinfolkId: '9', auntieNotes: 'Well!!!! prior visit opener tic, they ate every bit.', submitted: 'April 3, 2026', serviceType: '30 Minute Care - Evening' },
];

function fullDb() {
  return makeDb({ kinfolk: KINFOLK, dossiers: Object.values(DOSSIERS), kin: KIN, the_411: FOUR11, visit_logs: VISIT_LOGS });
}

function fakeAnthropic(text, { fail = false } = {}) {
  return {
    messages: {
      async create() {
        if (fail) throw new Error('overloaded_error');
        return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } };
      },
    },
  };
}

const VALID = { communication_type: 'visit_report', recipient: 'Dana', raw_notes: 'fed Nova and Otis, cleaned boxes' };

describe('voice source', needsVoice, () => {
  it('loads the Voice Bible + exemplars, not the v1 rules', () => {
    const src = gen.loadVoiceSource();
    assert.ok(src.includes('NO formula'));
    assert.ok(src.includes('GOLD STANDARD'));
    assert.ok(!src.includes('Extracted from 76 real'));
    assert.ok(!src.includes('Opening energy phrase samples'));
  });
});

describe('system prompt', needsVoice, () => {
  it('embeds framing + voice and marks the block cacheable', () => {
    const blocks = gen.buildSystemPrompt(gen.loadVoiceSource());
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].cache_control.type, 'ephemeral');
    assert.ok(blocks[0].text.includes('NO formula'));
  });
  it('framing carries the anti-formula opener rule and no arrival-energy directive', () => {
    const low = gen.SYSTEM_FRAMING.toLowerCase();
    assert.ok(low.includes('vary the opening'));
    assert.ok(low.includes('1 in 10') || low.includes('10%'));
    assert.ok(low.includes('well'));
    assert.ok(!low.includes('arrival energy'));
  });
});

describe('sanitizeCopy', () => {
  it('strips em and en dashes deterministically', () => {
    assert.strictEqual(gen.sanitizeCopy('I came in—they were happy'), 'I came in, they were happy');
    assert.strictEqual(gen.sanitizeCopy('the 2024–2025 season'), 'the 2024-2025 season');
    assert.ok(!gen.sanitizeCopy('a — b — c').includes('—'));
  });
});

// ALLOWED_TYPES is hand-copied across four LANGUAGES (this JS Set, the admin's
// TS GENERATE_COMMUNICATION_TYPES, N8nClient's Kotlin CommunicationType enum,
// create_n8n_workflows.py). A true single source is infeasible: the copies live
// in different deploy bundles AND different languages, so none can import
// another (see the AO-8 design doc, Option C). The drift GUARD is the answer.
//
// Until 2026-07-21 the guard bound only this file's two JS copies (the Set and
// the SYSTEM_FRAMING prose). Now that all four trees are one repo, the test READS
// the other-language copies as text and cross-checks their token set against this
// Set, so a rename on any side trips a red test here. This is a test-time
// filesystem read, not a runtime import.
const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// Pull the exact quoted tokens out of a delimited slice of a source file, so an
// unrelated occurrence of "email" elsewhere in the file cannot pollute the set.
function tokensBetween(absPath, startMarker, endMarker) {
  const src = fs.readFileSync(absPath, 'utf8');
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `marker '${startMarker}' not found in ${absPath}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `end marker '${endMarker}' not found in ${absPath}`);
  const slice = src.slice(start, end);
  const KNOWN = ['sms', 'email', 'visit_report', 'social_post', 'blog_post', 'general'];
  return new Set(KNOWN.filter((t) => new RegExp(`["']${t}["']`).test(slice)));
}

describe('ALLOWED_TYPES (the taxonomy every client mirrors)', () => {
  it('is exactly the six documented types', () => {
    assert.deepStrictEqual(
      [...gen.ALLOWED_TYPES].sort(),
      ['blog_post', 'email', 'general', 'sms', 'social_post', 'visit_report'],
    );
  });

  // The cross-language binds. Each reads the real other-tree file; edit any copy
  // and this fails, pointing at the drift. Paths are checked to exist first so a
  // moved file fails loud instead of silently matching nothing.
  const CROSS_LANGUAGE_COPIES = [
    {
      lang: 'TS admin GENERATE_COMMUNICATION_TYPES',
      path: `${REPO}/auntieos-admin/src/api/communicateGenerate.ts`,
      start: 'GENERATE_COMMUNICATION_TYPES',
      end: '] as const',
    },
    {
      lang: 'Kotlin N8nClient CommunicationType enum',
      path: `${REPO}/auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/N8nClient.kt`,
      start: 'enum class CommunicationType',
      end: '}',
    },
  ];
  for (const c of CROSS_LANGUAGE_COPIES) {
    it(`${c.lang} carries exactly the six types (drift guard)`, () => {
      assert.ok(fs.existsSync(c.path), `copy moved or missing: ${c.path}`);
      const found = tokensBetween(c.path, c.start, c.end);
      assert.deepStrictEqual(
        [...found].sort(),
        [...gen.ALLOWED_TYPES].sort(),
        `${c.lang} has drifted from generate.js ALLOWED_TYPES. Reconcile the copy.`,
      );
    });
  }
  // The two guards above bind copies of the ACCEPTED taxonomy: they describe
  // what the server will take, so equality is the right invariant.
  //
  // A composer's OPTION LIST is a different thing, and until 2026-07-24 the
  // Android picker was wrongly held to the equality guard above. It is the
  // subset an operator is OFFERED, and it has always been legitimately smaller:
  // `general` was never offered anywhere, and `social_post` was offered on
  // Android alone with prompt framing no surface had ever exercised. Both
  // composers now offer the archive's four (visit_report / sms / email /
  // blog_post), which is what the archive's own MessageType enum offered.
  //
  // The real invariant for an option list is CONTAINMENT: a composer must never
  // offer a type the server would 400 on. That is what catches the mistake this
  // guard exists to catch, a chip for a `kintale` type the function does not
  // accept, while leaving each surface free to narrow.
  const OPTION_LISTS = [
    {
      lang: 'Kotlin Android commTypeOptions',
      path: `${REPO}/auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/ui/communicate/CommunicateScreen.kt`,
      start: 'private val commTypeOptions',
      end: ')',
    },
    {
      lang: 'TS admin PERSONALIZE_MESSAGE_TYPES',
      path: `${REPO}/auntieos-admin/src/lib/personalizeCompose.ts`,
      start: 'export const PERSONALIZE_MESSAGE_TYPES',
      end: '];',
    },
  ];
  for (const c of OPTION_LISTS) {
    it(`${c.lang} offers only types the function accepts`, () => {
      assert.ok(fs.existsSync(c.path), `option list moved or missing: ${c.path}`);
      const found = tokensBetween(c.path, c.start, c.end);
      assert.ok(found.size > 0, `${c.lang} matched no known type; the markers have drifted`);
      for (const t of found) {
        assert.ok(
          gen.ALLOWED_TYPES.has(t),
          `${c.lang} offers '${t}', which generate.js would reject with a 400.`,
        );
      }
    });
  }
  it('gives every allowed type its own tone line in the system framing', () => {
    for (const t of gen.ALLOWED_TYPES) {
      assert.ok(
        gen.SYSTEM_FRAMING.includes(`  - ${t}:`),
        `${t} is accepted but has no tone guidance in SYSTEM_FRAMING`,
      );
    }
  });
  // visit_report IS the KinTale format. There is deliberately no 'kintale' type.
  it('has no separate kintale type', () => {
    assert.ok(!gen.ALLOWED_TYPES.has('kintale'));
    assert.ok(gen.SYSTEM_FRAMING.includes("(Auntie's KinTale format)"));
  });
});

// A fake that answers each call in turn, so a test can tell the body call and
// the title call apart. `calls` records what was actually sent.
function scriptedAnthropic(texts, { failOn = -1 } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        if (calls.length - 1 === failOn) throw new Error('overloaded_error');
        const text = texts[calls.length - 1] ?? '';
        return { content: [{ type: 'text', text }], usage: {} };
      },
    },
  };
}

describe('KinTale title generation', () => {
  // Pins the AuntieOS copy against the REAL MyTribe source, byte for byte. A
  // title written live must read like one written by the backfill cron; if the
  // backfill's TITLE_INSTRUCTION is edited and this copy is not, the tale list
  // splits into two voices. The old test compared against a hardcoded literal,
  // so it caught an edit to THIS copy but was blind to an edit on the MyTribe
  // side, the exact drift it was meant to guard. Now it reads the actual file.
  it('is byte-identical to the MyTribe backfill TITLE_INSTRUCTION', () => {
    const src = fs.readFileSync(MYTRIBE_BACKFILL_SRC, 'utf8');
    const backfillInstruction = extractStringConst(src, 'TITLE_INSTRUCTION');
    assert.strictEqual(gen.TITLE_INSTRUCTION, backfillInstruction);
  });

  describe('normalizeTitle', () => {
    it('strips wrapping quotes the prompt already forbade', () => {
      assert.strictEqual(gen.normalizeTitle('"Nova Meets the Door"'), 'Nova Meets the Door');
      assert.strictEqual(gen.normalizeTitle('“Two Cats, One Nap”'), 'Two Cats, One Nap');
    });
    it('strips trailing sentence punctuation', () => {
      assert.strictEqual(gen.normalizeTitle('A Slow Warm Morning.'), 'A Slow Warm Morning');
      assert.strictEqual(gen.normalizeTitle('Otis Claims the Sunbeam!'), 'Otis Claims the Sunbeam');
    });
    it('strips dashes, same as the body sanitizer', () => {
      assert.ok(!gen.normalizeTitle('Nova — and Otis').includes('—'));
    });
    it('returns empty for empty input rather than throwing', () => {
      assert.strictEqual(gen.normalizeTitle(''), '');
      assert.strictEqual(gen.normalizeTitle(null), '');
    });
  });

  describe('generateTitle', () => {
    it('sends the instruction and the body, and returns the normalized title', async () => {
      const a = scriptedAnthropic(['"Nova Meets the Door."']);
      const title = await gen.generateTitle(a, 'Nova met me at the door.', 'm');
      assert.strictEqual(title, 'Nova Meets the Door');
      assert.ok(a.calls[0].messages[0].content.startsWith(gen.TITLE_INSTRUCTION));
      assert.ok(a.calls[0].messages[0].content.includes('Nova met me at the door.'));
    });
    // A title is a nicety on a draft the operator is about to edit. Losing the
    // body because the title call failed would be the wrong trade.
    it('returns empty instead of throwing when the model call fails', async () => {
      const a = scriptedAnthropic([''], { failOn: 0 });
      assert.strictEqual(await gen.generateTitle(a, 'a real body', 'm'), '');
    });
    it('does not call the model at all for a blank body', async () => {
      const a = scriptedAnthropic(['unused']);
      assert.strictEqual(await gen.generateTitle(a, '   ', 'm'), '');
      assert.strictEqual(a.calls.length, 0);
    });
  });
});

describe('validateRequest', () => {
  it('accepts a valid request', () => {
    const v = gen.validateRequest(VALID);
    assert.strictEqual(v.communication_type, 'visit_report');
    assert.strictEqual(v.recipient, 'Dana');
  });
  // recipient is OPTIONAL and deliberately NOT gated by communication_type.
  // Broadcast sends as `email` with no single recipient, and blog/social posts
  // have none at all, so requiring it unconditionally 400d every Blog generate.
  it('accepts a missing recipient and normalizes it to empty', () => {
    const v = gen.validateRequest({ ...VALID, communication_type: 'blog_post', recipient: '' });
    assert.strictEqual(v.recipient, '');
  });
  it('accepts an absent recipient key entirely', () => {
    const v = gen.validateRequest({ communication_type: 'blog_post', raw_notes: 'the dog days of August' });
    assert.strictEqual(v.recipient, '');
  });
  it('accepts email with no recipient (broadcast has no single Kinfolk)', () => {
    const v = gen.validateRequest({ ...VALID, communication_type: 'email', recipient: '   ' });
    assert.strictEqual(v.communication_type, 'email');
    assert.strictEqual(v.recipient, '');
  });
  it('rejects missing raw_notes', () => {
    assert.throws(() => gen.validateRequest({ ...VALID, raw_notes: '   ' }), /raw_notes/i);
  });
  it('rejects an unknown communication_type with status 400', () => {
    assert.throws(
      () => gen.validateRequest({ ...VALID, communication_type: 'carrier_pigeon' }),
      (e) => e.status === 400,
    );
  });
});

// kinfolk_id: the client-resolved household id. Optional and additive — every
// caller that sends only a name keeps working exactly as before.
describe('validateRequest with kinfolk_id', () => {
  it('carries a supplied id through, trimmed', () => {
    assert.strictEqual(gen.validateRequest({ ...VALID, kinfolk_id: '  9  ' }).kinfolk_id, '9');
  });
  it('normalizes an absent id to null, not to empty string', () => {
    assert.strictEqual(gen.validateRequest(VALID).kinfolk_id, null);
  });
  it('normalizes a blank id to null so it never becomes a doc path', () => {
    assert.strictEqual(gen.validateRequest({ ...VALID, kinfolk_id: '   ' }).kinfolk_id, null);
  });
  it('ignores a non-string id rather than stringifying an object into a doc path', () => {
    assert.strictEqual(gen.validateRequest({ ...VALID, kinfolk_id: { evil: true } }).kinfolk_id, null);
  });
});

describe('resolveContext with a kinfolk_id', () => {
  // The whole point: no fuzzy scan. A roster read here would mean the id is
  // being ignored and matchKinfolk is still deciding who the copy is about.
  function countingDb(data) {
    const inner = makeDb(data);
    const reads = [];
    return {
      reads,
      collection(name) {
        const c = inner.collection(name);
        return {
          ...c,
          where: c.where.bind(c),
          doc(id) {
            reads.push(`${name}.doc(${id})`);
            return c.doc(id);
          },
          async get() {
            reads.push(`${name}.get()`);
            return c.get.call(this);
          },
        };
      },
    };
  }

  it('reads the household directly and never scans the roster', async () => {
    const db = countingDb({ kinfolk: KINFOLK });
    const ctx = await gen.resolveContext(db, {
      communication_type: 'email',
      recipient: 'Dana',
      kinfolk_id: '9',
      raw_notes: 'x',
    });
    assert.strictEqual(ctx.kinfolkId, '9');
    assert.strictEqual(ctx.kinfolkName, 'Dana Delgado');
    assert.ok(db.reads.includes('kinfolk.doc(9)'), 'expected a direct kinfolk doc read');
    assert.ok(!db.reads.includes('kinfolk.get()'), 'the roster scan must not run when an id is supplied');
  });

  it('trusts the id over a name that would have matched somebody else', async () => {
    const db = fullDb();
    const ctx = await gen.resolveContext(db, {
      communication_type: 'email',
      recipient: 'Dana',
      kinfolk_id: '3',
      raw_notes: 'x',
    });
    assert.strictEqual(ctx.kinfolkId, '3');
    assert.strictEqual(ctx.kinfolkName, 'Nora Halbrook');
  });

  it('404s on an id that does not exist, naming the id', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.resolveContext(db, { communication_type: 'email', recipient: 'Dana', kinfolk_id: 'ghost', raw_notes: 'x' }),
      (e) => e.status === 404 && /ghost/.test(e.message),
    );
  });

  it('still loads the dossier, kin, 411s and prior visit for the id path', async () => {
    const db = fullDb();
    const ctx = await gen.resolveContext(db, {
      communication_type: 'email',
      recipient: '',
      kinfolk_id: '9',
      raw_notes: 'x',
    });
    assert.ok(ctx.dossier, 'dossier should load from the id path');
    assert.ok(ctx.kins.length > 0, 'kin should load from the id path');
  });

  it('resolves by id even when no recipient name was sent at all', async () => {
    const db = fullDb();
    const ctx = await gen.resolveContext(db, { communication_type: 'email', recipient: '', kinfolk_id: '9', raw_notes: 'x' });
    assert.strictEqual(ctx.kinfolkId, '9');
  });

  it('falls back to the name scan when no id is supplied, unchanged', async () => {
    const db = fullDb();
    const ctx = await gen.resolveContext(db, { communication_type: 'email', recipient: 'Dana', raw_notes: 'x' });
    assert.strictEqual(ctx.kinfolkId, '9');
  });
});

describe('matchKinfolk', () => {
  it('matches on first name, case-insensitive', () => {
    assert.strictEqual(gen.matchKinfolk('dana', KINFOLK).id, '9');
  });
  it('matches on "First Last"', () => {
    assert.strictEqual(gen.matchKinfolk('Nora Halbrook', KINFOLK).id, '3');
  });
  it('returns null on no match', () => {
    assert.strictEqual(gen.matchKinfolk('Nobody', KINFOLK), null);
  });
});

describe('resolveContext without a recipient (broadcast / blog / social)', () => {
  it('skips the Kinfolk roster entirely instead of 404ing', async () => {
    const db = fullDb();
    const ctx = await gen.resolveContext(db, { communication_type: 'blog_post', recipient: '', raw_notes: 'x' });
    assert.strictEqual(ctx.kinfolk, null);
    assert.strictEqual(ctx.kinfolkId, null);
    assert.strictEqual(ctx.kinfolkName, '');
    assert.strictEqual(ctx.dossier, null);
    assert.deepStrictEqual(ctx.kins, []);
    assert.deepStrictEqual(ctx.four11ByKinId, {});
    assert.strictEqual(ctx.recentLog, null);
  });
  it('still loads training docs, which key off communication_type, not the recipient', async () => {
    const db = makeDb({
      training_documents: [
        { id: 't1', communicationType: 'blog_post', title: 'Summer', content: 'a long warm story' },
        { id: 't2', communicationType: 'sms', title: 'Nope', content: 'wrong channel' },
      ],
    });
    const ctx = await gen.resolveContext(db, { communication_type: 'blog_post', recipient: '', raw_notes: 'x' });
    assert.strictEqual(ctx.trainingDocs.length, 1);
    assert.strictEqual(ctx.trainingDocs[0].title, 'Summer');
  });
  // A supplied-but-unmatched recipient is still a 404. Optional does not mean ignored.
  it('still 404s when a recipient IS supplied but matches nobody', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.resolveContext(db, { communication_type: 'email', recipient: 'Nobody', raw_notes: 'x' }),
      (e) => e.status === 404,
    );
  });
});

describe('buildUserMessage', () => {
  const base = {
    communicationType: 'visit_report',
    kinfolkName: 'Dana',
    rawNotes: 'fed the cats',
    dossier: DOSSIERS['9'],
    kins: KIN,
    four11ByKinId: { '22': FOUR11[0], '23': FOUR11[1] },
    recentLog: VISIT_LOGS[0],
    trainingDocs: [],
  };
  it('weaves in dossier, kin, and 411 context', () => {
    const msg = gen.buildUserMessage(base);
    assert.ok(msg.includes('Nova (cat)'));
    assert.ok(msg.includes('Otis (cat)'));
    assert.ok(msg.includes('pretty eyes'));
    assert.ok(msg.includes('trusts Auntie'));
  });
  it('de-weights the prior visit: no "tone anchor" label, explicit do-not-imitate', () => {
    const msg = gen.buildUserMessage(base).toLowerCase();
    assert.ok(!msg.includes('tone anchor'));
    assert.ok(msg.includes('do not imitate'));
    assert.ok(msg.includes('prior visit'));
  });
  it('omits the prior-visit block when there is no recent log', () => {
    const msg = gen.buildUserMessage({ ...base, recentLog: null }).toLowerCase();
    assert.ok(!msg.includes('prior visit'));
    assert.ok(!msg.includes('do not imitate'));
  });
  it('injects the avoid_opening hint on regenerate', () => {
    const msg = gen.buildUserMessage({ ...base, avoidOpening: 'Well' }).toLowerCase();
    assert.ok(msg.includes('do not open'));
    assert.ok(msg.includes('well'));
  });

  it('wraps untrusted dossier/kin/411/prior-visit/training content in DATA markers (NOTE-50)', () => {
    const msg = gen.buildUserMessage({
      ...base,
      trainingDocs: [{ title: 'Sample', content: 'reference copy' }],
    });
    // every injected data block is delimited
    assert.ok(msg.includes('<DATA_START>'));
    assert.ok(msg.includes('<DATA_END>'));
    // dossier, kin/411, prior-visit, and training content all land inside markers
    const between = msg.split('<DATA_START>').slice(1).map((s) => s.split('<DATA_END>')[0]).join('\n');
    assert.ok(between.includes('trusts Auntie'));   // dossier
    assert.ok(between.includes('pretty eyes'));     // 411
    assert.ok(between.includes('Well!!!! prior visit') || between.includes('prior visit opener tic')); // prior visit body
    assert.ok(between.includes('reference copy'));  // training doc
  });

  it('keeps trusted operator fields (raw notes, type) OUTSIDE the DATA markers', () => {
    const msg = gen.buildUserMessage(base);
    // raw notes come after the last DATA_END (trusted operator input, not data)
    const tail = msg.split('<DATA_END>').pop();
    assert.ok(tail.includes('RAW NOTES FROM SYD'));
    assert.ok(tail.includes('fed the cats'));
    assert.ok(msg.startsWith('COMMUNICATION TYPE:'));
  });

  it('emits no DATA markers when there is no untrusted context', () => {
    const msg = gen.buildUserMessage({
      communicationType: 'sms',
      kinfolkName: 'Dana',
      rawNotes: 'quick note',
      dossier: null,
      kins: [],
      four11ByKinId: {},
      recentLog: null,
      trainingDocs: [],
    });
    assert.ok(!msg.includes('<DATA_START>'));
    assert.ok(!msg.includes('<DATA_END>'));
  });
});

describe('system prompt data-vs-instructions guard (NOTE-50)', () => {
  it('framing tells the model that DATA-wrapped content is data, not instructions', () => {
    const low = gen.SYSTEM_FRAMING.toLowerCase();
    assert.ok(low.includes('<data_start>'));
    assert.ok(low.includes('<data_end>'));
    assert.ok(low.includes('data, not'));
  });
});

describe('buildUserMessage without a Kinfolk', () => {
  const noRecipient = { communicationType: 'blog_post', kinfolkName: '', rawNotes: 'the dog days of August' };

  it('does not emit an empty RECIPIENT label', () => {
    const msg = gen.buildUserMessage(noRecipient);
    assert.ok(!msg.includes('RECIPIENT (Kinfolk):'));
  });
  // Without an explicit instruction the model invents a Kinfolk name to address.
  it('tells the model there is no single Kinfolk and not to invent one', () => {
    const msg = gen.buildUserMessage(noRecipient).toLowerCase();
    assert.ok(msg.includes('no single kinfolk'));
    assert.ok(msg.includes('do not invent'));
  });
  it('still carries the raw notes', () => {
    assert.ok(gen.buildUserMessage(noRecipient).includes('the dog days of August'));
  });
});

describe('runGenerate', needsVoice, () => {
  it('generates a recipient-less blog post end to end (was a hard 400)', async () => {
    const db = fullDb();
    const out = await gen.runGenerate(
      { db, anthropic: fakeAnthropic('August slowed everybody down.'), model: 'claude-sonnet-4-5' },
      { communication_type: 'blog_post', recipient: '', raw_notes: 'slow hot month, everybody napping' },
    );
    assert.ok(out.generated_copy.includes('August slowed everybody down.'));
    assert.strictEqual(out.communication_type, 'blog_post');
    assert.strictEqual(out.kinfolk_id, null);
    assert.strictEqual(out.kinfolk_name, '');
    assert.strictEqual(out.draftWriteFailed, false);
    assert.strictEqual(db._drafts.length, 1);
    assert.strictEqual(db._drafts[0].kinfolk_id, null);
    assert.strictEqual(db._drafts[0].recipient, '');
  });

  it('returns a title when want_title is set, drawn from the generated body', async () => {
    const db = fullDb();
    const a = scriptedAnthropic(['Nova met me at the door.', 'Nova Meets the Door']);
    const out = await gen.runGenerate({ db, anthropic: a, model: 'm' }, { ...VALID, want_title: true });

    assert.strictEqual(out.generated_title, 'Nova Meets the Door');
    assert.strictEqual(a.calls.length, 2);
    // The title is written FROM the body, not from the raw notes.
    assert.ok(a.calls[1].messages[0].content.includes('Nova met me at the door.'));
    assert.ok(!a.calls[1].messages[0].content.includes('fed Nova and Otis'));
    assert.strictEqual(db._drafts[0].generated_title, 'Nova Meets the Door');
  });

  it('makes no second call and returns a blank title when want_title is absent', async () => {
    const db = fullDb();
    const a = scriptedAnthropic(['Nova met me at the door.']);
    const out = await gen.runGenerate({ db, anthropic: a, model: 'm' }, VALID);

    assert.strictEqual(out.generated_title, '');
    assert.strictEqual(a.calls.length, 1);
  });

  it('still returns the body when the title call fails', async () => {
    const db = fullDb();
    const a = scriptedAnthropic(['Nova met me at the door.'], { failOn: 1 });
    const out = await gen.runGenerate({ db, anthropic: a, model: 'm' }, { ...VALID, want_title: true });

    assert.ok(out.generated_copy.includes('Nova met me at the door.'));
    assert.strictEqual(out.generated_title, '');
  });

  it('happy path returns a byte-compatible GenerateResponse + writes a draft', async () => {
    const db = fullDb();
    const out = await gen.runGenerate(
      { db, anthropic: fakeAnthropic('The cats were already at the door.'), model: 'claude-sonnet-4-5' },
      VALID,
    );
    assert.ok(out.generated_copy.includes('The cats were already'));
    assert.strictEqual(out.communication_type, 'visit_report');
    assert.strictEqual(out.kinfolk_name, 'Dana Delgado');
    assert.strictEqual(out.kinfolk_id, '9');
    assert.strictEqual(out.model, 'claude-sonnet-4-5');
    assert.ok(out.draft_id);
    assert.strictEqual(out.draftWriteFailed, false);
    assert.deepStrictEqual(out.warnings, []);
    assert.strictEqual(db._drafts.length, 1);
    assert.ok(db._drafts[0].generated_copy.includes('The cats were already'));
  });

  it('strips em/en dashes from the model output', async () => {
    const db = fullDb();
    const out = await gen.runGenerate(
      { db, anthropic: fakeAnthropic('Nova met me—then Otis—both happy.'), model: 'm' },
      VALID,
    );
    assert.ok(!out.generated_copy.includes('—'));
    assert.strictEqual(out.generated_copy, 'Nova met me, then Otis, both happy.');
  });

  it('unknown recipient -> 404 GenerateError', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.runGenerate({ db, anthropic: fakeAnthropic('x'), model: 'm' }, { ...VALID, recipient: 'Ghost' }),
      (e) => e.status === 404,
    );
  });

  it('invalid input -> 400 GenerateError (before any Claude call)', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.runGenerate({ db, anthropic: fakeAnthropic('x'), model: 'm' }, { ...VALID, raw_notes: '' }),
      (e) => e.status === 400,
    );
  });

  it('Claude failure -> 502 GenerateError', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.runGenerate({ db, anthropic: fakeAnthropic('x', { fail: true }), model: 'm' }, VALID),
      (e) => e.status === 502,
    );
  });

  it('draft-write failure is non-fatal: still returns the copy with a warning', async () => {
    const db = fullDb();
    db.collection = ((orig) => (name) => {
      if (name === 'generated_drafts') {
        return { doc: () => ({ id: 'x', set: async () => { throw new Error('write denied'); } }) };
      }
      return orig(name);
    })(db.collection);
    const out = await gen.runGenerate(
      { db, anthropic: fakeAnthropic('Nova greeted me with the pretty eyes.'), model: 'm' },
      VALID,
    );
    assert.ok(out.generated_copy.includes('Nova greeted me'));
    assert.strictEqual(out.draft_id, null);
    // WARNING-13: failure must be unambiguous so the client can fail loud.
    assert.strictEqual(out.draftWriteFailed, true);
    assert.match(out.warnings.join(' '), /draft/i);
  });
});
