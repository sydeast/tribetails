// #2424 ruling, 2026-11-20: Ask Auntie's voice also learns from what the
// owner and the Aunties wrote themselves.
//
// What counts: messages the office typed and sent to a household. Inbox
// replies (`conversations/{kinfolkId}/messages`, sender `auntie`), text replies
// sent from the Inbox (`sms_messages` rows mirrored by `sendExternalMessage`),
// outbound emails on file (`emails`, direction `outbound`), sent KinTales
// written in the composer (`kin_care_reports`, status SENT, not published from
// a generated draft and not a legacy import), the office's comments on those
// KinTales, and broadcasts (`broadcasts`). A row whose text overlaps a
// generated draft is left out, so generated copy does not train the voice.
//
// What reaches the model: STYLE EXAMPLES ONLY, the same small set for every
// request. Before any example is used:
//
//   1. Contact details and merge tokens become placeholders: [email],
//      [phone], [link], [address], [number].
//   2. Every name the Tribe holds (every household person, every Kin, every
//      staff member, and the names on the row itself) becomes [Kinfolk],
//      [Kin] or [Auntie], numbered within the example.
//   3. Any other capitalised word that nothing vouches for as an everyday word
//      becomes [Name].
//   4. The example is read again. One that still carries a Tribe name or a
//      contact detail is dropped, never sent.
//
// If the names cannot all be read, no example is sent at all: the voice files
// still go and the generate still works. Every read is a single-field query
// with the rest filtered in memory. The log gets counts, never a line of text.

const PLACEHOLDER_TOKEN = /\[(?:Kin|Kinfolk|Auntie|Name|email|phone|link|address|number)(?: \d+)?\]/u;

/** How many examples, how long each, how many of one kind. */
const MAX_EXAMPLES = 12;
const MAX_PER_KIND = 3;
const MAX_EXAMPLE_CHARS = 900;
const MIN_EXAMPLE_CHARS = 40;
/** How long one instance keeps a built set, and how long a build may take. */
const CACHE_MS = 10 * 60 * 1000;
const FAILED_CACHE_MS = 60 * 1000;
const BUILD_BUDGET_MS = 8_000;
/** Words in a row two texts must share to count as the same writing. */
const SHINGLE_WORDS = 8;

const KIND_LABEL = {
  inbox_reply: 'Inbox reply',
  text_reply: 'Text reply',
  email: 'Email',
  kintale: 'KinTale',
  kintale_comment: 'KinTale comment',
  broadcast: 'Broadcast',
};

