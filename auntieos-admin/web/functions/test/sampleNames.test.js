// #2359: the names in the writing samples never reach the model, and never
// come back in a draft.
//
// Everything here runs with or without the real voice corpus. The corpus is
// gitignored and never reaches CI, so the rules are proven on a fixture whose
// every name is invented (test/fixtures/voice). The one block that reads the
// real corpus skips when it is absent, and reports counts only: a failure
// message must never print a name out of it.
//
// A name is a name however it is written (any capitals, plural, possessive),
// and the voice files are used only when their one declaration lists someone
// and leaves no listed name behind. Each of those has its own tests below.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Anthropic = require('@anthropic-ai/sdk');
const gen = require('../generate.js');
const names = require('../sampleNames.js');
const check = require('../checkVoice.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'voice');
const FIXTURE_NAMES = ['Juniper', 'Captain Nibbles', 'Cap', 'Nibbles', 'Tofu', 'Marlowe', 'Odette', 'Joss'];
const ENTRIES = [
  { role: 'kin', forms: ['Juniper'] },
  { role: 'kin', forms: ['Captain Nibbles', 'Cap', 'Nibbles'] },
  { role: 'kin', forms: ['Tofu'] },
  { role: 'kinfolk', forms: ['Marlowe'] },
  { role: 'auntie', forms: ['Joss'] },
];

/**
 * A copy of the fixture voice folder with the samples file rewritten, and
 * `others` (file name to rewrite) applied to the Bible or the Playbook.
 */
function voiceDirWith(rewrite, others = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  fs.mkdirSync(path.join(dir, 'corpus'));
  for (const f of ['01_Voice_Bible.md', '02_Channel_Playbook.md']) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
    fs.writeFileSync(path.join(dir, f), others[f] ? others[f](text) : text);
  }
  const samples = fs.readFileSync(path.join(FIXTURE_DIR, 'corpus', 'exemplars.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'corpus', 'exemplars.md'), rewrite(samples));
  return dir;
}

/** The declaration in the fixture samples file, replaced by `block`. */
const withBlock = (block) => (s) => s.replace(/<!--[\s\S]*?-->\n/, block);
const ANY_FIXTURE_NAME = /juniper|nibbles|tofu|marlowe|odette|joss/i;

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
  it('reads the block however its opening is capitalised', () => {
    const out = names.parseSampleNames('<!-- Sample-Names\nkin: Tofu\n-->\nbody');
    assert.deepStrictEqual(out.entries, [{ role: 'kin', forms: ['Tofu'] }]);
    assert.strictEqual(out.body, 'body');
  });
  it('refuses a second block, so no list is ever left in the text', () => {
    const two = '<!-- sample-names\nkin: Tofu\n-->\nbody\n<!-- sample-names\nkin: Juniper\n-->\nmore';
    assert.throws(
      () => names.parseSampleNames(two),
      (e) => e instanceof names.SampleNamesError && e.code === 'voice_sample_names_invalid' &&
        /more than one/.test(e.message) && !ANY_FIXTURE_NAME.test(e.message),
    );
  });
  it('refuses a block that does not open and close as a comment of its own', () => {
    for (const bad of [
      '<!-- sample-names kin: Tofu -->\nbody',
      '<!-- sample-names\nkin: Tofu\nbody with no end',
      '<!--\nsample-names\nkin: Tofu\n-->\nbody',
      'sample-names\nkin: Tofu\n\nbody',
      '<!-- sample-names\nkin: Tofu\n-->\nThe sample-names list is above.',
    ]) {
      assert.throws(
        () => names.parseSampleNames(bad),
        (e) => e instanceof names.SampleNamesError && e.code === 'voice_sample_names_invalid' &&
          !ANY_FIXTURE_NAME.test(e.message),
        bad.slice(0, 24),
      );
    }
  });
  it('refuses a block that closes before its last line', () => {
    const early = '<!-- sample-names\nkin: Tofu\n# was a cat --> now a dog\nkinfolk: Marlowe\n-->\nbody';
    assert.throws(
      () => names.parseSampleNames(early),
      (e) => e instanceof names.SampleNamesError && e.code === 'voice_sample_names_invalid' &&
        /ended early/.test(e.message) && !ANY_FIXTURE_NAME.test(e.message),
    );
    // Another comment in the file, opened and closed, is nobody's business.
    const fine = names.parseSampleNames('<!-- a note -->\n<!-- sample-names\nkin: Tofu\n-->\nbody <!-- more --> end');
    assert.strictEqual(fine.body, '<!-- a note -->\nbody <!-- more --> end');
  });
  it('refuses one name listed on two lines, however each is capitalised', () => {
    for (const bad of ['kin: Tofu\nkinfolk: tofu', 'kin: Tofu | Cap\nauntie: CAP']) {
      assert.throws(
        () => names.parseSampleNames(`<!-- sample-names\n${bad}\n-->`),
        (e) => e instanceof names.SampleNamesError && /line 2/.test(e.message) && !ANY_FIXTURE_NAME.test(e.message),
      );
    }
  });
  it('counts a spelling once when a line repeats it', () => {
    const out = names.parseSampleNames('<!-- sample-names\nkin: Tofu | tofu | TOFU | Tofy\n-->');
    assert.deepStrictEqual(out.entries, [{ role: 'kin', forms: ['Tofu', 'Tofy'] }]);
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
  it('refuses a name written with what names are not written with, so two names on a line are never read as one', () => {
    for (const bad of [
      'kin: Juniper, Cap',
      'kin: Juniper; Cap',
      'kin: Juniper / Cap',
      'kin: Juniper & Cap',
      'kin: "Juniper"',
      'kin: Juniper (the cat)',
      'kin: Juniper # the cat',
      'kinfolk: kin: Juniper',
    ]) {
      assert.throws(
        () => names.parseSampleNames(`<!-- sample-names\nkin: Tofu\n${bad}\n-->`),
        (e) => e instanceof names.SampleNamesError && e.code === 'voice_sample_names_invalid' &&
          /line 2/.test(e.message) && !/Juniper|Cap|Tofu/.test(e.message),
        bad,
      );
    }
    // A full stop, a hyphen, a digit, an apostrophe and an accent are all part of a name.
    const out = names.parseSampleNames("<!-- sample-names\nkin: Mr. Nibbles | R2-D2\nkinfolk: D'Arcy | D\u2019Arcy-Lowe | Zoe\u0308\n-->");
    assert.deepStrictEqual(out.entries, [
      { role: 'kin', forms: ['Mr. Nibbles', 'R2-D2'] },
      { role: 'kinfolk', forms: ["D'Arcy", 'D\u2019Arcy-Lowe', 'Zo\u00eb'] },
    ]);
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
  it('replaces a name however it is capitalised', () => {
    assert.strictEqual(
      names.scrubSampleNames('TOFU ate. tofu slept. ToFu woke. JUNIPER watched Juniper. A baseball cap.', ENTRIES),
      '[Kin] ate. [Kin] slept. [Kin] woke. [Kin 2] watched [Kin 2]. A baseball [Kin 3].',
    );
  });
  it('replaces a plural and a possessive, and keeps the ending', () => {
    assert.strictEqual(
      names.scrubSampleNames("Junipers grow here. Tofus. TOFUS. The Marlowes' gate. Tofu's bowl. Two Josses.", ENTRIES),
      "[Kin]s grow here. [Kin 2]s. [Kin 2]S. The [Kinfolk]s' gate. [Kin 2]'s bowl. Two [Auntie]es.",
    );
  });
  it('reads a possessive written with the letter apostrophe, which counts as a letter everywhere else', () => {
    // U+02BC is a letter to Unicode. Typed after a name it is an apostrophe.
    assert.strictEqual(
      names.scrubSampleNames('Tofu\u02bcs bowl. The Marlowes\u02bc gate. \u02bcJuniper\u02bc, she said.', ENTRIES),
      '[Kin]\u02bcs bowl. The [Kinfolk]s\u02bc gate. \u02bc[Kin 2]\u02bc, she said.',
    );
  });
  it('leaves a word alone that only contains a name', () => {
    const text = 'Juniperus is the genus. The capital. A tofurkey recap. Marlowesque. Tofu2go.';
    assert.strictEqual(names.scrubSampleNames(text, ENTRIES), text);
  });
  it('finds a name of several words across any spacing, a line break included', () => {
    assert.strictEqual(
      names.scrubSampleNames('captain  nibbles sat.\nThen Captain\nNibbles left with CAPTAIN\tNIBBLES.', ENTRIES),
      '[Kin] sat.\nThen [Kin] left with [Kin].',
    );
  });
  it('reads either apostrophe in a name, and an accent typed either way', () => {
    const entries = [{ role: 'kinfolk', forms: ["D'Arcy"] }, { role: 'kin', forms: ['Zo\u00eb'] }];
    assert.strictEqual(
      names.scrubSampleNames('D\u2019Arcy called about Zoe\u0308. d\'arcy rang back.', entries),
      '[Kinfolk] called about [Kin]. [Kinfolk] rang back.',
    );
  });
  it('a scrubber keeps its numbering from a title to the body under it', () => {
    const scrub = names.sampleScrubber(ENTRIES);
    assert.strictEqual(scrub('For JUNIPER and Tofu'), 'For [Kin] and [Kin 2]');
    assert.strictEqual(scrub('tofu first, then Juniper.'), '[Kin 2] first, then [Kin].');
    assert.strictEqual(scrub.replaced(), 4);
  });
  it('counts what is left of the declared names, the Auntie included, in any form', () => {
    assert.strictEqual(names.declaredNamesLeft('[Kin] ate. [Kinfolk] called. A recap.', ENTRIES), 0);
    assert.strictEqual(names.declaredNamesLeft('tofus and JOSS and Captain\nNibbles', ENTRIES), 4);
    assert.strictEqual(names.declaredNamesLeft('Tofu ate.', []), 0);
  });
  it('with nothing declared, returns the text as it came', () => {
    assert.strictEqual(names.scrubSampleNames('Tofu ate.', []), 'Tofu ate.');
  });
});

describe('sampleNamesIn: a draft that carries a name out of the samples', () => {
  it('finds a Kin or Kinfolk name as a word, possessive included', () => {
    assert.deepStrictEqual(names.sampleNamesIn("Tofu's bowl was empty and Marlowe called.", ENTRIES, ''), ['Tofu', 'Marlowe']);
    assert.deepStrictEqual(names.sampleNamesIn('Nibbles was at the door.', ENTRIES, ''), ['Nibbles']);
    assert.deepStrictEqual(names.sampleNamesIn('Tofu\u02bcs bowl was empty.', ENTRIES, ''), ['Tofu']);
  });
  it('finds the name however the draft writes it: capitals, lowercase, plural', () => {
    for (const [draft, written] of [
      ['TOFU ate.', 'TOFU'],
      ['tofu ate.', 'tofu'],
      ['ToFu ate.', 'ToFu'],
      ['Two Tofus ate.', 'Tofu'],
      ['The TOFUS ate.', 'TOFU'],
      ["Tofus' bowls.", 'Tofu'],
    ]) {
      assert.deepStrictEqual(names.sampleNamesIn(draft, ENTRIES, ''), [written], draft);
    }
    assert.deepStrictEqual(
      names.sampleNamesIn('the marlowes and captain\nnibbles', ENTRIES, ''),
      ['captain nibbles', 'nibbles', 'marlowe'],
    );
  });
  it('hands a name back as the draft wrote it, once, and never as the samples file spells it', () => {
    assert.deepStrictEqual(names.sampleNamesIn('TOFU ate. TOFU slept. So did the marlowes.', ENTRIES, ''), ['TOFU', 'marlowe']);
    // A capital the request does not match is the one handed back.
    assert.deepStrictEqual(names.sampleNamesIn('The tofu went in the fridge. Tofu watched.', ENTRIES, 'notes: tofu'), ['Tofu']);
  });
  it('does not take a word that only contains the name', () => {
    assert.deepStrictEqual(names.sampleNamesIn('Tofurkey, a recap, the capital, Juniperus.', ENTRIES, ''), []);
  });
  it('lets a name through when the request writes it as a name', () => {
    const request = 'Kin on this visit: Tofu (cat)';
    for (const draft of ['Tofu ate.', "TOFU!!! Tofu's bowl.", 'Both Tofus ate.', 'tofu ate.']) {
      assert.deepStrictEqual(names.sampleNamesIn(draft, ENTRIES, request), [], draft);
    }
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, 'notes: tofurkey for dinner'), ['Tofu']);
  });
  it('an everyday word in the request does not vouch for the name', () => {
    const request = 'notes: tofu for dinner, cap on the hook';
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, request), ['Tofu']);
    assert.deepStrictEqual(names.sampleNamesIn('TOFU ate.', ENTRIES, request), ['TOFU']);
    assert.deepStrictEqual(names.sampleNamesIn('Cap met me at the door.', ENTRIES, request), ['Cap']);
  });
  it("lets a draft repeat the household's own everyday word as the word it is", () => {
    const draft = 'I left the tofu in the fridge and hung the cap back up.';
    assert.deepStrictEqual(names.sampleNamesIn(draft, ENTRIES, 'notes: tofu for dinner, cap on the hook'), []);
    assert.deepStrictEqual(names.sampleNamesIn(draft, ENTRIES, 'NOTES: TOFU FOR DINNER, CAP ON THE HOOK'), []);
    // The same words when the request never used them are not let through.
    assert.deepStrictEqual(names.sampleNamesIn(draft, ENTRIES, 'notes: ate well'), ['cap', 'tofu']);
  });
  it('a name the request is about is carried however it is stored or typed', () => {
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, '', ['tofu']), []);
    assert.deepStrictEqual(names.sampleNamesIn('Marlowe, all set.', ENTRIES, '', [undefined, '', 'MARLOWE REYES']), []);
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, '', ['Tofurkey']), ['Tofu']);
    assert.deepStrictEqual(names.sampleNamesIn('Tofu ate.', ENTRIES, ''), ['Tofu']);
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

