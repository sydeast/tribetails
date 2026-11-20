// #2359: the names in the writing samples never reach the model, and never
// come back in a draft.
//
// Everything here runs with or without the real voice corpus. The corpus is
// gitignored and never reaches CI, so the rules are proven on a fixture whose
// every name is invented (test/fixtures/voice). The one block that reads the
// real corpus skips when it is absent, and reports counts only: a failure
// message must never print a name out of it.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const gen = require('../generate.js');
const names = require('../sampleNames.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'voice');
const FIXTURE_NAMES = ['Juniper', 'Captain Nibbles', 'Cap', 'Nibbles', 'Tofu', 'Marlowe', 'Odette', 'Joss'];
const ENTRIES = [
  { role: 'kin', forms: ['Juniper'] },
  { role: 'kin', forms: ['Captain Nibbles', 'Cap', 'Nibbles'] },
  { role: 'kin', forms: ['Tofu'] },
  { role: 'kinfolk', forms: ['Marlowe'] },
  { role: 'auntie', forms: ['Joss'] },
];

/** A copy of the fixture voice folder with the samples file rewritten. */
function voiceDirWith(rewrite) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  fs.mkdirSync(path.join(dir, 'corpus'));
  for (const f of ['01_Voice_Bible.md', '02_Channel_Playbook.md']) {
    fs.copyFileSync(path.join(FIXTURE_DIR, f), path.join(dir, f));
  }
  const samples = fs.readFileSync(path.join(FIXTURE_DIR, 'corpus', 'exemplars.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'corpus', 'exemplars.md'), rewrite(samples));
  return dir;
}

/** Runs `fn` with console.error captured, and returns what was logged. */
async function logged(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

describe('parseSampleNames: the names a samples file declares', () => {
  it('reads one Kin or person per line, with the other ways the name is written', () => {
    const out = names.parseSampleNames(
      'intro\n<!-- sample-names\n# note\nkin: Juniper\n\nKin: Captain Nibbles | Cap|Nibbles\nkinfolk: Marlowe\nauntie: Joss\n-->\nbody',
    );
    assert.strictEqual(out.declared, true);
    assert.deepStrictEqual(out.entries, [
      { role: 'kin', forms: ['Juniper'] },
      { role: 'kin', forms: ['Captain Nibbles', 'Cap', 'Nibbles'] },
      { role: 'kinfolk', forms: ['Marlowe'] },
      { role: 'auntie', forms: ['Joss'] },
    ]);
  });
  it('cuts the declaration out of the text, so the list itself is never sent', () => {
    const out = names.parseSampleNames('intro\n<!-- sample-names\nkin: Juniper\n-->\nbody');
    assert.strictEqual(out.body, 'intro\nbody');
  });
  it('tells a file with no declaration from one that declares nothing', () => {
    assert.strictEqual(names.parseSampleNames('just samples').declared, false);
    const empty = names.parseSampleNames('<!-- sample-names\n-->\nsamples');
    assert.strictEqual(empty.declared, true);
    assert.deepStrictEqual(empty.entries, []);
  });
  it('refuses a line it cannot read, and never repeats the line in the error', () => {
    for (const bad of ['dog: Juniper', 'Juniper', 'kin:', 'kin: J']) {
      assert.throws(
        () => names.parseSampleNames(`<!-- sample-names\nkin: Tofu\n${bad}\n-->`),
        (e) => e instanceof names.SampleNamesError && /line 2/.test(e.message) && !/Juniper|Tofu/.test(e.message),
        bad,
      );
    }
  });
});

describe('scrubSampleNames: a sample with the names taken out', () => {
  it('numbers the Kin of each sample in the order they appear, starting again at each heading', () => {
    const text = [
      '### One',
      'Tofu ate. Juniper watched Tofu.',
      '### Two',
      'Juniper ate first today.',
    ].join('\n');
    assert.strictEqual(
      names.scrubSampleNames(text, ENTRIES),
      ['### One', '[Kin] ate. [Kin 2] watched [Kin].', '### Two', '[Kin] ate first today.'].join('\n'),
    );
  });
  it('gives every way a name is written the same placeholder, longest match first', () => {
    assert.strictEqual(
      names.scrubSampleNames("Captain Nibbles sat. Cap's bowl. Nibbles = Nosy Boy. Juniper left.", ENTRIES),
      "[Kin] sat. [Kin]'s bowl. [Kin] = Nosy Boy. [Kin 2] left.",
    );
  });
  it('covers headings and labels, and tells Kin from Kinfolk from the Auntie', () => {
    assert.strictEqual(
      names.scrubSampleNames("### Tofu & Juniper (Marlowe)\nIt's Joss here, Marlowe.", ENTRIES),
      "### [Kin] & [Kin 2] ([Kinfolk])\nIt's [Auntie] here, [Kinfolk].",
    );
  });
  it('leaves a word alone that only contains a name', () => {
    assert.strictEqual(
      names.scrubSampleNames('Junipers grow here. A baseball cap. Tofus.', ENTRIES),
      'Junipers grow here. A baseball cap. Tofus.',
    );
  });
  it('with nothing declared, returns the text as it came', () => {
    assert.strictEqual(names.scrubSampleNames('Tofu ate.', []), 'Tofu ate.');
  });
});

describe('sampleNamesIn: a draft that carries a name out of the samples', () => {
  it('finds a Kin or Kinfolk name as a word, possessive included', () => {
    assert.deepStrictEqual(names.sampleNamesIn("Tofu's bowl was empty and Marlowe called.", ENTRIES, ''), ['Tofu', 'Marlowe']);
    assert.deepStrictEqual(names.sampleNamesIn('Nibbles was at the door.', ENTRIES, ''), ['Nibbles']);
  });
  it('does not take the everyday word for the name', () => {
    assert.deepStrictEqual(names.sampleNamesIn('I made tofu and put my cap on. Tofus all round.', ENTRIES, ''), []);
  });
  it('lets a name through when the request itself carries it, however it was typed', () => {
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, 'Kin on this visit: Tofu (cat)'), []);
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, 'notes: tofu ate all of it'), []);
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, 'notes: tofurkey for dinner'), ['Tofu']);
  });
  it("never refuses the Auntie's own name", () => {
    assert.deepStrictEqual(names.sampleNamesIn("It's Joss with the team.", ENTRIES, ''), []);
  });
  it('spots a placeholder carried through as if it were a name', () => {
    assert.strictEqual(names.hasPlaceholder('[Kin] ate every bit.'), true);
    assert.strictEqual(names.hasPlaceholder('Hello [Kinfolk 2], it is [Auntie].'), true);
    assert.strictEqual(names.hasPlaceholder('Biscuit ate [almost] every bit.'), false);
  });
});