// Capitalised words that are never a name. The brand words, the calendar, and
// a few forms that never appear in lowercase.
const ALWAYS_WORDS = new Set([
  'i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay', 'am', 'pm', 'tv', 'asap', 'lol', 'diy',
  'hi', 'hey', 'hello', 'dear', 'thanks', 'thank', 'xoxo', 'ps',
  'dr', 'mr', 'mrs', 'ms', 'mx',
  'kin', 'kinfolk', 'auntie', 'aunties', 'tribe', 'kintale', 'kintales', 'kincare', 'mytribe', 'tribetails', 'tails',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

const APOSTROPHES = /['’‘ʼ]/gu;
const tidy = (text) => String(text || '').normalize('NFC');
const fold = (text) => tidy(text).toLowerCase().replace(APOSTROPHES, "'");
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 1. contact details ----------------------------------------------------

const IDENTIFIERS = [
  [/\{\{\s*[^}]*\}\}/gu, '[Kinfolk]'],
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[email]'],
  [/\b(?:https?:\/\/|www\.)\S+/giu, '[link]'],
  [/\b[\p{L}\p{N}-]+\.(?:com|net|org|io|co|us|app|me|info|biz)(?:\/\S*)?\b/giu, '[link]'],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/gu, '[phone]'],
  [
    /\b\d{1,6}\s+(?:[\p{Lu}][\p{L}.'-]*\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Trl|Trail|Ter|Terrace|Loop|Run|Row)\b\.?/gu,
    '[address]',
  ],
  [/\b\d{4,}\b/gu, '[number]'],
];

/** `text` with contact details, links, long numbers and merge tokens replaced. */
function withoutIdentifiers(text) {
  let out = tidy(text);
  for (const [pattern, token] of IDENTIFIERS) out = out.replace(pattern, token);
  return out;
}

/** True when a contact detail the patterns know is still in `text`. */
function hasIdentifier(text) {
  const source = tidy(text);
  return IDENTIFIERS.some(([pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(source));
}

// ---- 2. the Tribe's names --------------------------------------------------

const NAME_KEYS = new Set(['name', 'firstname', 'lastname', 'displayname', 'preferredname', 'nickname', 'fullname', 'callname']);
const NOT_NAME_KEYS = new Set(['businessname', 'filename', 'templatename', 'servicename', 'segmentname', 'albumname', 'fieldname']);
const NAME_TEXT = /^[\p{L}\p{M}\s'’‘ʼ.-]+$/u;

/** Every name-like text a record carries, nested one level in lists and maps. */
function namesInRecord(record, depth = 0) {
  const out = [];
  if (!record || typeof record !== 'object' || depth > 2) return out;
  for (const [key, value] of Object.entries(record)) {
    const k = key.toLowerCase();
    if (typeof value === 'string') {
      if (!NOT_NAME_KEYS.has(k) && (NAME_KEYS.has(k) || k.endsWith('name'))) out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) out.push(...namesInRecord(item, depth + 1));
    } else if (value && typeof value === 'object' && !(value instanceof Date) && typeof value.toDate !== 'function') {
      out.push(...namesInRecord(value, depth + 1));
    }
  }
  return out;
}

/**
 * A roster from raw texts: each full name and each word of it, as its own
 * form, with the role it was found under. Emails and anything that is not
 * letters are skipped (an email is caught by the contact patterns).
 */
// Words a household's name is built with that are not a name of their own
// ("The Vashti Household"). The whole name is still replaced.
const NAME_JOINERS = new Set([
  'the', 'and', 'of', 'household', 'family', 'house', 'home', 'crew', 'pack', 'clan', 'jr', 'sr',
  'de', 'del', 'la', 'le', 'van', 'von', 'der', 'den', 'da', 'di', 'du', 'st', 'mc',
]);
function addNames(roster, role, texts) {
  // One field can hold two people ("A & B", "A and B", "A/B"): each part is a
  // name of its own.
  // An email address is not a name: the contact patterns replace it whole.
  const parts = texts.filter((raw) => !String(raw || '').includes('@')).flatMap((raw) => tidy(raw).split(/[^\p{L}\p{M}\s'’‘ʼ.-]+|\s+and\s+/iu));
  for (const raw of parts) {
    const text = tidy(raw).replace(/\s+/gu, ' ').trim();
    if (text.length < 2 || !NAME_TEXT.test(text)) continue;
    const words = text.split(' ').filter((w) => !NAME_JOINERS.has(fold(w)));
    const forms = [text, ...(words.length > 1 || text.includes(' ') ? words : [])].map((f) => f.replace(/^[.'’‘ʼ-]+|[.'’‘ʼ-]+$/gu, ''));
    for (const form of forms) {
      if (form.length < 2) continue;
      const key = fold(form);
      if (ALWAYS_WORDS.has(key) && role !== 'kin') continue;
      if (!roster.has(key)) roster.set(key, { form, role });
    }
  }
  return roster;
}

/**
 * Every name in the Tribe: households (people, members, secondary people,
 * emergency contacts), Kin in both stores, staff and their profiles. Any read
 * that fails throws: without the whole roster no example can be checked.
 */
async function readTribeRoster(db) {
  const all = async (q) => (await q.get()).docs.map((d) => d.data() || {});
  const people = (rows) => rows.flatMap((r) => namesInRecord(r));
  const [kinfolk, families, members, secondary, clients, flatKin, familyKin, staff, users] = await Promise.all([
    all(db.collection('kinfolk')),
    all(db.collection('families')),
    all(db.collectionGroup('members')),
    all(db.collectionGroup('secondaryKinfolk')),
    all(db.collection('clients')),
    all(db.collection('kin')),
    all(db.collectionGroup('kin')),
    all(db.collection('staff')),
    all(db.collection('users')),
  ]);
  const roster = new Map();
  // Kin first, so a word that is both a Kin and a person reads as [Kin].
  addNames(roster, 'kin', [...flatKin, ...familyKin].flatMap((k) => [k.name, k.nickname, k.callName, k.preferredName].map(textOf)));
  addNames(roster, 'auntie', people([...staff]));
  addNames(roster, 'kinfolk', people([...kinfolk, ...families, ...members, ...secondary, ...clients, ...users]));
  return roster;
}

// ---- 3. words nothing vouches for -----------------------------------------

const WORD = /[\p{L}][\p{L}\p{M}'’‘ʼ]*/gu;

/** True when the text before a word ends a sentence or a line, or is empty. */
function atSentenceStart(before) {
  return /(?:^\s*|[.!?:;]["'”’)\]]*\s+|\n\s*|["“‘(]\s*)$/u.test(before);
}

/** The lowercase words of `texts`: a word written in lowercase is an everyday word. */
function lowercaseWords(texts) {
  const out = new Set();
  for (const text of texts) {
    for (const [w] of tidy(text).matchAll(WORD)) if (w === w.toLowerCase()) out.add(fold(w));
  }
  return out;
}

// ---- the scrub ----------------------------------------------------------------

/**
 * One example with every name and detail replaced, or null when it cannot be
 * made safe. `roster` is the Tribe's names, `rowNames` the names on the row
 * itself, `vocabulary` the everyday words. `found` collects the roster names
 * this example had (for the draft check).
 */
function scrubExample(text, roster, rowNames, vocabulary, found) {
  const local = addNames(new Map(roster), 'kinfolk', rowNames);
  let out = withoutIdentifiers(text);
  const entries = [...local.values()].sort((a, b) => b.form.length - a.form.length);
  const given = new Map();
  const counts = {};
  const label = { kin: 'Kin', kinfolk: 'Kinfolk', auntie: 'Auntie' };
  const placeholderFor = (entry) => {
    const key = fold(entry.form);
    if (!given.has(key)) {
      counts[entry.role] = (counts[entry.role] || 0) + 1;
      const n = counts[entry.role];
      given.set(key, n === 1 || entry.role === 'auntie' ? `[${label[entry.role]}]` : `[${label[entry.role]} ${n}]`);
    }
    return given.get(key);
  };
  if (entries.length) {
    // One pass, longest name first, so placeholders are numbered in the order
    // the names come in the text. Each name is a group of its own.
    const sourceOf = (form) => form.split(' ').map((w) => escapeRegExp(w).replace(APOSTROPHES, "['’‘ʼ]")).join('\\s+');
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${entries.map((e) => `(${sourceOf(e.form)})`).join('|')})((?:['’‘ʼ]s)?|e?s)(?![\\p{L}\\p{N}])`,
      'giu',
    );
    out = out.replace(pattern, (match, ...groups) => {
      const i = groups.findIndex((g, n) => n < entries.length && g !== undefined);
      const entry = entries[i];
      const name = groups[i];
      // A name that is also an everyday word is replaced only with its capital.
      if (vocabulary.has(fold(entry.form)) && name.charAt(0) === name.charAt(0).toLowerCase()) return match;
      found.set(fold(entry.form), entry);
      return placeholderFor(entry) + (groups[entries.length] || '');
    });
  }
  // Capitalised words nothing vouches for. Mid-sentence a capital is taken as
  // a name unless the word is always a word; at the start of a sentence an
  // everyday word keeps its capital.
  out = out.replace(WORD, (word, offset, whole) => {
    if (word.charAt(0) === word.charAt(0).toLowerCase()) return word;
    const key = fold(word).replace(/'s$/u, '');
    if (ALWAYS_WORDS.has(key)) return word;
    // A placeholder is already in brackets.
    if (whole.charAt(offset - 1) === '[') return word;
    if (atSentenceStart(whole.slice(0, offset)) && vocabulary.has(key)) return word;
    return '[Name]';
  });
  out = out.replace(/\[Name\](?:\s+\[Name\])+/gu, '[Name]');
  // Read it again: a Tribe name with its capital, or a contact detail, and it is dropped.
  for (const entry of entries) {
    const capital = entry.form.charAt(0).toUpperCase() + entry.form.slice(1);
    if (new RegExp(`(?<![\\p{L}\\p{N}\\[])${escapeRegExp(capital)}(?![\\p{L}\\p{N}])`, 'u').test(out)) return null;
  }
  if (hasIdentifier(out.replace(/\[(?:email|phone|link|address|number)\]/gu, ''))) return null;
  return out;
}

/**
 * An email body without what it quotes: lines starting with ">" and
 * everything from the line that introduces a quoted message. The quoted part
 * is the household's writing, never the office's.
 */
function withoutQuotedReply(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (/^On\b.*\bwrote:?$/iu.test(t) || /^-{2,}\s*(?:Original|Forwarded) Message/iu.test(t) || /^From:\s/iu.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Text without markup, entities decoded, spaces tidied. */
function plainText(body) {
  return tidy(body)
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\/\s*p\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function shingles(text) {
  const words = fold(text).match(/[\p{L}\p{N}']+/gu) || [];
  const out = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) out.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

// ---- the sources ----------------------------------------------------------

/** Each read is optional: one that fails gives no rows, and the log a count. */
async function optional(label, read) {
  try {
    return await read();
  } catch (_) {
    console.error('generate: own writing source could not be read:', label);
    return [];
  }
}

const rowsOf = async (q) => (await q.get()).docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

async function readCandidates(db) {
  const [threads, texts, emails, tales, broadcasts] = await Promise.all([
    optional('inbox', async () => {
      const convs = await rowsOf(db.collection('conversations').orderBy('lastMessageAtMs', 'desc').limit(30));
      const perThread = await Promise.all(convs.map((c) => optional('inbox thread', async () => {
        const msgs = await rowsOf(db.collection(`conversations/${c.id}/messages`).orderBy('createdAtMs', 'desc').limit(10));
        return msgs
          .filter((m) => m.senderRole === 'auntie')
          .map((m) => ({ kind: 'inbox_reply', text: plainText(m.body), at: Number(m.createdAtMs) || 0, names: [c.kinfolkName] }));
      })));
      return perThread.flat();
    }),
    optional('texts', async () => (await rowsOf(db.collection('sms_messages').orderBy('timestamp', 'desc').limit(200)))
      .filter((m) => m.direction === 'outbound' && m.mirroredFrom === 'sendExternalMessage')
      .map((m) => ({ kind: 'text_reply', text: plainText(m.body), at: Date.parse(m.timestamp) || 0, names: [m.kinfolkName] }))),
    optional('emails', async () => (await rowsOf(db.collection('emails').orderBy('timestamp', 'desc').limit(200)))
      .filter((m) => m.direction === 'outbound')
      .map((m) => ({ kind: 'email', text: withoutQuotedReply(plainText(m.body || m.bodyHtml)), at: Date.parse(m.timestamp) || 0, names: [m.kinfolkName] }))),
    optional('kintales', async () => (await rowsOf(db.collection('kin_care_reports').orderBy('createdAt', 'desc').limit(100)))
      .filter((t) => String(t.status || '').toUpperCase() === 'SENT'
        && !textOf(t.sourceDraftId)
        && !String(t.id).startsWith('legacy_')
        && !String(t.sentVia || '').startsWith('legacy'))),
    optional('broadcasts', async () => (await rowsOf(db.collection('broadcasts').orderBy('sentAtMs', 'desc').limit(30)))
      .map((b) => ({ kind: 'broadcast', text: plainText(b.body), at: Number(b.sentAtMs) || 0, names: [] }))),
  ]);
  const taleRows = tales.map((t) => ({
    kind: 'kintale',
    text: plainText(t.bodyCopy),
    at: Date.parse(t.sentAt) || 0,
    names: [t.kinfolkName, t.authorDisplayName, ...(Array.isArray(t.kinNames) ? t.kinNames : [])],
  }));
  const comments = (await Promise.all(tales.slice(0, 20).map((t) => optional('kintale comments', async () =>
    (await rowsOf(db.collection(`kin_care_reports/${t.id}/comments`).orderBy('createdAtMs', 'desc').limit(5)))
      .filter((c) => c.authorRole === 'admin')
      .map((c) => ({ kind: 'kintale_comment', text: plainText(c.body), at: Number(c.createdAtMs) || 0, names: [t.kinfolkName] })))))).flat();
  return [...threads, ...texts, ...emails, ...taleRows, ...comments, ...broadcasts];
}

/** The generated copy on file, as shingles, so generated text is left out. */
async function generatedShingles(db) {
  const rows = await optional('generated drafts', () => rowsOf(db.collection('generated_drafts').orderBy('createdOn', 'desc').limit(500)));
  const out = new Set();
  for (const r of rows) for (const field of ['generated_copy', 'generatedCopy']) for (const s of shingles(r[field])) out.add(s);
  return out;
}

/** Most recent first, at most MAX_PER_KIND of a kind, kinds taken in turn. */
function pickExamples(candidates) {
  const byKind = new Map();
  for (const c of [...candidates].sort((a, b) => b.at - a.at)) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  const picked = [];
  for (let round = 0; round < MAX_PER_KIND && picked.length < MAX_EXAMPLES; round += 1) {
    for (const list of byKind.values()) {
      if (list[round] && picked.length < MAX_EXAMPLES) picked.push(list[round]);
    }
  }
  return picked;
}

/**
 * The office's own writing as style examples: `{ text, names, vocabulary }`,
 * or null when the Tribe's names could not all be read. `text` is the
 * block for the system prompt ('' when there is nothing to send), `names` the
 * Tribe names the examples had before they were replaced, as sample-name
 * entries for the draft check.
 */
async function buildOwnWriting(db, voiceText) {
  let roster;
  try {
    roster = await readTribeRoster(db);
  } catch (_) {
    console.error('generate: the Tribe names could not all be read, so no own writing is sent');
    return null;
  }
  const [candidates, generated] = await Promise.all([readCandidates(db), generatedShingles(db)]);
  const usable = candidates
    .map((c) => ({ ...c, text: c.text.length > MAX_EXAMPLE_CHARS ? `${c.text.slice(0, MAX_EXAMPLE_CHARS).replace(/\s+\S*$/u, '')} ...` : c.text }))
    .filter((c) => c.text.length >= MIN_EXAMPLE_CHARS)
    .filter((c) => ![...shingles(c.text)].some((s) => generated.has(s)));
  // An everyday word is one the voice files write in lowercase, or two
  // different examples do. A Tribe name is an everyday word only by the voice
  // files: two examples writing a Kin's name in lowercase do not make it one.
  const seen = new Map();
  for (const c of usable) for (const w of lowercaseWords([c.text])) seen.set(w, (seen.get(w) || 0) + 1);
  const vocabulary = lowercaseWords([voiceText || '']);
  for (const [w, n] of seen) if (n >= 2 && !roster.has(w)) vocabulary.add(w);

  const found = new Map();
  const examples = [];
  let dropped = 0;
  for (const c of pickExamples(usable)) {
    const mine = new Map();
    const text = scrubExample(c.text, roster, c.names.map(textOf).filter(Boolean), vocabulary, mine);
    if (text === null) {
      dropped += 1;
      continue;
    }
    for (const [k, v] of mine) found.set(k, v);
    examples.push(`[${KIND_LABEL[c.kind]}]\n${text}`);
  }
  console.log('generate: own writing examples', { candidates: candidates.length, usable: usable.length, sent: examples.length, dropped });
  const names = [...found.values()]
    .filter((e) => e.role !== 'auntie')
    .map((e) => ({ role: e.role, forms: [e.form] }));
  return { text: examples.join('\n\n'), names, vocabulary };
}

let _cache = null;
let _building = null;
const EMPTY = Object.freeze({ text: '', names: [], vocabulary: new Set() });

/**
 * The set for this instance, built at most once in CACHE_MS. One build runs
 * at a time. A request waits for it at most BUILD_BUDGET_MS and then goes
 * without; the build keeps going and fills the cache for the next request.
 */
async function loadOwnWriting(db, voiceText, now = Date.now) {
  if (_cache && now() < _cache.until) return _cache.value;
  if (!_building) {
    _building = buildOwnWriting(db, voiceText)
      .catch(() => null)
      .then((value) => {
        // A set that failed to build is tried again in a minute, not in ten.
        _cache = value === null
          ? { value: EMPTY, until: now() + FAILED_CACHE_MS }
          : { value, until: now() + CACHE_MS };
        _building = null;
        return _cache.value;
      });
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), BUILD_BUDGET_MS);
  });
  try {
    const value = await Promise.race([_building, timeout]);
    if (value === null) {
      console.error('generate: own writing was not ready in time, so none is sent with this request');
      return EMPTY;
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function resetOwnWritingCache() {
  _cache = null;
  _building = null;
}

/**
 * The Tribe names a draft uses with a capital that its request does not
 * carry. A word at the start of a sentence that is also an everyday word does
 * not count ("Will you" is not a name). `names` are the entries from
 * buildOwnWriting; the request's own household names are in `carriedNames`.
 */
function tribeNamesIn(draft, names, vocabulary, requestText, carriedNames) {
  const text = tidy(draft);
  const request = tidy(requestText);
  const carried = new Set(
    (carriedNames || []).filter(Boolean).flatMap((n) => [fold(n), ...tidy(n).split(/\s+/u).map(fold)]),
  );
  const found = [];
  for (const entry of names || []) {
    const form = entry.forms[0];
    if (carried.has(fold(form))) continue;
    const capital = form.charAt(0).toUpperCase() + form.slice(1);
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(capital)}(?![\\p{L}\\p{N}])`, 'gu');
    if (new RegExp(pattern.source, 'u').test(request)) continue;
    const hits = [...text.matchAll(new RegExp(pattern.source, 'gu'))].filter(
      (m) => !(atSentenceStart(text.slice(0, m.index)) && vocabulary && vocabulary.has(fold(form))),
    );
    if (hits.length && !found.includes(capital)) found.push(capital);
  }
  return found;
}

module.exports = {
  PLACEHOLDER_TOKEN,
  MAX_EXAMPLES,
  MAX_EXAMPLE_CHARS,
  withoutIdentifiers,
  hasIdentifier,
  namesInRecord,
  addNames,
  readTribeRoster,
  scrubExample,
  plainText,
  withoutQuotedReply,
  atSentenceStart,
  readCandidates,
  buildOwnWriting,
  loadOwnWriting,
  resetOwnWritingCache,
  tribeNamesIn,
};
