// #2359: the names in Ask Auntie's writing-style samples.
//
// The samples are shown to the model for rhythm, never for who is in them, so
// they use placeholder names. Two things keep a sample's names out of a draft:
//
//   1. Before the samples reach the prompt, every declared name is replaced
//      with a placeholder ([Kin], [Kin 2], [Kinfolk], [Auntie]).
//   2. After the model answers, a draft that carries a declared name the
//      request itself never mentioned is not handed over.
//
// The names are declared in the samples file itself, which is gitignored along
// with the rest of the voice corpus. No real name is written in tracked code.
// The declaration is one comment block, anywhere in the file:
//
//   <!-- sample-names
//   kin: Biscuit
//   kin: Sir Waffle | Waffle | SW
//   kinfolk: Dana
//   auntie: Joss
//   -->
//
// One line per Kin or person. `|` separates the other ways the same one is
// written (a short name, initials); they all become the same placeholder.
// `kin` and `kinfolk` names are replaced and also refused in a draft. An
// `auntie` name is replaced only: she may sign her own name.
//
// A name is matched however it is written: any capitals, a plural, a
// possessive. The voice files are used only when all of this holds
// (`voiceWithoutNames`): they carry exactly one block, it lists at least one
// Kin or Kinfolk, and no listed name is left in the text once the replacing is
// done. Anything else stops the prompt from being built.