describe('voiceWithoutNames: whether the voice files may be used at all', () => {
  const BIBLE = 'Sir Juniper had an agenda. JUNIPER!';
  const PLAYBOOK = 'Hi Marlowe, quick note about the junipers.';
  const samples = (block) => `# Samples\n${block}### One\nJuniper ate. Tell Marlowe.`;
  const refusal = (texts) => {
    let caught;
    assert.throws(() => names.voiceWithoutNames(texts), (e) => { caught = e; return true; });
    assert.ok(caught instanceof names.SampleNamesError, 'not a refusal this module made');
    assert.doesNotMatch(caught.message, ANY_FIXTURE_NAME);
    return caught.code;
  };

  it('with one block that lists someone, replaces the names in every file and cuts the block', () => {
    const out = names.voiceWithoutNames([BIBLE, PLAYBOOK, samples('<!-- sample-names\nkin: Juniper\nkinfolk: Marlowe\n-->\n')]);
    assert.deepStrictEqual(out.texts, [
      'Sir [Kin] had an agenda. [Kin]!',
      'Hi [Kinfolk], quick note about the [Kin]s.',
      '# Samples\n### One\n[Kin] ate. Tell [Kinfolk].',
    ]);
    assert.deepStrictEqual(out.entries, [{ role: 'kin', forms: ['Juniper'] }, { role: 'kinfolk', forms: ['Marlowe'] }]);
    assert.strictEqual(out.replaced, 6);
  });
  it('refuses files with no block', () => {
    assert.strictEqual(refusal([BIBLE, PLAYBOOK, samples('')]), 'voice_sample_names_missing');
  });
  it('refuses a block that lists nobody: empty, only a comment, or only the Auntie', () => {
    for (const block of [
      '<!-- sample-names\n-->\n',
      '<!-- sample-names\n\n   \n-->\n',
      '<!-- sample-names\n# kin: Juniper\n# to be filled in\n-->\n',
      '<!-- sample-names\nauntie: Joss\n-->\n',
    ]) {
      assert.strictEqual(refusal([BIBLE, PLAYBOOK, samples(block)]), 'voice_sample_names_empty', block);
    }
  });
  it('one Kinfolk is enough, and so is one Kin', () => {
    for (const line of ['kin: Juniper', 'kinfolk: Marlowe']) {
      const out = names.voiceWithoutNames(['', '', samples(`<!-- sample-names\n${line}\n-->\n`)]);
      assert.strictEqual(out.entries.length, 1);
    }
  });
  it('refuses a second block, in the same file or in another', () => {
    const one = '<!-- sample-names\nkin: Juniper\n-->\n';
    const two = '<!-- sample-names\nkinfolk: Marlowe\n-->\n';
    assert.strictEqual(refusal([BIBLE, PLAYBOOK, samples(one + two)]), 'voice_sample_names_invalid');
    assert.strictEqual(refusal([BIBLE, `${two}${PLAYBOOK}`, samples(one)]), 'voice_sample_names_invalid');
    assert.strictEqual(refusal([`${two}${BIBLE}`, PLAYBOOK, samples(one)]), 'voice_sample_names_invalid');
  });
  it('refuses a block left open in any file, and a line it cannot read', () => {
    const one = '<!-- sample-names\nkin: Juniper\n-->\n';
    assert.strictEqual(refusal([BIBLE, `${PLAYBOOK}\n<!-- sample-names\nkinfolk: Marlowe`, samples(one)]), 'voice_sample_names_invalid');
    assert.strictEqual(refusal([BIBLE, PLAYBOOK, samples('<!-- sample-names\ndog: Juniper\n-->\n')]), 'voice_sample_names_invalid');
  });
  it('honours the one block wherever it sits', () => {
    const out = names.voiceWithoutNames([`<!-- sample-names\nkin: Juniper\n-->\n${BIBLE}`, PLAYBOOK, samples('')]);
    assert.strictEqual(out.texts[0], 'Sir [Kin] had an agenda. [Kin]!');
    assert.strictEqual(out.texts[2], '# Samples\n### One\n[Kin] ate. Tell Marlowe.');
  });
  it('refuses when a declared name is still there after replacing', () => {
    // A name that is itself the word a placeholder is made of can never be
    // replaced away: "[Kin]" still reads "Kin".
    assert.strictEqual(
      refusal(['', '', '<!-- sample-names\nkin: Kin\nkinfolk: Marlowe\n-->\nKin ate. Tell Marlowe.']),
      'voice_sample_names_left',
    );
  });
});