describe('readVoice: what the model is given from the voice files (corpus not needed)', () => {
  it('replaces every declared name in all three files and cuts the declaration', () => {
    const voice = gen.readVoice(FIXTURE_DIR);
    for (const name of FIXTURE_NAMES) {
      assert.doesNotMatch(voice.source, new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`), name);
    }
    assert.doesNotMatch(voice.source, /sample-names|kinfolk:|a comment line/);
    // The heading names them first, and the tale under it keeps that numbering.
    assert.match(voice.source, /### Gold 1, \[Kin\] & \[Kin 2\], morning visit/);
    assert.match(voice.source, /"\[Kin 2\] was at the door before I had my key out\. \[Kin\] watched from the stairs\. \[Kin 2\]'s bowl/);
    assert.match(voice.source, /### Gold 2, \[Kin\] \(\[Kinfolk\]\), evening walk/);
    assert.match(voice.source, /It's \[Auntie\] with the team/);
    // The Bible and the Playbook go to the model too.
    assert.match(voice.source, /"Sir \[Kin\] had an agenda\."/);
    assert.match(voice.source, /"\[Kin\] ate every bit\."\n.*"Hi \[Kinfolk\], quick note about \[Kin 2\]\."/);
    // What is not a name is untouched.
    assert.match(voice.source, /NO formula/);
    assert.match(voice.source, /Junipers are also a kind of tree/);
  });
  it('hands back the declared names for the draft check', () => {
    const voice = gen.readVoice(FIXTURE_DIR);
    assert.deepStrictEqual(
      voice.sampleNames.map((e) => `${e.role}:${e.forms.join('|')}`),
      ['kin:Juniper', 'kin:Captain Nibbles|Cap|Nibbles', 'kin:Tofu', 'kinfolk:Marlowe', 'kinfolk:Odette', 'auntie:Joss'],
    );
  });
  it('refuses samples that do not declare their names, and logs no line of them', async () => {
    const dir = voiceDirWith((s) => s.replace(/<!--[\s\S]*?-->\n/, ''));
    const log = await logged(() => {
      assert.throws(
        () => gen.readVoice(dir),
        (e) => e.status === 500 && e.extra.code === 'voice_sample_names_missing' && e.message === gen.ERROR_COPY.ai_unavailable,
      );
    });
    assert.doesNotMatch(log, /Juniper|Tofu|Marlowe/);
  });
  it('refuses a declaration it cannot read, and logs no name from it', async () => {
    const dir = voiceDirWith((s) => s.replace('kin: Tofu', 'cat: Tofu'));
    const log = await logged(() => {
      assert.throws(() => gen.readVoice(dir), (e) => e.status === 500 && e.extra.code === 'voice_sample_names_invalid');
    });
    assert.doesNotMatch(log, /Juniper|Tofu|Marlowe/);
  });
  it('still fails plainly when a voice file is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-empty-'));
    await logged(() => {
      assert.throws(() => gen.readVoice(dir), (e) => e.status === 500 && e.extra.code === 'voice_source_missing');
    });
  });
  it('the system prompt says placeholders are never written', () => {
    assert.match(gen.SYSTEM_FRAMING, /Never write a bracketed placeholder/);
  });
});

const CORPUS_PRESENT = fs.existsSync(path.join(__dirname, '..', 'voice', 'corpus', 'exemplars.md'));
describe(
  'the real voice corpus (present on the operator machine only)',
  CORPUS_PRESENT ? {} : { skip: 'brand-voice corpus not present (gitignored; expected on CI)' },
  () => {
    it('declares its names, and none of them reaches the system prompt', () => {
      const voice = gen.loadVoice();
      const forms = voice.sampleNames.flatMap((e) => e.forms);
      // Counts only. A name from the corpus must never be printed by a test.
      assert.ok(forms.length > 0, 'the corpus declares no names at all');
      const text = gen.buildSystemPrompt(voice.source)[0].text;
      const left = forms.filter((f) => names.sampleNamesIn(text, [{ role: 'kin', forms: [f] }], '').length > 0);
      assert.strictEqual(left.length, 0, `${left.length} declared name(s) are still in the system prompt`);
      assert.ok(!text.includes('sample-names'), 'the declaration itself is in the system prompt');
      // assert.ok, not assert.match: a failed match prints the text it read.
      assert.ok(text.includes('[Kin]'), 'no placeholder stands where a Kin was named');
    });
  },
);

// ---- the draft check, end to end ------------------------------------------

function makeDb(data) {
  const drafts = [];
  const coll = (name) => {
    const rows = data[name] || [];
    const api = {
      _filters: [],
      where(field, op, value) {
        return { ...api, _filters: [...api._filters, { field, op, value }] };
      },
      async get() {
        let out = rows;
        for (const f of this._filters) {
          out = out.filter((r) => (f.op === 'in' ? f.value.includes(r[f.field]) : r[f.field] === f.value));
        }
        return { docs: out.map((r) => ({ id: r.id, exists: true, data: () => r })) };
      },
      doc(id) {
        if (!id) {
          const newId = `draft_${drafts.length + 1}`;
          return { id: newId, async set(obj) { drafts.push({ id: newId, ...obj }); } };
        }
        const found = rows.find((r) => r.id === id);
        return { id, async get() { return { id, exists: !!found, data: () => found }; } };
      },
    };
    return api;
  };
  return { collection: coll, _drafts: drafts };
}

/** One household: Dana, with Biscuit and Mochi. Mochi is not on the visit. */
function householdDb(extra = {}) {
  return makeDb({
    kinfolk: [{ id: 'h1', firstName: 'Dana', lastName: 'Delgado' }],
    kin: [
      { id: 'k1', kinfolkId: 'h1', name: 'Biscuit', species: 'dog' },
      { id: 'k2', kinfolkId: 'h1', name: 'Mochi', species: 'cat' },
    ],
    kin_care_sessions: [{ id: 's1', kinfolkId: 'h1', kinIds: ['k1'], serviceType: '30 Minute Quick Check' }],
    dossiers: [{ id: 'h1', kinfolkId: 'h1', rawSummary: 'Dana likes a short note.' }],
    training_documents: [
      { id: 't1', documentKind: 'voice_example', communicationType: 'email', title: 'Gold', content: 'Hi Marlowe, Tofu did great.' },
    ],
    ...extra,
  });
}

/** A model double that answers each call in turn and keeps what it was sent. */
function model(replies) {
  const calls = [];
  const options = [];
  let i = 0;
  return {
    calls,
    options,
    messages: {
      async create(req, opts) {
        calls.push(req);
        options.push(opts);
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} };
      },
    },
  };
}

const VISIT = { communication_type: 'visit_report', recipient: 'Dana Delgado', session_id: 's1', raw_notes: 'ate, short walk' };
const EMAIL = { communication_type: 'email', recipient: 'Dana', kinfolk_id: 'h1', raw_notes: 'confirming next week' };
const BLOG = { communication_type: 'blog_post', recipient: '', raw_notes: 'slow hot month' };
const CLEAN = 'Biscuit ate and we took a short walk.';
const run = (db, anthropic, body, deps = {}) =>
  gen.runGenerate({ db, anthropic, model: 'm', voiceSource: 'VOICE', sampleNames: ENTRIES, ...deps }, body);
const promptOf = (a, n = 0) => a.calls[n].messages[0].content;

describe('a draft that carries a name out of the writing samples (#2359)', () => {
  it('a KinTale is written again once with the name called out, and the clean draft comes back', async () => {
    const a = model(['Biscuit ate while Tofu watched.', CLEAN]);
    const db = householdDb();
    const out = await run(db, a, VISIT);
    assert.strictEqual(a.calls.length, 2);
    assert.match(promptOf(a, 1), /CORRECTION: your last draft used the name Tofu, which nothing in this request carries/);
    assert.strictEqual(out.generated_copy, CLEAN);
    assert.strictEqual(db._drafts.length, 1);
    assert.doesNotMatch(JSON.stringify(db._drafts), /Tofu/);
  });
  it('is thrown away when the second draft does it too: no copy, no row, and the name is not said', async () => {
    const a = model(['Biscuit ate while Tofu watched.', 'Tofu and Biscuit ate.']);
    const db = householdDb();
    let caught;
    const log = await logged(async () => {
      await assert.rejects(() => run(db, a, VISIT), (e) => { caught = e; return true; });
    });
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(caught.extra.code, 'draft_names_sample_name');
    assert.match(caught.message, /not part of this visit.*notes are untouched.*write the tale yourself/);
    assert.doesNotMatch(caught.message, /Tofu|watched/);
    assert.doesNotMatch(log, /Tofu/);
    assert.strictEqual(a.calls.length, 2);
    assert.strictEqual(db._drafts.length, 0);
    const sent = gen.generateErrorResponse(caught, 'visit_report');
    assert.strictEqual(sent.status, 422);
    assert.strictEqual(sent.body.error, caught.message);
    assert.strictEqual(sent.body.generated_copy, '');
  });
  it('an email is held to the same rule, with its own wording', async () => {
    const a = model(['Hi Dana, Marlowe says hello.']);
    const db = householdDb();
    await logged(async () => {
      await assert.rejects(
        () => run(db, a, EMAIL),
        (e) => e.status === 422 && e.extra.code === 'draft_names_sample_name' &&
          /not part of this message.*write it yourself/.test(e.message) && !/Marlowe|tale/.test(e.message),
      );
    });
    assert.strictEqual(a.calls.length, 2);
    assert.match(promptOf(a, 1), /CORRECTION: your last draft used the name Marlowe/);
    assert.strictEqual(db._drafts.length, 0);
  });
  it('so is a post written for no household at all', async () => {
    const a = model(['August slowed Juniper and Nibbles right down.']);
    await logged(async () => {
      await assert.rejects(() => run(householdDb(), a, BLOG), (e) => e.extra.code === 'draft_names_sample_name');
    });
    assert.match(promptOf(a, 1), /used the names Juniper and Nibbles, which nothing in this request carries.*without those names/);
  });
  it('a name in the training examples does not count as the request carrying it', async () => {
    // The email examples in householdDb mention Marlowe and Tofu. They are
    // style references, so they do not make either name part of the request.
    const a = model(['Hi Dana, Tofu did great.', 'Hi Dana, all set for next week.']);
    const out = await run(householdDb(), a, EMAIL);
    assert.match(promptOf(a, 0), /Hi Marlowe, Tofu did great\./);
    assert.strictEqual(a.calls.length, 2);
    assert.strictEqual(out.generated_copy, 'Hi Dana, all set for next week.');
  });
  it('a Kin on the visit who really has that name is written about as normal', async () => {
    const db = householdDb({
      kin: [{ id: 'k1', kinfolkId: 'h1', name: 'Tofu', species: 'cat' }],
    });
    const a = model(['Tofu ate and we took a short walk.']);
    const out = await run(db, a, VISIT);
    assert.strictEqual(a.calls.length, 1);
    assert.strictEqual(out.generated_copy, 'Tofu ate and we took a short walk.');
  });
  it('a name the Auntie typed in her own notes is hers to use', async () => {
    const a = model(['Biscuit ate. Marlowe from next door waved.']);
    const out = await run(householdDb(), a, { ...VISIT, raw_notes: 'ate. marlowe next door waved' });
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /Marlowe/);
  });
  it('a household Kin of that name may be named in an email to that household', async () => {
    const db = householdDb({ kin: [{ id: 'k1', kinfolkId: 'h1', name: 'Juniper', species: 'dog' }] });
    const a = model(['Hi Dana, Juniper is booked for next week.']);
    const out = await run(db, a, EMAIL);
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /Juniper/);
  });
  it('the off-visit rule still wins, and both are corrected in the one retry', async () => {
    const a = model(['Biscuit ate, Mochi hid and Tofu watched.', 'Biscuit ate and Mochi hid.']);
    await assert.rejects(
      () => run(householdDb(), a, VISIT),
      (e) => e.extra.code === 'draft_names_kin_not_on_visit' && /Mochi/.test(e.message),
    );
    assert.strictEqual(a.calls.length, 2);
    assert.match(promptOf(a, 1), /your last draft named Mochi, who is not on this visit/);
    assert.match(promptOf(a, 1), /your last draft used the name Tofu/);
  });
  it('a placeholder written as a name gets one more try, then the draft is thrown away', async () => {
    const fixed = model(['[Kin] ate and we walked.', CLEAN]);
    const out = await run(householdDb(), fixed, VISIT);
    assert.match(promptOf(fixed, 1), /CORRECTION: your last draft contained a bracketed placeholder/);
    assert.strictEqual(out.generated_copy, CLEAN);

    const db = householdDb();
    const stuck = model(['Hi [Kinfolk], all set.']);
    await logged(async () => {
      await assert.rejects(
        () => run(db, stuck, EMAIL),
        (e) => e.status === 422 && e.extra.code === 'draft_has_placeholder' && /blank where a name belongs/.test(e.message),
      );
    });
    assert.strictEqual(stuck.calls.length, 2);
    assert.strictEqual(db._drafts.length, 0);
  });
  it('with no names declared, a draft is checked for nothing new', async () => {
    const a = model(['Biscuit ate while Tofu watched.']);
    const out = await run(householdDb(), a, VISIT, { sampleNames: [] });
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /Tofu/);
  });
  it('the new copy is plain: a sentence, no code, no dash', async () => {
    for (const [reply, body] of [['Tofu ate.', VISIT], ['Tofu ate.', EMAIL], ['[Kin] ate.', VISIT], ['[Kin] ate.', EMAIL]]) {
      let caught;
      await logged(async () => {
        await assert.rejects(() => run(householdDb(), model([reply]), body), (e) => { caught = e; return true; });
      });
      assert.match(caught.message, /^[A-Z].*\.$/);
      assert.doesNotMatch(caught.message, /_|—|–|\bid\b|Claude|model|sample|placeholder|\[/i);
    }
  });
});

// ---- a model call cannot outlive the request -------------------------------

describe('a model call is held to what is left of the request (#2359)', () => {
  it('the budget for one generate fits inside the 60 second rewrite, with room to answer', () => {
    assert.ok(gen.GENERATE_BUDGET_MS <= 50_000);
    assert.ok(gen.MODEL_CALL_TIMEOUT_MS <= gen.GENERATE_BUDGET_MS);
    assert.ok(gen.MODEL_MAX_RETRIES <= 1);
  });
  it('the function builds its client with that timeout and retry count, not the SDK defaults', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(src, /new Anthropic\(\{ apiKey, timeout: MODEL_CALL_TIMEOUT_MS, maxRetries: MODEL_MAX_RETRIES \}\)/);
  });
  it('every call carries a timeout, a retry count and a deadline', async () => {
    const a = model(['Biscuit ate while Tofu watched.', CLEAN, 'A Short Walk']);
    await run(householdDb(), a, { ...VISIT, want_title: true });
    assert.strictEqual(a.options.length, 3);
    for (const o of a.options) {
      assert.ok(o.timeout > 0 && o.timeout <= gen.MODEL_CALL_TIMEOUT_MS);
      assert.strictEqual(o.maxRetries, gen.MODEL_MAX_RETRIES);
      assert.ok(o.signal instanceof AbortSignal);
    }
  });
  it('a later call gets only the time the earlier ones left', async () => {
    let clock = 0;
    const a = model(['Biscuit ate while Tofu watched.', CLEAN]);
    const create = a.messages.create;
    a.messages.create = async (req, opts) => {
      clock += 28_000;
      return create(req, opts);
    };
    await run(householdDb(), a, VISIT, { now: () => clock });
    assert.strictEqual(a.options[0].timeout, gen.MODEL_CALL_TIMEOUT_MS);
    assert.strictEqual(a.options[1].timeout, gen.GENERATE_BUDGET_MS - 28_000);
  });
  it('with no time left the model is not called, and the screen is told plainly', async () => {
    const a = model([CLEAN]);
    const db = householdDb();
    await logged(async () => {
      await assert.rejects(
        () => run(db, a, VISIT, { budgetMs: 0 }),
        (e) => e.status === 504 && e.extra.code === 'ai_timeout' && e.message === gen.ERROR_COPY.ai_timeout,
      );
    });
    assert.strictEqual(a.calls.length, 0);
    assert.strictEqual(db._drafts.length, 0);
  });
  it('a retry is not started when the first draft used up the request', async () => {
    let clock = 0;
    const a = model(['Biscuit ate while Tofu watched.', CLEAN]);
    const create = a.messages.create;
    a.messages.create = async (req, opts) => {
      clock += 48_000;
      return create(req, opts);
    };
    await logged(async () => {
      await assert.rejects(() => run(householdDb(), a, VISIT, { now: () => clock }), (e) => e.extra.code === 'ai_timeout');
    });
    assert.strictEqual(a.calls.length, 1);
  });
  it('the title is skipped, not the draft, when the time has gone', async () => {
    let clock = 0;
    const a = model([CLEAN, 'A Short Walk']);
    const create = a.messages.create;
    a.messages.create = async (req, opts) => {
      clock += 48_500;
      return create(req, opts);
    };
    const out = await run(householdDb(), a, { ...VISIT, want_title: true }, { now: () => clock });
    assert.strictEqual(a.calls.length, 1);
    assert.strictEqual(out.generated_copy, CLEAN);
    assert.strictEqual(out.generated_title, '');
  });
  it("the SDK's own timeout is reported as taking too long, without its words", async () => {
    const a = model([new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out. req_abc' })]);
    await logged(async () => {
      await assert.rejects(
        () => run(householdDb(), a, VISIT),
        (e) => e.status === 504 && e.extra.code === 'ai_timeout' && !/req_abc|timed out/.test(e.message),
      );
    });
  });
  it('the real client gives up at the deadline, retries included', async () => {
    // A provider that never answers. Without the deadline this would be two
    // tries of the full timeout each.
    let tries = 0;
    const hanging = (_url, init) => new Promise((_resolve, reject) => {
      tries += 1;
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
    });
    const client = new Anthropic({
      apiKey: 'test-key-not-real',
      timeout: gen.MODEL_CALL_TIMEOUT_MS,
      maxRetries: gen.MODEL_MAX_RETRIES,
      fetch: hanging,
    });
    const started = Date.now();
    await logged(async () => {
      await assert.rejects(
        () => gen.callClaude(client, 'system', 'hello', 'claude-sonnet-5-5', 5_000),
        (e) => e.status === 504 && e.extra.code === 'ai_timeout',
      );
    });
    const took = Date.now() - started;
    assert.ok(tries >= 1);
    assert.ok(took >= 4_500 && took < 9_500, `gave up after ${took} ms`);
  });
});
