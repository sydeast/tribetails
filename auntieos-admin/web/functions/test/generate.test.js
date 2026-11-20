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
  const KNOWN = ['sms', 'email', 'push', 'visit_report', 'social_post', 'blog_post', 'general'];
  return new Set(KNOWN.filter((t) => new RegExp(`["']${t}["']`).test(slice)));
}

describe('ALLOWED_TYPES (the taxonomy every client mirrors)', () => {
  it('is exactly the seven documented types', () => {
    assert.deepStrictEqual(
      [...gen.ALLOWED_TYPES].sort(),
      ['blog_post', 'email', 'general', 'push', 'sms', 'social_post', 'visit_report'],
    );
  });
  // push is a COPY FORMAT here, a notification-shelf line, and is unrelated to
  // the broadcast push channel that delivers one. It is the one type the server
  // did not previously accept, so an un-deployed function 400s on it while the
  // other six keep working.
  it('accepts push', () => {
    assert.ok(gen.ALLOWED_TYPES.has('push'));
    assert.strictEqual(gen.validateRequest({ ...VALID, communication_type: 'push' }).communication_type, 'push');
  });
  it('gives push real guidance and not a copy of the sms line', () => {
    const line = gen.SYSTEM_FRAMING.split('\n').find((l) => l.trim().startsWith('- push:'));
    assert.ok(line, 'no push tone line in SYSTEM_FRAMING');
    // The four properties that make a notification different from a short text.
    assert.match(line, /one sentence/i);
    assert.match(line, /10 to 18 words/i);
    assert.match(line, /no greeting/i);
    assert.match(line, /clip/i);
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
    it(`${c.lang} carries exactly the seven types (drift guard)`, () => {
      assert.ok(fs.existsSync(c.path), `copy moved or missing: ${c.path}`);
      const found = tokensBetween(c.path, c.start, c.end);
      assert.deepStrictEqual(
        [...found].sort(),
        [...gen.ALLOWED_TYPES].sort(),
        `${c.lang} has drifted from generate.js ALLOWED_TYPES. Reconcile the copy.`,
      );
    });
  }
  // The composers' OPTION LISTS, held to full BIDIRECTIONAL agreement with
  // ALLOWED_TYPES. Both directions have now actually gone wrong, which is why
  // both are asserted separately with their own message:
  //
  //   1. A chip the server would 400 on. The obvious candidate is a `kintale`
  //      wire value, since the UI calls that format KinTale while the server
  //      calls it visit_report.
  //   2. A server type no composer offers. This is the one that bit: for the
  //      whole life of the archive, `social_post` and `general` were accepted by
  //      the function and reachable from no UI, and the React port shipped
  //      offering four of six. Nothing failed, nothing warned, the formats were
  //      simply invisible. A containment-only guard is blind to exactly this,
  //      so it is not enough.
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
      const rejected = [...found].filter((t) => !gen.ALLOWED_TYPES.has(t));
      assert.deepStrictEqual(
        rejected,
        [],
        `${c.lang} offers ${JSON.stringify(rejected)}, which generate.js would reject with a 400.`,
      );
    });
    it(`${c.lang} offers EVERY type the function accepts`, () => {
      const found = tokensBetween(c.path, c.start, c.end);
      const missing = [...gen.ALLOWED_TYPES].filter((t) => !found.has(t));
      assert.deepStrictEqual(
        missing,
        [],
        `${c.lang} does not offer ${JSON.stringify(missing)}, so the operator cannot reach ` +
          'a format the function supports. This is the direction that let social_post and ' +
          'general stay invisible for the life of the archive.',
      );
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

  describe('splitSubjectLine (#1610)', () => {
    it('cuts a leading Subject line and the blank lines after it', () => {
      assert.deepStrictEqual(gen.splitSubjectLine('Subject: Big day\n\nHi Dana'), { subject: 'Big day', body: 'Hi Dana' });
    });
    it('handles a bold markdown subject', () => {
      assert.deepStrictEqual(gen.splitSubjectLine('**Subject:** Big day\nHi'), { subject: 'Big day', body: 'Hi' });
    });
    it('leaves copy with no leading subject line alone', () => {
      assert.deepStrictEqual(gen.splitSubjectLine('Hi Dana, the subject: today'), { subject: '', body: 'Hi Dana, the subject: today' });
    });
  });
  it('#1610: the system prompt forbids a subject line in the body', () => {
    assert.ok(/Never write a subject line/.test(String(gen.SYSTEM_FRAMING)));
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
    assert.throws(
      () => gen.validateRequest({ ...VALID, raw_notes: '   ' }),
      (e) => e.status === 400 && e.extra.code === 'raw_notes_required' && /notes/i.test(e.message),
    );
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

  it('404s on an id that does not exist, in plain words that never show the id (#2052)', async () => {
    const db = fullDb();
    await assert.rejects(
      () => gen.resolveContext(db, { communication_type: 'email', recipient: 'Dana', kinfolk_id: 'ghost', raw_notes: 'x' }),
      (e) => e.status === 404 && e.extra.code === 'kinfolk_not_found' && !/ghost/.test(e.message),
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

// #829 review item 9: an Emergency Contact is never messaged and never written
// about, so the household doc loses every contact key the moment it is read.
describe('Emergency Contacts never reach the prompt context', () => {
  const { withoutEmergencyContacts, EMERGENCY_CONTACT_KEYS } = require('../stripEmergencyContacts.js');
  const WITH_EC = {
    id: '9',
    firstName: 'Dana',
    lastName: 'Delgado',
    emergencyContacts: [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' }],
    emergencyContactName: 'Rae Mercer',
    emergencyContactPhone: '805-555-0198',
    emergencyContactRelation: 'Sister',
  };
  const noContactKey = (doc) => EMERGENCY_CONTACT_KEYS.every((k) => !(k in doc));

  it('the helper drops all four keys, keeps everything else, and leaves the input alone', () => {
    const out = withoutEmergencyContacts(WITH_EC);
    assert.deepStrictEqual(out, { id: '9', firstName: 'Dana', lastName: 'Delgado' });
    assert.ok('emergencyContacts' in WITH_EC, 'the caller\'s object is not mutated');
    assert.strictEqual(withoutEmergencyContacts(null), null);
  });

  it('the id path hands back a household with no contact key', async () => {
    const db = makeDb({ kinfolk: [WITH_EC] });
    const ctx = await gen.resolveContext(db, { communication_type: 'email', recipient: '', kinfolk_id: '9', raw_notes: 'x' });
    assert.strictEqual(ctx.kinfolkName, 'Dana Delgado');
    assert.ok(noContactKey(ctx.kinfolk), `unexpected keys: ${Object.keys(ctx.kinfolk)}`);
    assert.ok(!JSON.stringify(ctx).includes('Rae Mercer'));
  });

  it('the name path hands back a household with no contact key', async () => {
    const db = makeDb({ kinfolk: [WITH_EC] });
    const ctx = await gen.resolveContext(db, { communication_type: 'email', recipient: 'Dana', raw_notes: 'x' });
    assert.strictEqual(ctx.kinfolkId, '9');
    assert.ok(noContactKey(ctx.kinfolk));
    assert.ok(!JSON.stringify(ctx).includes('0199'));
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
  it('still loads voice examples, which key off communication_type, not the recipient', async () => {
    const db = makeDb({
      training_documents: [
        { id: 't1', documentKind: 'voice_example', communicationType: 'blog_post', title: 'Summer', content: 'a long warm story' },
        { id: 't2', documentKind: 'voice_example', communicationType: 'sms', title: 'Nope', content: 'wrong channel' },
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
      { db, anthropic: fakeAnthropic('August slowed everybody down.'), model: 'claude-sonnet-5-5' },
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

  it('#1610: lifts a "Subject:" line out of an email body into the title, one subject only', async () => {
    const db = fullDb();
    const a = scriptedAnthropic(['Subject: Nova had a big day\n\nHi Dana, Nova met me at the door.']);
    const out = await gen.runGenerate(
      { db, anthropic: a, model: 'm' },
      { ...VALID, communication_type: 'email', want_title: true },
    );
    assert.strictEqual(out.generated_title, 'Nova had a big day');
    assert.ok(!/subject:/i.test(out.generated_copy));
    assert.ok(out.generated_copy.startsWith('Hi Dana'));
    // No second call: the model already named the subject.
    assert.strictEqual(a.calls.length, 1);
    assert.ok(!/subject:/i.test(db._drafts[0].generated_copy));
  });
  it('#1610: drops the subject line from the body even when no title was asked for', async () => {
    const db = fullDb();
    const a = scriptedAnthropic(['Subject: Hello\nNova met me at the door.']);
    const out = await gen.runGenerate({ db, anthropic: a, model: 'm' }, VALID);
    assert.strictEqual(out.generated_copy, 'Nova met me at the door.');
    assert.strictEqual(out.generated_title, '');
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
      { db, anthropic: fakeAnthropic('The cats were already at the door.'), model: 'claude-sonnet-5-5' },
      VALID,
    );
    assert.ok(out.generated_copy.includes('The cats were already'));
    assert.strictEqual(out.communication_type, 'visit_report');
    assert.strictEqual(out.kinfolk_name, 'Dana Delgado');
    assert.strictEqual(out.kinfolk_id, '9');
    assert.strictEqual(out.model, 'claude-sonnet-5-5');
    assert.ok(out.draft_id);
    assert.strictEqual(out.draftWriteFailed, false);
    assert.deepStrictEqual(out.warnings, []);
    assert.strictEqual(db._drafts.length, 1);
    assert.ok(db._drafts[0].generated_copy.includes('The cats were already'));
  });

  it('#1629: the draft carries createdOn, the field every admin list orders by', async () => {
    const db = fullDb();
    await gen.runGenerate({ db, anthropic: fakeAnthropic('The cats were already at the door.'), model: 'm' }, VALID);
    const d = db._drafts[0];
    assert.ok(typeof d.createdOn === 'string' && d.createdOn !== '', 'createdOn missing: Firestore drops it from orderBy(createdOn)');
    assert.ok(!Number.isNaN(Date.parse(d.createdOn)));
    // One instant, two spellings.
    assert.strictEqual(d.createdOn, d.generated_at);
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
// ── #2052 / #2079: a KinTale is written from its own visit and nothing else ──
// The household the walk used: two dogs, two cats, and a bird that carries the
// INACTIVE chip and is not on the visit. Pepper is listed by the id of her
// household copy, the others by the office's flat id, because a visit can hold
// either. Ziggy is active but was left off this visit on purpose.
const T1_KINFOLK = [{ id: 't1', firstName: 'Tess', lastName: 'Tester' }];
const T1_KIN = [
  { id: 'k-biscuit', kinfolkId: 't1', name: 'Biscuit', species: 'dog' },
  { id: 'k-waffle', kinfolkId: 't1', name: 'Waffle', species: 'dog', status: 'active' },
  { id: 'k-mochi', kinfolkId: 't1', name: 'Mochi', species: 'cat' },
  { id: 'k-pepper', kinfolkId: 't1', name: 'Pepper', species: 'cat', familyKinPath: 'families/t1/kin/fam-pepper' },
  { id: 'k-kiwi', kinfolkId: 't1', name: 'Kiwi', species: 'bird', status: 'inactive' },
  { id: 'k-ziggy', kinfolkId: 't1', name: 'Ziggy', species: 'rabbit' },
  { id: 'k-other', kinfolkId: 'someone-else', name: 'Rogue', species: 'dog' },
];
const T1_FAMILY_KIN = [
  { id: 'fam-pepper', name: 'Pepper', legacyKinId: 'k-pepper' },
];
const T1_SESSION = {
  id: 's1',
  kinfolkId: 't1',
  kinIds: ['k-biscuit', 'k-waffle', 'k-mochi', 'fam-pepper', 'k-kiwi'],
  serviceType: '30 Minute Quick Check',
  startTime: '2026-11-10T20:00:00.000Z',
  arrivedAt: '2026-11-10T20:05:00.000Z',
  departedAt: '2026-11-10T20:38:00.000Z',
};
const T1_DOSSIER = { id: 't1', kinfolkId: 't1', rawSummary: 'Tess likes a note about breakfast.', householdNotes: 'Lock the side gate on the way out.' };
const T1_411 = [{ id: '411_k-kiwi', kinId: 'k-kiwi', rawSummary: 'Kiwi chirps from the perch by the couch.' }];
const T1_LOGS = [{ id: 'l1', kinfolkId: 't1', auntieNotes: 'Running late today, Kiwi sang the whole time.', submitted: 'November 3, 2026' }];
// A real voice example, of the kind a KinTale asks for, so "no training
// example" below is about the KinTale rule and not about an unmarked row.
const T1_TRAINING = [
  { id: 'tr1', documentKind: 'voice_example', communicationType: 'visit_report', title: 'Gold', content: 'Duke met me at the door.' },
];
function t1Db(extra = {}) {
  return makeDb({
    kinfolk: T1_KINFOLK,
    kin: T1_KIN,
    'families/t1/kin': T1_FAMILY_KIN,
    kin_care_sessions: [T1_SESSION],
    dossiers: [T1_DOSSIER],
    the_411: T1_411,
    visit_logs: T1_LOGS,
    training_documents: T1_TRAINING,
    business_settings: [{ id: 'business_settings', timeZone: 'America/Chicago' }],
    ...extra,
  });
}
/** A model double that answers each call in turn and keeps what it was sent. */
function visitModel(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return typeof reply === 'string'
          ? { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} }
          : reply;
      },
    },
  };
}
const T1_REQUEST = {
  communication_type: 'visit_report',
  recipient: 'Tess Tester',
  session_id: 's1',
  raw_notes: 'all ate, water topped up, quick play',
  care_tasks: [{ text: 'Fresh water', kin_name: '' }, { text: 'Fed breakfast', kin_name: 'Mochi' }],
};
const GOOD_DRAFT = 'Biscuit, Waffle, Mochi and Pepper all ate, the water is topped up, and we had a quick play.';
const run = (db, anthropic, body = T1_REQUEST) =>
  gen.runGenerate({ db, anthropic, model: 'm', voiceSource: 'VOICE' }, body);
const promptOf = (anthropic, n = 0) => anthropic.calls[n].messages[0].content;
describe('isInactiveKinStatus', () => {
  it('counts the memorial state and both office spellings, whatever the case', () => {
    for (const s of ['inactive', 'INACTIVE', 'archived', 'noLongerWithUs', ' Inactive ']) {
      assert.strictEqual(gen.isInactiveKinStatus(s), true, s);
    }
  });
  it('a missing, blank or active status is in care', () => {
    for (const s of [undefined, null, '', 'active', 'prospect', 7]) {
      assert.strictEqual(gen.isInactiveKinStatus(s), false, String(s));
    }
  });
});
describe('normalizeCareTasks', () => {
  it('keeps the label and the Kin it was for, trimmed', () => {
    assert.deepStrictEqual(
      gen.normalizeCareTasks([{ text: '  Fed\n breakfast ', kin_name: ' Mochi ' }, { text: 'Fresh water' }]),
      [{ text: 'Fed breakfast', kin_name: 'Mochi' }, { text: 'Fresh water', kin_name: '' }],
    );
  });
  it('drops anything that is not a labelled task', () => {
    assert.deepStrictEqual(gen.normalizeCareTasks([null, 'Fed', { text: '   ' }, { kin_name: 'Mochi' }, 4]), []);
    assert.deepStrictEqual(gen.normalizeCareTasks('Fed'), []);
    assert.deepStrictEqual(gen.normalizeCareTasks(undefined), []);
  });
  it('is bounded in count and in length', () => {
    const many = Array.from({ length: 500 }, () => ({ text: 'x'.repeat(5000) }));
    const out = gen.normalizeCareTasks(many);
    assert.strictEqual(out.length, 80);
    assert.strictEqual(out[0].text.length, 200);
  });
});
describe('validateRequest with a visit', () => {
  it('carries the visit id on a KinTale', () => {
    assert.strictEqual(gen.validateRequest(T1_REQUEST).session_id, 's1');
  });
  it('ignores a visit id on any other kind of message', () => {
    assert.strictEqual(gen.validateRequest({ ...T1_REQUEST, communication_type: 'email' }).session_id, null);
  });
  it('never reads a visit id as a path', () => {
    for (const bad of ['a/b', '', '   ', 7, null, { id: 's1' }]) {
      assert.strictEqual(gen.validateRequest({ ...T1_REQUEST, session_id: bad }).session_id, null);
    }
  });
});
describe('the Kin a KinTale may speak about (#2079)', () => {
  it('is the visit\'s own list, minus any Kin not in active care', async () => {
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest(T1_REQUEST));
    assert.deepStrictEqual(ctx.visitKin.map((k) => k.name), ['Biscuit', 'Waffle', 'Mochi', 'Pepper']);
  });
  it('holds back the inactive Kin even though the visit names it, and the Kin left off the visit', async () => {
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest(T1_REQUEST));
    assert.deepStrictEqual(ctx.offVisitKin.map((k) => k.name).sort(), ['Kiwi', 'Ziggy']);
  });
  it('finds a Kin the visit lists by the id of its household copy', async () => {
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest(T1_REQUEST));
    assert.ok(ctx.visitKin.some((k) => k.name === 'Pepper'));
  });
  it('a Kin marked inactive on the household copy alone is still held back', async () => {
    const db = t1Db({ 'families/t1/kin': [{ id: 'fam-pepper', name: 'Pepper', legacyKinId: 'k-pepper', status: 'noLongerWithUs' }] });
    const ctx = await gen.resolveContext(db, gen.validateRequest(T1_REQUEST));
    assert.ok(!ctx.visitKin.some((k) => k.name === 'Pepper'));
    assert.ok(ctx.offVisitKin.some((k) => k.name === 'Pepper'));
  });
  it('a Kin that lives only in the household copy is found', async () => {
    const db = t1Db({
      'families/t1/kin': [...T1_FAMILY_KIN, { id: 'fam-new', name: 'Noodle', species: 'ferret' }],
      kin_care_sessions: [{ ...T1_SESSION, kinIds: ['fam-new'] }],
    });
    const ctx = await gen.resolveContext(db, gen.validateRequest(T1_REQUEST));
    assert.deepStrictEqual(ctx.visitKin.map((k) => k.name), ['Noodle']);
  });
  it('two Kin claiming one office record stay two Kin', () => {
    const { onVisit, offVisit } = gen.splitVisitKin(
      [
        { ids: new Set(['flat1', 'famA']), name: 'Rex', inactive: true },
        { ids: new Set(['famB']), name: 'Rex', inactive: false },
      ],
      { kinIds: ['famB'] },
    );
    assert.strictEqual(onVisit.length, 1);
    assert.strictEqual(offVisit.length, 1);
  });
  it('a visit that names no Kin covers the active household, never the inactive one', async () => {
    const db = t1Db({ kin_care_sessions: [{ ...T1_SESSION, kinIds: [] }] });
    const ctx = await gen.resolveContext(db, gen.validateRequest(T1_REQUEST));
    assert.deepStrictEqual(ctx.visitKin.map((k) => k.name).sort(), ['Biscuit', 'Mochi', 'Pepper', 'Waffle', 'Ziggy']);
  });
  it('a build that sends no visit still gets active Kin only', async () => {
    const { session_id: _s, ...old } = T1_REQUEST;
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest(old));
    assert.ok(!ctx.visitKin.some((k) => k.name === 'Kiwi'));
    assert.strictEqual(ctx.visit, null);
  });
  it('never takes a Kin from another household', async () => {
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest(T1_REQUEST));
    assert.ok(![...ctx.visitKin, ...ctx.offVisitKin].some((k) => k.name === 'Rogue'));
  });
  it('the household is the visit\'s, not whichever name was typed', async () => {
    const db = t1Db({ kinfolk: [...T1_KINFOLK, { id: 'x9', firstName: 'Tess', lastName: 'Twin' }] });
    const ctx = await gen.resolveContext(db, gen.validateRequest({ ...T1_REQUEST, recipient: 'Tess Twin' }));
    assert.strictEqual(ctx.kinfolkId, 't1');
  });
  it('refuses a visit that belongs to a different household than the one named', async () => {
    await assert.rejects(
      () => gen.resolveContext(t1Db(), gen.validateRequest({ ...T1_REQUEST, kinfolk_id: 'x9' })),
      (e) => e.status === 400 && e.extra.code === 'visit_household_mismatch',
    );
  });
  it('a visit that does not exist is a plain 404 that never shows the id', async () => {
    await assert.rejects(
      () => gen.resolveContext(t1Db(), gen.validateRequest({ ...T1_REQUEST, session_id: 'ghost-visit' })),
      (e) => e.status === 404 && e.extra.code === 'visit_not_found' && !/ghost-visit/.test(e.message),
    );
  });
  it('an inactive Kin is left out of every other kind of message too', async () => {
    const ctx = await gen.resolveContext(t1Db(), gen.validateRequest({ ...T1_REQUEST, communication_type: 'email' }));
    assert.ok(!ctx.kins.some((k) => k.name === 'Kiwi'));
    assert.ok(ctx.kins.some((k) => k.name === 'Biscuit'));
  });
});
describe('what the model is given for a KinTale (#2052)', () => {
  it('gets the Kin on the visit, the KinCare, the times, the ticked tasks and the notes', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await run(t1Db(), a);
    const prompt = promptOf(a);
    assert.match(prompt, /Kin on this visit \(4\): Biscuit \(dog\), Waffle \(dog\), Mochi \(cat\), Pepper \(cat\)/);
    assert.match(prompt, /KinCare: 30 Minute Quick Check/);
    assert.match(prompt, /Day: Tuesday, November 10, 2026/);
    assert.match(prompt, /Auntie arrived: 2:05\sPM/);
    assert.match(prompt, /Auntie left: 2:38\sPM/);
    assert.match(prompt, /- Fresh water\n- Fed breakfast \(for Mochi\)/);
    assert.match(prompt, /all ate, water topped up, quick play$/);
  });
  it('is never told about the inactive Kin or the Kin left off the visit', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await run(t1Db(), a);
    assert.doesNotMatch(promptOf(a), /Kiwi|Ziggy/);
  });
  it('gets no dossier, no 411, no earlier visit and no training example', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await run(t1Db(), a);
    const prompt = promptOf(a);
    assert.doesNotMatch(prompt, /breakfast\.|side gate|perch|couch|Running late|Duke|DOSSIER|411|PRIOR VISIT/);
  });
  it('is told to state nothing beyond them, in the last word before the notes', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await run(t1Db(), a);
    const prompt = promptOf(a);
    assert.ok(prompt.includes(gen.GROUNDING_RULES));
    assert.match(gen.GROUNDING_RULES, /State nothing those three do not say/);
    assert.match(gen.GROUNDING_RULES, /Speak only about the Kin listed as on this visit/);
    assert.ok(prompt.indexOf(gen.GROUNDING_RULES) < prompt.indexOf("THE AUNTIE'S NOTES"));
    assert.ok(prompt.indexOf(gen.GROUNDING_RULES) > prompt.indexOf('CARE TASKS TICKED'));
  });
  it('says so when nothing was ticked, rather than leaving a gap to fill', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await run(t1Db(), a, { ...T1_REQUEST, care_tasks: [] });
    assert.match(promptOf(a), /CARE TASKS TICKED THIS VISIT[^\n]*\n<DATA_START>\nNone ticked\.\n<DATA_END>/);
  });
  it('the booked start is a day, never a clock time', async () => {
    const db = t1Db({ kin_care_sessions: [{ ...T1_SESSION, arrivedAt: '', departedAt: '' }] });
    const a = visitModel([GOOD_DRAFT]);
    await run(db, a);
    assert.match(promptOf(a), /Day: Tuesday, November 10, 2026/);
    assert.doesNotMatch(promptOf(a), /2:00\sPM|arrived|Auntie left/);
  });
  it('keeps the model and the thinking setting it had', async () => {
    const a = visitModel([GOOD_DRAFT]);
    await gen.runGenerate({ db: t1Db(), anthropic: a, model: 'claude-sonnet-5-5', voiceSource: 'VOICE' }, T1_REQUEST);
    assert.strictEqual(a.calls[0].model, 'claude-sonnet-5-5');
    assert.deepStrictEqual(a.calls[0].thinking, { type: 'between_tools' });
  });
  it('the other kinds of message keep their household context', async () => {
    const a = visitModel(['Hello Tess.']);
    await run(t1Db(), a, { communication_type: 'email', recipient: 'Tess', raw_notes: 'say hi' });
    assert.match(promptOf(a), /KINFOLK DOSSIER/);
    assert.doesNotMatch(promptOf(a), /GROUNDING/);
  });
});
describe('a draft that names a Kin who is not on the visit (#2079)', () => {
  const BIRD = 'Biscuit and Waffle ate. Kiwi chirped along from the sidelines like a very small announcer.';
  it('offVisitKinNamed finds the name as a word, possessive included, and not inside another word', () => {
    const ctx = { visitKin: [{ name: 'Biscuit' }], offVisitKin: [{ name: 'Kiwi' }, { name: 'Al' }] };
    assert.deepStrictEqual(gen.offVisitKinNamed("Kiwi's cage was quiet.", ctx, ''), ['Kiwi']);
    assert.deepStrictEqual(gen.offVisitKinNamed('Biscuit ate it all. Also a walk.', ctx, ''), []);
    assert.deepStrictEqual(gen.offVisitKinNamed('A kiwi-green toy.', ctx, ''), []);
  });
  it('lets a name through when an on-visit Kin carries it too', () => {
    const ctx = { visitKin: [{ name: 'Rex' }], offVisitKin: [{ name: 'Rex' }] };
    assert.deepStrictEqual(gen.offVisitKinNamed('Rex ate.', ctx, ''), []);
  });
  it('lets a name through when the Auntie typed it herself', () => {
    const ctx = { visitKin: [{ name: 'Biscuit' }], offVisitKin: [{ name: 'Kiwi' }] };
    assert.deepStrictEqual(gen.offVisitKinNamed('Kiwi watched.', ctx, 'Kiwi watched from the cage'), []);
  });
  it('is written again once with the name called out, and the clean draft is what comes back', async () => {
    const a = visitModel([BIRD, GOOD_DRAFT]);
    const db = t1Db();
    const out = await run(db, a);
    assert.strictEqual(a.calls.length, 2);
    assert.match(promptOf(a, 1), /CORRECTION: your last draft named Kiwi, who is not on this visit/);
    assert.strictEqual(out.generated_copy, GOOD_DRAFT);
    assert.doesNotMatch(JSON.stringify(db._drafts), /chirped/);
  });
  it('is rejected when the second draft does it too: no copy, and nothing in the drafts list', async () => {
    const a = visitModel([BIRD, BIRD]);
    const db = t1Db();
    await assert.rejects(
      () => run(db, a),
      (e) => e.status === 422 && e.extra.code === 'draft_names_kin_not_on_visit',
    );
    assert.strictEqual(a.calls.length, 2);
    assert.strictEqual(db._drafts.length, 0);
  });
  it('the rejection names the Kin and never quotes the draft', async () => {
    const a = visitModel([BIRD, BIRD]);
    await assert.rejects(
      () => run(t1Db(), a),
      (e) => /Kiwi/.test(e.message) && /notes are untouched/.test(e.message) && !/chirped|announcer|k-kiwi/.test(e.message),
    );
  });
  it('an active Kin left off the visit is rejected the same way', async () => {
    const a = visitModel(['Ziggy hopped over to say hello.']);
    await assert.rejects(() => run(t1Db(), a), (e) => e.extra.code === 'draft_names_kin_not_on_visit');
  });
  it('a clean draft is one call and is saved as before', async () => {
    const a = visitModel([GOOD_DRAFT]);
    const db = t1Db();
    const out = await run(db, a);
    assert.strictEqual(a.calls.length, 1);
    assert.strictEqual(out.kinfolk_id, 't1');
    assert.strictEqual(db._drafts.length, 1);
    assert.strictEqual(db._drafts[0].raw_notes, T1_REQUEST.raw_notes);
  });
});
describe('a generate that fails says so plainly (#2052)', () => {
  const noLeak = (e) => !/overloaded|sk-ant|k-kiwi|\bt1\b|\bs1\b|Error:|undefined/.test(e.message);
  it('a provider failure is a plain sentence, with the provider\'s words kept out', async () => {
    const a = { messages: { async create() { throw new Error('overloaded_error: sk-ant-secret request_id=abc'); } } };
    await assert.rejects(
      () => run(t1Db(), a),
      (e) => e.status === 502 && e.extra.code === 'ai_unavailable' && e.message === gen.ERROR_COPY.ai_unavailable && noLeak(e),
    );
  });
  it('a refusal is not handed over as a draft', async () => {
    const a = visitModel([{ content: [{ type: 'text', text: 'I cannot write that because...' }], stop_reason: 'refusal' }]);
    const db = t1Db();
    await assert.rejects(() => run(db, a), (e) => e.extra.code === 'ai_refused' && !/cannot write that/.test(e.message));
    assert.strictEqual(db._drafts.length, 0);
  });
  it('a reply cut off at the length limit is not handed over as a draft', async () => {
    const a = visitModel([{ content: [{ type: 'text', text: 'Biscuit and Waf' }], stop_reason: 'max_tokens' }]);
    await assert.rejects(() => run(t1Db(), a), (e) => e.extra.code === 'ai_cut_short' && !/Waf/.test(e.message));
  });
  it('an empty reply is a plain failure', async () => {
    const a = visitModel([{ content: [], stop_reason: 'end_turn' }]);
    await assert.rejects(() => run(t1Db(), a), (e) => e.extra.code === 'ai_empty_result');
  });
  it('a draft row that fails to save warns in plain words, without the store\'s own error', async () => {
    const db = t1Db();
    db.collection = ((orig) => (name) => {
      if (name === 'generated_drafts') {
        return { doc: () => ({ id: 'x', set: async () => { throw new Error('PERMISSION_DENIED: generated_drafts/abc123'); } }) };
      }
      return orig(name);
    })(db.collection);
    const out = await run(db, visitModel([GOOD_DRAFT]));
    assert.strictEqual(out.draftWriteFailed, true);
    assert.doesNotMatch(out.warnings.join(' '), /PERMISSION_DENIED|abc123/);
  });
  it('every piece of error copy is a sentence, with no code, dash or id in it', () => {
    for (const [code, copy] of Object.entries(gen.ERROR_COPY)) {
      assert.match(copy, /^[A-Z].*\.$/, code);
      assert.doesNotMatch(copy, /_|—|–|\bid\b|Claude|model/i, code);
    }
  });
});
describe('generateErrorResponse: what the screen is sent when a generate fails (#2052)', () => {
  it('a known failure sends its own plain sentence, its code and its status', () => {
    const out = gen.generateErrorResponse(new gen.GenerateError(gen.ERROR_COPY.visit_not_found, 404, { code: 'visit_not_found' }), 'visit_report');
    assert.deepStrictEqual(out, {
      status: 404,
      body: { generated_copy: '', communication_type: 'visit_report', error: gen.ERROR_COPY.visit_not_found, error_code: 'visit_not_found' },
    });
  });
  it('a fault nobody planned for never sends its own message', () => {
    const out = gen.generateErrorResponse(new Error('5 NOT_FOUND: no document kinfolk/kf_8f2a91 (firestore.googleapis.com)'), 'email');
    assert.strictEqual(out.status, 500);
    assert.strictEqual(out.body.error, gen.ERROR_COPY.ai_unavailable);
    assert.strictEqual(out.body.error_code, 'generate_failed');
    assert.doesNotMatch(JSON.stringify(out), /kf_8f2a91|NOT_FOUND|firestore/);
  });
  it('a thrown non-error still answers with the full shape', () => {
    const out = gen.generateErrorResponse(undefined, undefined);
    assert.deepStrictEqual(Object.keys(out.body).sort(), ['communication_type', 'error', 'error_code', 'generated_copy']);
    assert.strictEqual(out.body.communication_type, '');
  });
});
describe('review of #2052 / #2079: the paths a KinTale could still slip through', () => {
  it('a KinTale with no household, name or visit is still grounded, with no training example', async () => {
    const a = visitModel(['All ate and the water is topped up.']);
    const out = await run(t1Db(), a, { communication_type: 'visit_report', raw_notes: 'all ate, water topped up' });
    const prompt = promptOf(a);
    assert.match(prompt, /GROUNDING\./);
    assert.match(prompt, /Kin on this visit: none on file/);
    assert.doesNotMatch(prompt, /Duke|VOICE TRAINING EXAMPLES|DOSSIER|411/);
    assert.strictEqual(out.kinfolk_id, null);
  });
  it('a visit that names no household, sent with no name, is grounded rather than a failed name match', async () => {
    const a = visitModel(['All ate.']);
    const db = t1Db({ kin_care_sessions: [{ ...T1_SESSION, kinfolkId: '' }] });
    await run(db, a, { communication_type: 'visit_report', session_id: 's1', raw_notes: 'all ate' });
    assert.match(promptOf(a), /GROUNDING\./);
    assert.match(promptOf(a), /KinCare: 30 Minute Quick Check/);
  });
  it('a name that matches no Kinfolk is a plain 404 that never repeats the name or the roster', async () => {
    await assert.rejects(
      () => run(t1Db(), visitModel(['x']), { communication_type: 'visit_report', recipient: 'Ghost Writer', raw_notes: 'n' }),
      (e) => e.status === 404 && e.message === gen.ERROR_COPY.kinfolk_not_found && !/Ghost|Tess/.test(JSON.stringify([e.message, e.extra])),
    );
    await assert.rejects(
      () => run(t1Db(), visitModel(['x']), { communication_type: 'email', recipient: 'Ghost Writer', raw_notes: 'n' }),
      (e) => e.status === 404 && e.message === gen.ERROR_COPY.kinfolk_not_found,
    );
  });
  it('a visit whose Kin ids match nobody in the household names no Kin, and a household name is still caught', async () => {
    const db = t1Db({ kin_care_sessions: [{ ...T1_SESSION, kinIds: ['id-of-another-kind'] }] });
    const a = visitModel(['Everyone ate.']);
    await run(db, a);
    assert.match(promptOf(a), /Kin on this visit: none on file/);
    assert.doesNotMatch(promptOf(a), /Biscuit|Kiwi/);
    await assert.rejects(
      () => run(db, visitModel(['Biscuit ate.'])),
      (e) => e.extra.code === 'draft_names_kin_not_on_visit',
    );
  });
  it('the off-visit check and its retry never spend more than two body calls', async () => {
    const a = visitModel(['Kiwi sang.', 'Kiwi sang again.', GOOD_DRAFT]);
    await assert.rejects(() => run(t1Db(), a), (e) => e.status === 422);
    assert.strictEqual(a.calls.length, 2);
  });
});
describe('review: a Kin whose household copy and office record share one id', () => {
  it('is one Kin on the visit, named once', async () => {
    const db = t1Db({ 'families/t1/kin': [...T1_FAMILY_KIN, { id: 'k-biscuit', name: 'Biscuit' }] });
    const a = visitModel([GOOD_DRAFT]);
    await run(db, a);
    assert.match(promptOf(a), /Kin on this visit \(4\): Biscuit \(dog\), Waffle \(dog\), Mochi \(cat\), Pepper \(cat\)/);
  });
  it('and is held back when that copy alone says it is no longer in care', async () => {
    const db = t1Db({ 'families/t1/kin': [...T1_FAMILY_KIN, { id: 'k-biscuit', name: 'Biscuit', status: 'nolongerwithus' }] });
    const a = visitModel(['Waffle, Mochi and Pepper all ate.']);
    await run(db, a);
    assert.doesNotMatch(promptOf(a), /Biscuit/);
  });
});
// ── Which `training_documents` rows are voice examples ──────────────────────
// The collection holds two kinds of row. A voice example is a piece of writing
// kept for its style and belongs to no household. A Tribal Intel note is about
// one household, one Kinfolk or one Kin. Only the first kind is ever sent as a
// "VOICE TRAINING EXAMPLE", and only when the row says so itself.
const AB_KINFOLK = [
  { id: 'hA', firstName: 'Ada', lastName: 'Ames' },
  { id: 'hB', firstName: 'Bea', lastName: 'Boyd' },
];
const AB_KIN = [
  { id: 'kA1', kinfolkId: 'hA', name: 'Pickle', species: 'dog' },
  { id: 'kB1', kinfolkId: 'hB', name: 'Sprout', species: 'cat' },
];
const EXAMPLE = (type) => ({
  id: `v-${type}`, documentKind: 'voice_example', communicationType: type,
  title: 'Porch hello', content: 'Just a quick hello from the porch.',
});
/** Household A's notes as the save writes them, one per target, filed under `type`. */
const NOTES_FOR_A = (type) => [
  {
    id: `nA-house-${type}`, documentKind: 'note', communicationType: type, title: 'Alarm',
    content: 'The alarm panel is behind the coat rack.',
    targetType: 'HOUSEHOLD', targetKinfolkId: 'hA', targetKinId: '', kinfolkRef: 'hA',
  },
  {
    id: `nA-person-${type}`, documentKind: 'note', communicationType: type, title: 'Hours',
    content: 'Ada works nights at the clinic.',
    targetType: 'KINFOLK', targetKinfolkId: 'hA', targetKinId: '', kinfolkRef: 'hA',
  },
  {
    id: `nA-kin-${type}`, documentKind: 'note', communicationType: type, title: 'Pill',
    content: 'Pickle takes a pill at noon.',
    targetType: 'KIN', targetKinfolkId: 'hA', targetKinId: 'kA1', kinfolkRef: 'hA',
  },
];
/** Rows from before the save stamped a kind: one naming a person, one naming nobody. */
const OLD_ROWS = (type) => [
  { id: `old-named-${type}`, communicationType: type, title: 'Later slot', content: 'Ada asked for a later slot.', kinfolkRef: 'Ada Ames' },
  { id: `old-bare-${type}`, communicationType: type, title: 'Back door', content: 'The back door sticks in the cold.', kinfolkRef: '' },
];
const NOTE_TEXT = /alarm panel|coat rack|works nights|pill at noon|later slot|back door|Alarm\]|Hours\]|Pill\]/;
function abDb(type, extra = {}) {
  return makeDb({
    kinfolk: AB_KINFOLK,
    kin: AB_KIN,
    training_documents: [EXAMPLE(type), ...NOTES_FOR_A(type), ...OLD_ROWS(type)],
    ...extra,
  });
}
describe('isVoiceExample: what a training document must say to be sent as one', () => {
  const example = EXAMPLE('email');
  it('a row marked as a voice example and tied to no household is one', () => {
    assert.strictEqual(gen.isVoiceExample(example), true);
    assert.strictEqual(gen.VOICE_EXAMPLE_KIND, 'voice_example');
  });
  it('blank household fields are the same as absent ones', () => {
    assert.strictEqual(
      gen.isVoiceExample({ ...example, targetType: '', targetKinfolkId: '  ', targetKinId: null, kinfolkRef: '' }),
      true,
    );
  });
  it('a note is not one, whatever kind of message it is filed under', () => {
    for (const note of NOTES_FOR_A('email')) assert.strictEqual(gen.isVoiceExample(note), false, note.id);
  });
  it('a row that does not say what it is is not one', () => {
    for (const row of OLD_ROWS('email')) assert.strictEqual(gen.isVoiceExample(row), false, row.id);
    assert.strictEqual(gen.isVoiceExample({ communicationType: 'email', content: 'x' }), false);
  });
  it('the mark is exact: no other spelling or value counts', () => {
    for (const documentKind of ['Voice_Example', 'voice example', 'voice_example ', 'note', '', true, 1, null]) {
      assert.strictEqual(gen.isVoiceExample({ ...example, documentKind }), false, String(documentKind));
    }
  });
  it('a marked row that still names a household, a Kinfolk or a Kin is not one', () => {
    const ties = [
      { targetType: 'HOUSEHOLD' },
      { targetKinfolkId: 'hA' },
      { targetKinId: 'kA1' },
      { kinfolkRef: 'Ada Ames' },
      { kinfolkRef: 'hA' },
      // Anything that is not text is not read as blank.
      { targetKinfolkId: 9 },
      { kinfolkRef: { id: 'hA' } },
    ];
    for (const tie of ties) {
      assert.strictEqual(gen.isVoiceExample({ ...example, ...tie }), false, JSON.stringify(tie));
    }
  });
  it('nothing at all is not one', () => {
    assert.strictEqual(gen.isVoiceExample(null), false);
    assert.strictEqual(gen.isVoiceExample(undefined), false);
  });
  it('what a Tribal Intel save writes is never one (read from the MyTribe source)', () => {
    // The two callables deploy in MyTribe's bundle, so the kind they stamp is
    // read out of their source, the way TITLE_INSTRUCTION is above.
    const dir = path.join(__dirname, '..', '..', '..', '..', 'mytribe', 'functions', 'src', 'admin');
    const create = fs.readFileSync(path.join(dir, 'createTrainingDocument.ts'), 'utf8');
    const update = fs.readFileSync(path.join(dir, 'updateTrainingDocument.ts'), 'utf8');
    const noteKind = extractStringConst(create, 'TRAINING_DOCUMENT_KIND_NOTE');
    assert.notStrictEqual(noteKind, gen.VOICE_EXAMPLE_KIND);
    assert.strictEqual(gen.isVoiceExample({ ...example, documentKind: noteKind }), false);
    for (const src of [create, update]) assert.match(src, /documentKind: TRAINING_DOCUMENT_KIND_NOTE,/);
  });
});
describe('a household note is never sent as a voice example', () => {
  const emailTo = (id, name) => ({ communication_type: 'email', recipient: name, kinfolk_id: id, raw_notes: 'confirming next week' });
  it('a message for another household gets the voice example and none of the notes', async () => {
    const a = visitModel(['Hi Bea, all set for next week.']);
    await run(abDb('email'), a, emailTo('hB', 'Bea'));
    const prompt = promptOf(a);
    assert.match(prompt, /RECIPIENT \(Kinfolk\): Bea Boyd/);
    assert.match(prompt, /VOICE TRAINING EXAMPLES[^\n]*\n<DATA_START>\n\[Porch hello\]\nJust a quick hello from the porch\.\n<DATA_END>/);
    assert.doesNotMatch(prompt, NOTE_TEXT);
    assert.doesNotMatch(prompt, /Ada|Ames|Pickle/);
  });
  it('a message for the household the notes are about does not get them as examples either', async () => {
    const a = visitModel(['Hi Ada, all set for next week.']);
    await run(abDb('email'), a, emailTo('hA', 'Ada'));
    const prompt = promptOf(a);
    assert.match(prompt, /RECIPIENT \(Kinfolk\): Ada Ames/);
    assert.match(prompt, /Just a quick hello from the porch\./);
    assert.doesNotMatch(prompt, NOTE_TEXT);
  });
  it('a message for no household gets the voice example and none of the notes', async () => {
    const a = visitModel(['August was slow for everyone.']);
    await run(abDb('blog_post'), a, { communication_type: 'blog_post', recipient: '', raw_notes: 'slow hot month' });
    const prompt = promptOf(a);
    assert.match(prompt, /Just a quick hello from the porch\./);
    assert.doesNotMatch(prompt, NOTE_TEXT);
    assert.doesNotMatch(prompt, /Ada|Ames|Pickle/);
  });
  it('holds for every kind of message a note could be filed under', async () => {
    for (const type of gen.ALLOWED_TYPES) {
      if (type === 'visit_report') continue; // its own rule, below
      const ctx = await gen.resolveContext(abDb(type), { communication_type: type, recipient: 'Bea', kinfolk_id: 'hB', raw_notes: 'x' });
      assert.deepStrictEqual(ctx.trainingDocs.map((t) => t.id), [`v-${type}`], type);
    }
  });
  it('with no voice example on file the block is left out, never filled from the notes', async () => {
    const db = abDb('email', { training_documents: [...NOTES_FOR_A('email'), ...OLD_ROWS('email')] });
    const a = visitModel(['Hi Bea, all set for next week.']);
    await run(db, a, emailTo('hB', 'Bea'));
    assert.doesNotMatch(promptOf(a), /VOICE TRAINING EXAMPLES/);
    assert.doesNotMatch(promptOf(a), NOTE_TEXT);
  });
  it('a voice example with nothing written in it is left out', async () => {
    const db = abDb('email', { training_documents: [{ ...EXAMPLE('email'), content: '   ' }] });
    const ctx = await gen.resolveContext(db, { communication_type: 'email', recipient: '', raw_notes: 'x' });
    assert.deepStrictEqual(ctx.trainingDocs, []);
  });
  it('a KinTale gets neither: it is written from its own visit', async () => {
    const a = visitModel(['Sprout ate and the water is topped up.']);
    await run(abDb('visit_report'), a, { communication_type: 'visit_report', recipient: 'Bea Boyd', kinfolk_id: 'hB', raw_notes: 'ate, water topped up' });
    const prompt = promptOf(a);
    assert.match(prompt, /GROUNDING\./);
    assert.doesNotMatch(prompt, /VOICE TRAINING EXAMPLES|quick hello from the porch/);
    assert.doesNotMatch(prompt, NOTE_TEXT);
    assert.doesNotMatch(prompt, /Ada|Ames|Pickle/);
  });
  it('a KinTale never opens the collection at all', async () => {
    const db = abDb('visit_report');
    const opened = [];
    const inner = db.collection;
    db.collection = (name) => { opened.push(name); return inner(name); };
    await run(db, visitModel(['Sprout ate.']), { communication_type: 'visit_report', recipient: 'Bea Boyd', kinfolk_id: 'hB', raw_notes: 'ate' });
    assert.ok(!opened.includes('training_documents'));
  });
  it('a failed read sends no example and the draft is still written', async () => {
    const db = abDb('email');
    const inner = db.collection;
    db.collection = (name) => {
      if (name === 'training_documents') throw new Error('unavailable');
      return inner(name);
    };
    const a = visitModel(['Hi Bea, all set for next week.']);
    const out = await run(db, a, emailTo('hB', 'Bea'));
    assert.strictEqual(out.generated_copy, 'Hi Bea, all set for next week.');
    assert.doesNotMatch(promptOf(a), /VOICE TRAINING EXAMPLES/);
  });
});
