// Tests for the Auntie copy generator Cloud Function core (web/functions/generate.js).
// Uses Node's built-in test runner (node:test) so the deployed function carries
// ZERO dev-dependency tree — the cloud functions buildpack only installs runtime
// deps. Pure units + runGenerate() with an injected mock Firestore + mock Anthropic;
// no network, no real key, no admin SDK. Covers happy / sad / negative / error.
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const gen = require('../generate.js');

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
        let out = rows;
        for (const f of api._filters) {
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

describe('voice source', () => {
  it('loads the Voice Bible + exemplars, not the v1 rules', () => {
    const src = gen.loadVoiceSource();
    assert.ok(src.includes('NO formula'));
    assert.ok(src.includes('GOLD STANDARD'));
    assert.ok(!src.includes('Extracted from 76 real'));
    assert.ok(!src.includes('Opening energy phrase samples'));
  });
});

describe('system prompt', () => {
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

describe('validateRequest', () => {
  it('accepts a valid request', () => {
    const v = gen.validateRequest(VALID);
    assert.strictEqual(v.communication_type, 'visit_report');
    assert.strictEqual(v.recipient, 'Dana');
  });
  it('rejects a missing recipient', () => {
    assert.throws(() => gen.validateRequest({ ...VALID, recipient: '' }), /recipient/i);
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

describe('runGenerate', () => {
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