describe('readVoice: what the model is given from the voice files (corpus not needed)', () => {
  const refusedWith = async (dir) => {
    let caught;
    const log = await logged(() => {
      assert.throws(() => gen.readVoice(dir), (e) => { caught = e; return true; });
    });
    assert.strictEqual(caught.status, 500);
    assert.strictEqual(caught.message, gen.ERROR_COPY.ai_unavailable);
    assert.doesNotMatch(log, ANY_FIXTURE_NAME);
    return caught.extra.code;
  };

  it('replaces every declared name in all three files and cuts the declaration', () => {
    const voice = gen.readVoice(FIXTURE_DIR);
    for (const name of FIXTURE_NAMES) {
      assert.doesNotMatch(voice.source, new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`, 'i'), name);
    }
    assert.doesNotMatch(voice.source, ANY_FIXTURE_NAME);
    assert.doesNotMatch(voice.source, /sample-names|kinfolk:|a comment line/);
    // The heading names them first, and the tale under it keeps that numbering.
    assert.match(voice.source, /### Gold 1, \[Kin\] & \[Kin 2\], morning visit/);
    assert.match(voice.source, /"\[Kin 2\] was at the door before I had my key out\. \[Kin\] watched from the stairs\. \[Kin 2\]'s bowl/);
    assert.match(voice.source, /### Gold 2, \[Kin\] \(\[Kinfolk\]\), evening walk/);
    assert.match(voice.source, /It's \[Auntie\] with the team/);
    // The Bible and the Playbook go to the model too.
    assert.match(voice.source, /"Sir \[Kin\] had an agenda\."/);
    assert.match(voice.source, /"\[Kin\] ate every bit\."\n.*"Hi \[Kinfolk\], quick note about \[Kin 2\]\."/);
    // Capitals, lowercase and plurals are the same names.
    assert.match(voice.source, /\[Kin\]!!! Not one of your \[Kin\]s, a proper \[Kin\]\. Tell \[Kinfolk\] the gate is latched, the \[Kinfolk\]s like it shut/);
    assert.match(voice.source, /\[Kin\]s are also a kind of tree/);
    // What is not a name is untouched.
    assert.match(voice.source, /NO formula/);
  });
  it('hands back the declared names for the draft check', () => {
    const voice = gen.readVoice(FIXTURE_DIR);
    assert.deepStrictEqual(
      voice.sampleNames.map((e) => `${e.role}:${e.forms.join('|')}`),
      ['kin:Juniper', 'kin:Captain Nibbles|Cap|Nibbles', 'kin:Tofu', 'kinfolk:Marlowe', 'kinfolk:Odette', 'auntie:Joss'],
    );
  });
  it('refuses samples that do not declare their names, and logs no line of them', async () => {
    assert.strictEqual(await refusedWith(voiceDirWith(withBlock(''))), 'voice_sample_names_missing');
  });
  it('refuses a declaration it cannot read, and logs no name from it', async () => {
    const dir = voiceDirWith((s) => s.replace('kin: Tofu', 'cat: Tofu'));
    assert.strictEqual(await refusedWith(dir), 'voice_sample_names_invalid');
  });
  it('refuses a declaration that lists no Kin and no Kinfolk', async () => {
    for (const block of [
      '<!-- sample-names\n-->\n',
      '<!-- sample-names\n# kin: Tofu\n-->\n',
      '<!-- sample-names\nauntie: Joss\n-->\n',
    ]) {
      assert.strictEqual(await refusedWith(voiceDirWith(withBlock(block))), 'voice_sample_names_empty', block);
    }
  });
  it('refuses a second declaration, in the samples or in another voice file', async () => {
    const second = '<!-- sample-names\nkin: Tofu\n-->\n';
    assert.strictEqual(
      await refusedWith(voiceDirWith((s) => `${s}\n<!-- sample-names\nkinfolk: Wendeline\n-->\n`)),
      'voice_sample_names_invalid',
    );
    assert.strictEqual(
      await refusedWith(voiceDirWith((s) => s, { '02_Channel_Playbook.md': (t) => second + t })),
      'voice_sample_names_invalid',
    );
  });
  it('refuses a declaration that closes before its last line', async () => {
    const dir = voiceDirWith((s) => s.replace('kin: Tofu', '# cats --> dogs\nkin: Tofu'));
    assert.strictEqual(await refusedWith(dir), 'voice_sample_names_invalid');
  });
  it('refuses a declaration that never closes', async () => {
    assert.strictEqual(
      await refusedWith(voiceDirWith((s) => s, { '01_Voice_Bible.md': (t) => `${t}\n<!-- sample-names\nkin: Tofu\n` })),
      'voice_sample_names_invalid',
    );
  });
  it('refuses when a declared name would still be there after replacing', async () => {
    const dir = voiceDirWith((s) => s.replace('kin: Tofu', 'kin: Tofu\nkin: Kinfolk'));
    assert.strictEqual(await refusedWith(dir), 'voice_sample_names_left');
  });
  it('still fails plainly when a voice file is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-empty-'));
    await logged(() => {
      assert.throws(() => gen.readVoice(dir), (e) => e.status === 500 && e.extra.code === 'voice_source_missing');
    });
  });
  it('the system prompt says placeholders are never written', () => {
    assert.match(gen.SYSTEM_FRAMING, /Never write a bracketed placeholder/);
    assert.match(gen.SYSTEM_FRAMING, /the exemplars, any voice training examples and\n\s+the office's own writing/);
    assert.match(gen.SYSTEM_FRAMING, /\[Name\], and contact details with \[email\], \[phone\], \[link\], \[address\] and \[number\]/);
  });
});

describe('checkVoice: the same question, asked before the files are deployed', () => {
  const CLI = path.join(__dirname, '..', 'checkVoice.js');
  const cli = (dir) => {
    const out = spawnSync(process.execPath, [CLI, dir], { encoding: 'utf8' });
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it('passes the files a generate would use, with counts and no name', () => {
    const result = check.checkVoice(FIXTURE_DIR);
    assert.strictEqual(result.status, 'ok');
    assert.match(result.message, /^6 declared \(8 spellings\), \d+ replaced, none left$/);
    const ran = cli(FIXTURE_DIR);
    assert.strictEqual(ran.status, 0);
    assert.match(ran.text, /^voice: sample names 6 declared/);
    assert.doesNotMatch(ran.text, ANY_FIXTURE_NAME);
  });
  it('agrees with readVoice on every folder it refuses, and prints the reason without a name', async () => {
    for (const [dir, code] of [
      [voiceDirWith(withBlock('')), 'voice_sample_names_missing'],
      [voiceDirWith(withBlock('<!-- sample-names\nauntie: Joss\n-->\n')), 'voice_sample_names_empty'],
      [voiceDirWith((s) => `${s}\n<!-- sample-names\nkin: Wendeline\n-->\n`), 'voice_sample_names_invalid'],
      [voiceDirWith((s) => s.replace('kin: Tofu', 'kin: Tofu\nkin: Kinfolk')), 'voice_sample_names_left'],
    ]) {
      const result = check.checkVoice(dir);
      assert.strictEqual(result.status, 'refused');
      assert.strictEqual(result.code, code);
      await logged(() => {
        assert.throws(() => gen.readVoice(dir), (e) => e.extra.code === code);
      });
      const ran = cli(dir);
      assert.strictEqual(ran.status, 1);
      assert.ok(ran.text.includes(`voice: refused (${code})`), code);
      assert.doesNotMatch(ran.text, /juniper|nibbles|tofu|marlowe|odette|joss|wendeline/i);
    }
  });
  it('tells files that are not there from files that cannot be used', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-empty-'));
    assert.strictEqual(check.checkVoice(empty).status, 'absent');
    assert.strictEqual(cli(empty).status, 3);
    // Two of three is still not there: a generate refuses it the same way.
    const partial = voiceDirWith((s) => s);
    fs.rmSync(path.join(partial, '01_Voice_Bible.md'));
    assert.strictEqual(check.checkVoice(partial).status, 'absent');
    assert.match(cli(partial).text, /1 of 3 voice files are not in this checkout/);
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
      assert.ok(
        voice.sampleNames.some((e) => e.role === 'kin' || e.role === 'kinfolk'),
        'the corpus declares no Kin and no Kinfolk',
      );
      const text = gen.buildSystemPrompt(voice.source)[0].text;
      // Any capitals, plural or not, the Auntie's name included.
      const left = names.declaredNamesLeft(text, voice.sampleNames);
      assert.strictEqual(left, 0, `${left} declared name(s) are still in the system prompt`);
      assert.ok(!/sample-names/i.test(text), 'the declaration itself is in the system prompt');
      // assert.ok, not assert.match: a failed match prints the text it read.
      assert.ok(text.includes('[Kin]'), 'no placeholder stands where a Kin was named');
    });
    it('passes the check a release runs on it', () => {
      const result = check.checkVoice(path.join(__dirname, '..', 'voice'));
      assert.strictEqual(result.status, 'ok', `${result.status} ${result.code || ''}`);
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
    assert.strictEqual(a.calls.length, 2);
    assert.strictEqual(out.generated_copy, 'Hi Dana, all set for next week.');
  });
  it('the training examples are sent with the same names replaced, title included', async () => {
    const db = householdDb({
      training_documents: [
        { id: 't1', documentKind: 'voice_example', communicationType: 'email', title: 'Gold for MARLOWE', content: 'Hi Marlowe, Tofu did great. tofu naps. Both Tofus.' },
        { id: 't2', documentKind: 'voice_example', communicationType: 'email', title: 'Second', content: 'Juniper says hi to Dana.' },
        { id: 't3', documentKind: 'voice_example', communicationType: 'email', content: 'No title on this one, Marlowe.' },
      ],
    });
    const a = model(['Hi Dana, all set for next week.']);
    await run(db, a, EMAIL);
    const prompt = promptOf(a, 0);
    assert.match(prompt, /\[Gold for \[Kinfolk\]\]\nHi \[Kinfolk\], \[Kin\] did great\. \[Kin\] naps\. Both \[Kin\]s\./);
    // Each example numbers its own Kin. A name nobody declared is not touched.
    assert.match(prompt, /\[Second\]\n\[Kin\] says hi to Dana\./);
    assert.match(prompt, /\[\]\nNo title on this one, \[Kinfolk\]\./);
    assert.doesNotMatch(prompt, /marlowe|tofu|juniper/i);
  });
  it('so are the examples for a post written for no household', async () => {
    const db = householdDb({
      training_documents: [
        { id: 't4', documentKind: 'voice_example', communicationType: 'blog_post', title: 'Nibbles in August', content: 'CAPTAIN NIBBLES slowed right down.' },
      ],
    });
    const a = model(['August was slow for everyone.']);
    await run(db, a, BLOG);
    assert.match(promptOf(a, 0), /\[\[Kin\] in August\]\n\[Kin\] slowed right down\./);
    assert.doesNotMatch(promptOf(a, 0), /nibbles|captain/i);
  });
  it('a retry is sent the examples with the names replaced too', async () => {
    const a = model(['Hi Dana, Tofu did great.', 'Hi Dana, all set for next week.']);
    await run(householdDb(), a, EMAIL);
    assert.match(promptOf(a, 1), /Hi \[Kinfolk\], \[Kin\] did great\./);
    // The one place the name stands is the correction that calls it out.
    assert.strictEqual(promptOf(a, 1).match(/Tofu/g).length, 1);
    assert.doesNotMatch(promptOf(a, 1), /Marlowe/);
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
  it('a Kin stored without its capital is still a Kin of that household', async () => {
    const db = householdDb({ kin: [{ id: 'k1', kinfolkId: 'h1', name: 'tofu', species: 'cat' }] });
    for (const [body, draft] of [[VISIT, 'Tofu ate and we took a short walk.'], [EMAIL, 'Hi Dana, Tofu is booked in.']]) {
      const a = model([draft]);
      const out = await run(db, a, body);
      assert.strictEqual(a.calls.length, 1, draft);
      assert.strictEqual(out.generated_copy, draft);
    }
  });
  it('the recipient as typed is a name the draft may use', async () => {
    const a = model(['Hi Marlowe, all set for next week.']);
    const out = await run(householdDb(), a, { ...EMAIL, recipient: 'marlowe' });
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /Marlowe/);
  });
  it('a name the Auntie typed in her own notes is hers to use', async () => {
    const a = model(['Biscuit ate. Marlowe from next door waved.']);
    const out = await run(householdDb(), a, { ...VISIT, raw_notes: 'ate. Marlowe next door waved' });
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /Marlowe/);
  });
  it('an everyday word in the notes does not make a name of it', async () => {
    // "tofu" is supper here, and nobody in this household is called that.
    const a = model(['Biscuit ate. Tofu watched from the stairs.', CLEAN]);
    const out = await run(householdDb(), a, { ...VISIT, raw_notes: 'ate. left the tofu in the fridge' });
    assert.strictEqual(a.calls.length, 2);
    assert.match(promptOf(a, 1), /CORRECTION: your last draft used the name Tofu, which nothing in this request carries/);
    assert.strictEqual(out.generated_copy, CLEAN);
  });
  it('and the draft may still say the everyday word the way the notes did', async () => {
    const a = model(['Biscuit ate, and the tofu is in the fridge.']);
    const out = await run(householdDb(), a, { ...VISIT, raw_notes: 'ate. left the tofu in the fridge' });
    assert.strictEqual(a.calls.length, 1);
    assert.match(out.generated_copy, /the tofu is in the fridge/);
  });
  it('a name in capitals, in lowercase or as a plural is the same name', async () => {
    for (const first of ['Biscuit ate while TOFU watched.', 'Biscuit ate with the Marlowes.', 'Biscuit ate. so did tofu.']) {
      const a = model([first, CLEAN]);
      const out = await run(householdDb(), a, VISIT);
      assert.strictEqual(a.calls.length, 2, first);
      assert.strictEqual(out.generated_copy, CLEAN);
    }
  });
  it("the correction quotes the draft's own spelling, not the one in the samples file", async () => {
    const a = model(['Biscuit ate while TOFU watched the marlowes.', CLEAN]);
    await run(householdDb(), a, VISIT);
    assert.match(promptOf(a, 1), /your last draft used the names TOFU and marlowe, which nothing in this request carries/);
    assert.doesNotMatch(promptOf(a, 1), /Tofu|Marlowe/);
  });
  it('and is thrown away in that form when the second draft keeps it', async () => {
    for (const draft of ['Biscuit ate while TOFU watched.', 'Biscuit ate with the Marlowes.']) {
      const db = householdDb();
      let caught;
      const log = await logged(async () => {
        await assert.rejects(() => run(db, model([draft]), VISIT), (e) => { caught = e; return true; });
      });
      assert.strictEqual(caught.status, 422);
      assert.strictEqual(caught.extra.code, 'draft_names_sample_name');
      assert.doesNotMatch(`${caught.message}${log}`, ANY_FIXTURE_NAME);
      assert.strictEqual(db._drafts.length, 0);
    }
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
