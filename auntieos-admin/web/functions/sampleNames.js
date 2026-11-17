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

const BLOCK = /<!--[ \t]*sample-names[ \t]*\r?\n([\s\S]*?)-->[ \t]*(?:\r?\n)?/;
const PLACEHOLDER_LABEL = { kin: 'Kin', kinfolk: 'Kinfolk', auntie: 'Auntie' };
const PLACEHOLDER = /\[(?:Kin|Kinfolk|Auntie)(?: \d+)?\]/;
const HEADING = /^#{1,6} /;

class SampleNamesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SampleNamesError';
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `forms` as one pattern that matches each only as a word of its own. */
function wordPattern(forms, flags) {
  const longestFirst = [...forms].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${longestFirst.join('|')})(?![\\p{L}\\p{N}])`, flags);
}

/**
 * Splits a samples file into its declared names and the text without the
 * declaration. `declared` is false when the file has no block at all, which is
 * different from a block that declares nothing.
 *
 * The messages here never repeat a line of the file: they are logged.
 */
function parseSampleNames(text) {
  const source = String(text || '');
  const m = BLOCK.exec(source);
  if (!m) return { declared: false, entries: [], body: source };
  const entries = [];
  m[1].split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const colon = line.indexOf(':');
    const role = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase();
    if (!PLACEHOLDER_LABEL[role]) {
      throw new SampleNamesError(`sample-names line ${i + 1}: expected "kin:", "kinfolk:" or "auntie:"`);
    }
    const forms = [...new Set(line.slice(colon + 1).split('|').map((f) => f.trim()).filter(Boolean))];
    if (!forms.length) throw new SampleNamesError(`sample-names line ${i + 1}: no name after the colon`);
    if (forms.some((f) => f.length < 2)) {
      throw new SampleNamesError(`sample-names line ${i + 1}: a name needs at least two characters`);
    }
    entries.push({ role, forms });
  });
  return { declared: true, entries, body: source.slice(0, m.index) + source.slice(m.index + m[0].length) };
}

/**
 * `text` with every declared name replaced by a placeholder. Numbering starts
 * again at each markdown heading, so each sample reads [Kin], [Kin 2] in the
 * order its own Kin appear, and the same Kin keeps one placeholder throughout
 * a sample whichever way the name is written.
 */
function scrubSampleNames(text, entries) {
  const source = String(text || '');
  if (!entries || !entries.length) return source;
  const entryOf = new Map();
  for (const entry of entries) for (const form of entry.forms) entryOf.set(form, entry);
  const pattern = wordPattern([...entryOf.keys()], 'gu');
  let given = new Map();
  let counts = {};
  return source
    .split('\n')
    .map((line) => {
      if (HEADING.test(line)) {
        given = new Map();
        counts = {};
      }
      return line.replace(pattern, (form) => {
        const entry = entryOf.get(form);
        if (!given.has(entry)) {
          const label = PLACEHOLDER_LABEL[entry.role];
          counts[entry.role] = (counts[entry.role] || 0) + 1;
          const n = counts[entry.role];
          given.set(entry, entry.role === 'auntie' || n === 1 ? `[${label}]` : `[${label} ${n}]`);
        }
        return given.get(entry);
      });
    })
    .join('\n');
}

/**
 * The declared Kin and Kinfolk names a draft uses that its own request never
 * mentioned. `requestText` is everything about this household and this message
 * the model was given: a Kin who really is called what a sample's Kin is
 * called, or a name the Auntie typed herself, is not a borrowed name.
 *
 * The draft is matched as written, capital first, so "pepper" the spice is
 * not "Pepper" the Kin. The request is matched in any case, because notes are
 * typed in a hurry.
 */
function sampleNamesIn(draft, entries, requestText) {
  const text = String(draft || '');
  const request = String(requestText || '');
  const found = [];
  for (const entry of entries || []) {
    if (entry.role === 'auntie') continue;
    for (const form of entry.forms) {
      if (found.includes(form)) continue;
      if (!wordPattern([form], 'u').test(text)) continue;
      if (wordPattern([form], 'iu').test(request)) continue;
      found.push(form);
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
  scrubSampleNames,
  sampleNamesIn,
  hasPlaceholder,
};