const MARKER = /sample-names/giu;
const BLOCK = /<!--[ \t]*sample-names[ \t]*\r?\n([\s\S]*?)-->[ \t]*(?:\r?\n)?/giu;
const PLACEHOLDER_LABEL = { kin: 'Kin', kinfolk: 'Kinfolk', auntie: 'Auntie' };
const PLACEHOLDER = /\[(?:Kin|Kinfolk|Auntie)(?: \d+)?\]/;
const APOSTROPHES = /['’‘ʼ]/gu;
// What a declared name may be written with. A comma, a bracket, a quote mark or
// a note after the name would make one "name" that matches nothing, and the
// names on that line would stay in the text.
const NAME = /^[\p{L}\p{M}\p{N}\s'’‘ʼ.-]+$/u;
// A name stands as a word of its own, with or without a plural ending. The
// letter apostrophe (U+02BC) is a letter to Unicode and an apostrophe to
// whoever typed it, so it ends a name the way the other three do.
const WORD_CHAR = '(?!ʼ)[\\p{L}\\p{N}]';
const WORD_START = `(?<!${WORD_CHAR})`;
const WORD_END = `(e?s)?(?!${WORD_CHAR})`;

/**
 * `code` is what a generate answers with when the voice files cannot be used.
 * The messages never repeat a line of a file: they are logged.
 */
class SampleNamesError extends Error {
  constructor(message, code = 'voice_sample_names_invalid') {
    super(message);
    this.name = 'SampleNamesError';
    this.code = code;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const tidy = (text) => String(text || '').normalize('NFC');
const fold = (text) => tidy(text).toLowerCase();
const hasCapital = (text) => text !== text.toLowerCase();

/** One name as a pattern: any spacing between its words, either apostrophe. */
function formSource(form) {
  return form
    .split(/\s+/u)
    .map((word) => escapeRegExp(word).replace(APOSTROPHES, "['’‘ʼ]"))
    .join('\\s+');
}

/** Matches `form` in any case, plural or not. Group 1 is the name as written. */
function formPattern(form, flags) {
  return new RegExp(`${WORD_START}(${formSource(form)})${WORD_END}`, flags);
}

/**
 * Splits a samples file into its declared names and the text without the
 * declaration. `declared` is false when the file has no block at all, which is
 * different from a block that declares nothing.
 *
 * A file gets one block. A second one, or one that does not open and close as
 * a comment of its own, is refused: its names would otherwise stay in the text.
 */
function parseSampleNames(text) {
  const source = String(text || '');
  const mentions = (source.match(MARKER) || []).length;
  if (!mentions) return { declared: false, entries: [], body: source };
  const blocks = [...source.matchAll(BLOCK)];
  if (blocks.length > 1) throw new SampleNamesError('more than one sample-names block: every name goes in one');
  if (blocks.length !== 1 || mentions !== 1) {
    throw new SampleNamesError('the sample-names block must open and close as a comment of its own, and be written once');
  }
  const m = blocks[0];
  const entries = [];
  const listed = new Set();
  m[1].split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const colon = line.indexOf(':');
    const role = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase();
    if (!PLACEHOLDER_LABEL[role]) {
      throw new SampleNamesError(`sample-names line ${i + 1}: expected "kin:", "kinfolk:" or "auntie:"`);
    }
    const forms = [];
    for (const form of line.slice(colon + 1).split('|').map((f) => tidy(f).trim()).filter(Boolean)) {
      if (form.length < 2) {
        throw new SampleNamesError(`sample-names line ${i + 1}: a name needs at least two characters`);
      }
      if (!NAME.test(form)) {
        throw new SampleNamesError(
          `sample-names line ${i + 1}: a name is letters, digits, spaces, apostrophes, hyphens and full stops, with "|" between two spellings`,
        );
      }
      if (forms.some((f) => fold(f) === fold(form))) continue;
      if (listed.has(fold(form))) {
        throw new SampleNamesError(`sample-names line ${i + 1}: a name on this line is already listed on another line`);
      }
      forms.push(form);
    }
    if (!forms.length) throw new SampleNamesError(`sample-names line ${i + 1}: no name after the colon`);
    forms.forEach((f) => listed.add(fold(f)));
    entries.push({ role, forms });
  });
  const body = source.slice(0, m.index) + source.slice(m.index + m[0].length);
  // The block ends at the first "-->", so one written inside it (in a comment
  // line, say) would leave the rest of the list in the text. What gives that
  // away is a comment closing afterwards that nothing opened.
  let open = 0;
  for (const [mark] of body.matchAll(/<!--|-->/g)) {
    if (mark === '<!--') open += 1;
    else if (open === 0) {
      throw new SampleNamesError('a comment closes in this file that nothing opened: the sample-names block may have ended early');
    } else open -= 1;
  }
  return { declared: true, entries, body };
}

/**
 * A function that replaces every declared name in the text it is given, and
 * keeps its numbering from one call to the next (a title, then its body).
 * `replaced()` is how many names it has taken out so far.
 */
function sampleScrubber(entries) {
  const forms = [];
  for (const entry of entries || []) for (const form of entry.forms) forms.push({ form, entry });
  // Longest first, so "Sir Waffle" is one name and not "Sir" plus a name.
  forms.sort((a, b) => b.form.length - a.form.length);
  // A heading, or a name. Each name is a group of its own, so the one that
  // matched says whose it is, however the text capitalised it.
  const pattern = forms.length
    ? new RegExp(`(^#{1,6} )|${WORD_START}(?:${forms.map((f) => `(${formSource(f.form)})`).join('|')})${WORD_END}`, 'gimu')
    : null;
  let given = new Map();
  let counts = {};
  let replaced = 0;
  const scrub = (text) => {
    const source = tidy(text);
    if (!pattern) return source;
    return source.replace(pattern, (match, heading, ...rest) => {
      if (heading !== undefined) {
        // Numbering starts again at each heading: each sample has its own Kin.
        given = new Map();
        counts = {};
        return match;
      }
      const { entry } = forms[rest.findIndex((group) => group !== undefined)];
      if (!given.has(entry)) {
        const label = PLACEHOLDER_LABEL[entry.role];
        counts[entry.role] = (counts[entry.role] || 0) + 1;
        const n = counts[entry.role];
        given.set(entry, entry.role === 'auntie' || n === 1 ? `[${label}]` : `[${label} ${n}]`);
      }
      replaced += 1;
      return given.get(entry) + (rest[forms.length] || '');
    });
  };
  scrub.replaced = () => replaced;
  return scrub;
}

/**
 * `text` with every declared name replaced by a placeholder, however the name
 * is capitalised and whether or not it is plural. Numbering starts again at
 * each markdown heading, so each sample reads [Kin], [Kin 2] in the order its
 * own Kin appear, and the same Kin keeps one placeholder throughout a sample
 * whichever way the name is written.
 */
function scrubSampleNames(text, entries) {
  return sampleScrubber(entries)(text);
}

/** How many declared names, of any role, `text` still carries. A count only. */
function declaredNamesLeft(text, entries) {
  const source = tidy(text);
  let left = 0;
  for (const entry of entries || []) {
    for (const form of entry.forms) if (formPattern(form, 'iu').test(source)) left += 1;
  }
  return left;
}

/**
 * The voice files as the model may read them: `texts` with the declaration cut
 * and every declared name replaced. Throws a SampleNamesError, and so stops the
 * prompt being built, unless all of this holds:
 *
 *   - the files carry exactly one sample-names block between them;
 *   - it lists at least one Kin or Kinfolk (an empty block, or one that only
 *     names the Auntie, replaces nothing that matters);
 *   - once the names are replaced, none of them is left in any form.
 *
 * The request path (`readVoice`) and the check before a release
 * (`checkVoice.js`) both go through here, so they cannot disagree.
 */
function voiceWithoutNames(texts) {
  const parsed = texts.map((text) => parseSampleNames(text));
  const blocks = parsed.filter((p) => p.declared);
  if (!blocks.length) {
    throw new SampleNamesError(
      'the voice files have no sample-names block, so their names cannot be replaced',
      'voice_sample_names_missing',
    );
  }
  if (blocks.length > 1) {
    throw new SampleNamesError('more than one voice file has a sample-names block: every name goes in one');
  }
  const { entries } = blocks[0];
  if (!entries.some((e) => e.role === 'kin' || e.role === 'kinfolk')) {
    throw new SampleNamesError(
      'the sample-names block lists no Kin and no Kinfolk, so nothing would be replaced',
      'voice_sample_names_empty',
    );
  }
  let replaced = 0;
  const scrubbed = parsed.map((p) => {
    const scrub = sampleScrubber(entries);
    const out = scrub(p.body);
    replaced += scrub.replaced();
    return out;
  });
  const left = scrubbed.reduce((n, text) => n + declaredNamesLeft(text, entries), 0);
  if (left) {
    throw new SampleNamesError(
      `${left} declared name(s) are still in the voice files after replacing`,
      'voice_sample_names_left',
    );
  }
  return { texts: scrubbed, entries, replaced };
}

/**
 * The declared Kin and Kinfolk names a draft uses that its own request does
 * not carry. The draft is read for the name in any case, plural or possessive.
 *
 * What carries a name:
 *
 *   - `carriedNames`: the names this request is about (its Kin, its Kinfolk,
 *     its recipient). They are names by construction, so any case counts.
 *   - `requestText`: everything else the model was given about this household
 *     and this message. Here capitals matter. A name the draft writes with a
 *     capital needs a capital in the request too, so an everyday word in a
 *     note ("pepper on her food") does not vouch for "Pepper" the Kin. A word
 *     the draft writes all in lowercase is carried by the request using it in
 *     any case, so a household's own everyday word can be repeated.
 *
 * Each name comes back as the draft wrote it (without a plural ending), not as
 * the samples file spells it: the correction that goes back to the model then
 * quotes the model's own words and nothing out of the declaration.
 */
function sampleNamesIn(draft, entries, requestText, carriedNames) {
  const text = tidy(draft);
  const request = tidy(requestText);
  const carried = tidy((carriedNames || []).filter(Boolean).join('\n'));
  const found = [];
  for (const entry of entries || []) {
    if (entry.role === 'auntie') continue;
    for (const form of entry.forms) {
      const written = [...text.matchAll(formPattern(form, 'giu'))].map((m) => m[1]);
      if (!written.length) continue;
      if (formPattern(form, 'iu').test(carried)) continue;
      const inRequest = [...request.matchAll(formPattern(form, 'giu'))].map((m) => m[1]);
      const withCapital = inRequest.some(hasCapital);
      const borrowed = written.find((w) => (hasCapital(w) ? !withCapital : !inRequest.length));
      if (borrowed === undefined) continue;
      const asWritten = borrowed.replace(/\s+/gu, ' ');
      if (!found.includes(asWritten)) found.push(asWritten);
    }
  }
  return found;
}

/** True when a draft carries a placeholder through as if it were a name. */
function hasPlaceholder(draft) {
  return PLACEHOLDER.test(String(draft || ''));
}

module.exports = {
  SampleNamesError,
  parseSampleNames,
  sampleScrubber,
  scrubSampleNames,
  declaredNamesLeft,
  voiceWithoutNames,
  sampleNamesIn,
  hasPlaceholder,
};
