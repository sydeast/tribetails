// #2424 ruling, 2026-11-20: Ask Auntie's voice also learns from what the
// owner and the Aunties wrote themselves.
//
// What counts: messages the office typed and sent to a household. Inbox
// replies (`conversations/{kinfolkId}/messages`, sender `auntie`), text replies
// sent from the Inbox (`sms_messages` rows mirrored by `sendExternalMessage`),
// sent KinTales written in the composer (`kin_care_reports`, status SENT, not published from
// a generated draft and not a legacy import), the office's comments on those
// KinTales, and broadcasts (`broadcasts`). A row whose text overlaps a
// generated draft is left out, so generated copy does not train the voice.
// The `emails` collection is not read: nothing in this system writes it, so a
// row there cannot be told apart from automated mail or a household's own
// words quoted in a reply.
//
// What reaches the model: STYLE EXAMPLES ONLY, the same small set for every
// request. Before any example is used:
//
//   1. Contact details and merge tokens become placeholders: [email],
//      [phone], [link], [address], [number].
//   2. Every name the Tribe holds (every household person, every Kin, every
//      staff member, and the names on the row itself) becomes [Kinfolk],
//      [Kin] or [Auntie], numbered within the example, in any case, even
//      where the name is also an everyday word.
//   3. Any other capitalised word that nothing vouches for as an everyday word
//      becomes [Name].
//   4. The example is read again. One that still carries a Tribe name or a
//      contact detail is dropped, never sent.
//   5. An example is a style sample only, so one that holds anything about a
//      particular household is dropped whole, read before and after the
//      replacing: any digit (codes, times, amounts), a money sign, a time of
//      day, and any care detail (medicines and doses, health and behaviour
//      notes, doors, locks, alarms, keys and codes, any part of an address).
//      Windows and every other way into the home, the household being away
//      or coming back ("back Sunday", "while you're away", travel), and a
//      Kin's behaviour in plain words (hiding, barking at people, biting,
//      fear) count too.
//      The lists lean wide: when a word could be either, the example goes. A
//      dropped example is replaced by the next one of its kind.
//
// If the names, or the generated drafts, cannot all be read, no example is
// sent at all: the voice files
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
  kintale: 'KinTale',
  kintale_comment: 'KinTale comment',
  broadcast: 'Broadcast',
};

// Capitalised words that are never a name: the brand words, greetings, titles
// and a few forms that never appear in lowercase.
const NEVER_NAMES = new Set([
  'i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay', 'am', 'pm', 'tv', 'asap', 'lol', 'diy',
  'hi', 'hey', 'hello', 'dear', 'thanks', 'thank', 'xoxo', 'ps',
  'dr', 'mr', 'mrs', 'ms', 'mx',
  'kin', 'kinfolk', 'auntie', 'aunties', 'tribe', 'kintale', 'kintales', 'kincare', 'mytribe', 'tribetails', 'tails',
]);
// The calendar keeps its capital and is not taken for a name, unless someone
// in the Tribe is called by it ("April", "June"): then it is a name like any
// other in the examples. A draft that writes one means the calendar.
const CALENDAR_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);
const ALWAYS_WORDS = new Set([...NEVER_NAMES, ...CALENDAR_WORDS]);

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
      if (NEVER_NAMES.has(key) && role !== 'kin') continue;
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
 * True when the word at `offset` is the word of a placeholder this file
 * writes ("[Kin 2]", "[email]"), and nothing else: "[Marzipan: one pill]" is a
 * name in brackets, not a placeholder.
 */
const PLACEHOLDER_AT = new RegExp(`^${PLACEHOLDER_TOKEN.source}`, 'u');
function insidePlaceholder(whole, offset) {
  return offset > 0 && whole.charAt(offset - 1) === '[' && PLACEHOLDER_AT.test(whole.slice(offset - 1));
}

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
      const whole = groups[groups.length - 1];
      const offset = groups[groups.length - 2];
      if (insidePlaceholder(whole, offset)) return match;
      const i = groups.findIndex((g, n) => n < entries.length && g !== undefined);
      const entry = entries[i];
      const name = groups[i];
      // A Tribe name is replaced in any case, even where it is also an
      // everyday word: "will" for someone called Will becomes a placeholder too.
      // The draft check hears of it only when it was written as a name (with
      // its capital) or is no everyday word, so "a happy day" in one example
      // does not stop "Happy Thanksgiving" in another household's draft.
      const asName = name.charAt(0) !== name.charAt(0).toLowerCase() || !vocabulary.has(fold(entry.form));
      if (asName) found.set(fold(entry.form), entry);
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
    // A placeholder's own word stays as it is.
    if (insidePlaceholder(whole, offset)) return word;
    if (atSentenceStart(whole.slice(0, offset)) && vocabulary.has(key)) return word;
    return '[Name]';
  });
  out = out.replace(/\[Name\](?:\s+\[Name\])+/gu, '[Name]');
  // Read it again: a Tribe name in any case, or a contact detail, and it is dropped.
  for (const entry of entries) {
    const left = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(entry.form)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of out.matchAll(left)) if (!insidePlaceholder(out, m.index)) return null;
  }
  if (hasIdentifier(out.replace(/\[(?:email|phone|link|address|number)\]/gu, ''))) return null;
  return out;
}


// ---- 5. household specifics -------------------------------------------------
//
// Every list is written from general knowledge. A stem matches at the start
// of a word ("lock" finds "locked" and "lockbox", "key" finds "keys" and
// "keychain", never "clock" or "monkey"); a word matches whole ("pin" finds
// "pin", never "spin"). Phrases allow any space between their words. A
// compound that ends in a stem ("padlock", "backdoor") is listed itself.

const SPECIFIC_STEMS = {
  entry: [
    'door', 'lock', 'unlock', 'deadbolt', 'latch', 'alarm', 'keypad', 'keybox', 'keyless', 'keycard',
    'passcode', 'password', 'garage', 'combination', 'combo', 'security', 'camera', 'buzzer', 'intercom',
    'concierge', 'disarm', 'key', 'gate', 'code', 'zip', 'unlatch', 'padlock', 'backdoor', 'frontdoor',
    'sidedoor', 'trapdoor', 'housekey', 'passkey',
    // Any other way into the home: windows, flaps, porches and the like.
    'window', 'skylight', 'porch', 'patio', 'balcony', 'basement', 'cellar', 'attic', 'crawlspace', 'hatch',
    'shutter', 'curtain', 'slider', 'screen', 'lobby', 'doorman', 'doormat', 'fence', 'flap', 'catflap',
    'dogflap', 'neighbo', 'driveway', 'alleyway',
  ],
  medicine: [
    'medic', 'capsule', 'dose', 'dosage', 'dosing', 'prescri', 'pharmac', 'antibiotic', 'steroid',
    'insulin', 'inject', 'syringe', 'ointment', 'inhaler', 'supplement', 'vitamin', 'probiotic', 'deworm',
    'heartworm', 'flea', 'sedat', 'anesthe', 'anaesthe', 'vaccin', 'booster', 'milligram', 'chewable',
    // Common pet medicines and preventives, generic and brand.
    'prednis', 'gabapentin', 'apoquel', 'carprofen', 'rimadyl', 'trazodone', 'metacam', 'meloxicam',
    'fluoxetine', 'prozac', 'cerenia', 'galliprant', 'levothyrox', 'methimazole', 'phenobarb', 'vetmedin',
    'pimobendan', 'enalapril', 'benazepril', 'furosemide', 'lasix', 'benadryl', 'diphenhydramine',
    'tramadol', 'clavamox', 'amoxi', 'metronidazole', 'flagyl', 'cytopoint', 'librela', 'solensia',
    'heartgard', 'nexgard', 'simparica', 'bravecto', 'seresto', 'frontline', 'trifexis', 'credelio',
    'proin', 'denamarin', 'cosequin', 'dasuquin', 'codeine', 'zyrtec', 'claritin', 'pepcid', 'famotidine',
    'omeprazole', 'sucralfate', 'clomipramine', 'clomicalm', 'alprazolam', 'xanax', 'acepromazine',
    'buprenorphine', 'onsior', 'adequan', 'glucosamine', 'bromide', 'keppra', 'levetiracetam',
    'zonisamide', 'fortiflora', 'panacur', 'drontal', 'cbd',
  ],
  health: [
    'allerg', 'seizure', 'epilep', 'diabet', 'arthrit', 'surger', 'surgic', 'incision', 'sutur', 'stitch',
    'vomit', 'diarrh', 'stool', 'urin', 'blood', 'bleed', 'limp', 'lump', 'tumor', 'tumour', 'cancer',
    'kidney', 'renal', 'liver', 'thyroid', 'murmur', 'infect', 'hotspot', 'wound', 'injur', 'sick',
    'symptom', 'diagnos', 'veterin', 'doctor', 'clinic', 'hospital', 'emergenc', 'blind', 'deaf', 'chronic',
    'cough', 'sneez', 'wheez', 'letharg', 'fever', 'dehydrat', 'constipat', 'parvo', 'ultrasound',
    'biopsy', 'geriatric', 'dementia', 'hospice', 'euthan', 'spay', 'neuter', 'mobility', 'incontinen',
  ],
  behaviour: [
    'aggress', 'growl', 'snarl', 'reactiv', 'anxi', 'separation', 'fearful', 'phobi', 'escap', 'muzzle',
    'guarding', 'accident', 'trigger', 'destruct', 'fight', 'attack', 'territor', 'hiss',
    // The same in plain words: hiding, barking at people, fear.
    'bark', 'howl', 'whin', 'yelp', 'yowl', 'cower', 'fear', 'afraid', 'frighten', 'scare', 'timid',
    'nervous', 'skittish', 'jumpy', 'spook', 'startl', 'panic', 'stress', 'trembl', 'hate',
    'claw', 'swat', 'sneak', 'bully', 'grump', 'cranky', 'moody', 'feisty', 'stubborn',
    'protective', 'possessive', 'jealous', 'dominan', 'wary', 'cautious', 'stranger', 'spray',
    'standoffish', 'clingy', 'aloof', 'grumbl', 'shred',
  ],
  away: [
    'travel', 'vacation', 'trip', 'flight', 'airport', 'cruise', 'hotel', 'honeymoon', 'getaway', 'abroad',
    'overseas', 'roadtrip', 'staycation', 'itinerar', 'jetlag', 'layover', 'return', 'homecoming',
    'housesit', 'wedding', 'conference', 'reunion', 'funeral',
  ],
  address: ['address', 'apartment', 'subdivision', 'intersection', 'boulevard', 'parkway', 'highway'],
  diet: ['kibble', 'dietar'],
};
const SPECIFIC_WORDS = {
  entry: [
    'pin', 'pins', 'fob', 'fobs', 'armed', 'arming', 'spare', 'entry', 'entrance', 'mailbox', 'wifi', 'wi-fi',
    'hide-a-key', 'deck', 'blinds', 'let (?:myself|yourself|ourselves|me|us|them) (?:in|out)', 'way in',
    'in through', 'through the (?:back|front|side|garage|yard)',
    'under the (?:mat|rug|pot|planter|rock|flowerpot)', 'lights? (?:on|off)', 'alley',
    'side (?:way|yard|entrance)', 'back way', '(?:back|front) entrance',
  ],
  medicine: [
    'med', 'meds', 'pill', 'pills', 'pilled', 'pilling', 'tablet', 'tablets', 'mg', 'mcg', 'ml', 'cc',
    'tick', 'ticks', 'eye drops?', 'ear drops?', 'twice a day', 'once a day', 'twice daily',
    'three times a day', 'every (?:\\p{L}+ )?hours',
  ],
  health: [
    'vet', 'vets', 'dr', 'ill', 'illness', 'pain', 'pains', 'painful', 'rash', 'rashes', 'hot spots?', 'cone',
    'e-collar', 'x-rays?', 'xrays?', 'uti', 'swollen', 'swelling', 'condition', 'conditions',
    'threw up', 'throw up', 'throws up', 'throwing up', 'passed away', 'put down',
  ],
  behaviour: [
    'bite', 'bites', 'biting', 'bitten', 'nip', 'nips', 'nipped', 'nipping', 'snapped', 'snapping',
    'lunge', 'lunges', 'lunged', 'lunging', 'scared', 'bolt', 'bolts', 'bolted', 'bolting', 'marking',
    'darts? out', 'darted out', 'ran off', 'runs? off', 'resource guard', 'do not let', "don't let",
    'never let', 'keep (?:\\p{L}+ )?away',
    'hide', 'hides', 'hid', 'hiding', 'hidden', 'shy', 'shyness', 'terrified', 'terrifies', 'terrifying',
    'scary', 'shaking', 'shakes', 'shook', 'pacing', 'mouthy', 'picky', 'pulls', 'pulling',
    'jump(?:s|ed|ing)? (?:on|up)', 'snaps? at', 'chewed', 'chew(?:s|ing)? (?:up|the|on the)',
    'scratch(?:es|ed|ing)? (?:at|the|up)', 'come out from', 'ran (?:up|down)stairs', 'not a fan of',
    "(?:would not|wouldn't|won't|will not|didn't|did not) come out", 'warm(?:s|ed)? up to', 'get(?:s)? along', 'got along',
    "(?:does not|doesn't|did not|didn't|won't|will not|can't|cannot) (?:like|stand|tolerate|handle|trust)",
    'other (?:dogs?|cats?|animals?|pets?|people|kin)', 'got out', 'gets out', 'slipped out',
    'bit (?:me|my|him|her|them|us|someone|the)', '(?:tore|tear|tears|tearing|torn) (?:up|apart|into)', 'snuck', 'not good with', 'closet', 'crate', 'crated',
    "(?:want|wants|wanted|would not|wouldn't) to come out", 'peed', 'pooped',
    'ran away', 'runs? away', 'running away',
    'under the (?:bed|couch|sofa|porch|house|deck|stairs|dresser|table|desk|chair|bathtub)', 'behind the (?:couch|sofa|bed|dryer|washer|fridge)',
  ],
  away: [
    // "while you're away", but not "right away" or "put away".
    '(?<!(?:right|straight|put|far|tucked|packed|stored|cleared|washed|tidied|faded|gave|give|given|squared|wipe|wiped|wiping|swept|brushed|scrubbed|it) )away',
    "(?:you're|you are|you were|you'll be|they're|they are|they'll be|y'all are|we're) (?:gone|out|back|home)",
    'out of (?:town|state|the country)', 'back home', 'welcome (?:back|home)', 'home safe', 'home safely',
    'safe (?:trip|flight|journey|drive)', 'get(?:s|ting)? back', 'got back', '(?:be|are|is|be getting) back',
    'back (?:on |by |next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|weekend|week)',
    "see you (?:when|once) you(?:'re| are| get)", 'see you (?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)',
    'landed', 'fly', 'flying', 'come home', 'comes home', 'coming home', 'get home', 'gets home', 'getting home',
    'come back', 'comes back', 'coming back', 'home soon', 'heading out', 'been gone',
    "while (?:you|you're|y'all)", 'enjoy your (?:time|stay|visit|break)', 'your stay', 'time off',
    'lake house', 'beach house', 'cabin', 'drive (?:up|down|back|home)',
    '(?:before|after|once|until|till|when) you (?:leave|left|go|head|fly|drive)',
    'on holiday', 'your holidays?', 'holidaying', 'house sit(?:ting)?', 'empty house',
    "(?:nobody|no one|no-one)(?:'s| is)? home", 'misse[sd] (?:you|y\'all|everyone|them|her|his|their)',
    'mail', 'package', 'packages', 'parcel', 'parcels', 'newspapers?', 'bins', 'trash', 'garbage', 'recycling',
  ],
  address: [
    'street', 'streets', 'st', 'avenue', 'ave', 'blvd', 'pkwy', 'hwy', 'rd', 'ln', 'ct', 'cir', 'trl', 'apt',
    'unit', 'suite', 'condo', 'cul-de-sac', 'cross street', 'corner of',
  ],
  time: ['noon', 'midnight', "o'clock", 'a\\.m\\.?', 'p\\.m\\.?'],
  money: [
    'dollar', 'dollars', 'bucks', 'cents', 'invoice', 'invoices', 'invoiced', 'payment', 'payments', 'pay', 'pays',
    'paid', 'paying', 'balance', 'balances', 'owe', 'owes', 'owed', 'owing', 'overdue', 'deposit', 'deposits',
    'refund', 'refunds', 'refunded', 'credit', 'credits', 'credited', 'tip', 'tips', 'tipped', 'tipping', 'fee',
    'fees', 'charge', 'charges', 'charged', 'price', 'prices', 'priced', 'pricing', 'cost', 'costs', 'rate',
    'rates', 'bill', 'bills', 'billed', 'billing', 'receipt', 'receipts', 'quote', 'quotes', 'quoted',
    'discount', 'discounts', 'cash', 'venmo', 'paypal', 'zelle', 'cashapp', 'cash app', 'klarna', 'affirm',
  ],
  diet: [
    'diet', 'diets', 'scoop', 'scoops', 'scooped', 'portion', 'portions', 'cup', 'cups', 'cans? of',
    'half a can', 'tablespoons?', 'teaspoons?', 'tbsp', 'tsp', 'wet food', 'dry food', 'raw food',
    'grain-free', 'grain free',
  ],
};
// Street words that are everyday words too: they count only after a
// capitalised word ("Quarry Road"), or a placeholder ("[Name] Lane").
const STREET_WORDS = new Set([
  'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'court', 'ct', 'way', 'place', 'pl', 'circle', 'cir', 'trail',
  'trl', 'terrace', 'ter', 'loop', 'run', 'row', 'crescent', 'close', 'square', 'sq', 'pike', 'path',
  'alley', 'bend', 'ridge', 'hollow', 'heights', 'park',
]);
// A capitalised word before a street word that is not a street's name ("The
// road was quiet", "By the way").
const NOT_STREET_NAMES = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'your', 'my', 'his', 'her', 'their', 'its',
  'one', 'any', 'every', 'each', 'no', 'some', 'which', 'what', 'all', 'same', 'other', 'either', 'neither',
  'long', 'short', 'quick', 'little', 'big', 'nice', 'lovely', 'great', 'good', 'happy', 'fun', 'half',
  'down', 'up', 'along', 'across', 'on', 'at', 'by', 'near', 'past', 'around', 'round', 'over', 'from',
  'to', 'in', 'into', 'off', 'back', 'front', 'home', 'i', 'we', 'you', 'they', 'kin', 'auntie',
]);

const phraseSource = (p) => p.replace(/ /g, '\\s+');
const SPECIFIC_PATTERNS = Object.fromEntries(
  [...new Set([...Object.keys(SPECIFIC_STEMS), ...Object.keys(SPECIFIC_WORDS)])].map((kind) => {
    const parts = [];
    if (SPECIFIC_STEMS[kind]) parts.push(`(?:${SPECIFIC_STEMS[kind].map(phraseSource).join('|')})[\\p{L}\\p{M}]*`);
    if (SPECIFIC_WORDS[kind]) parts.push(`(?:${SPECIFIC_WORDS[kind].map(phraseSource).join('|')})`);
    return [kind, new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'u')];
  }),
);
const DIGIT = /\p{N}/u;
const MONEY_SIGN = /[$€£¢¥]/u;
const NUMBER_TIME = /(?<![\p{L}\p{N}])(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:am|pm)(?![\p{L}\p{N}])/u;
// A clock time in words: "around six", "at seven thirty", "half past four".
const HOUR_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const SPOKEN_TIME = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:at|around|by|before|after|until|till|til) ${HOUR_WORD}` +
  `|${HOUR_WORD}[ -](?:fifteen|thirty|forty[ -]five)|half past|quarter (?:past|to|after|till?))(?![\\p{L}\\p{N}])`,
  'u',
);
const DETAIL_PLACEHOLDER = /\[(?:phone|address|number)\]/u;
// A capitalised word and the word after it, overlapping, so "Old Quarry Road"
// is read as "Old Quarry" and "Quarry Road".
const STREET_PAIR = /(?<![\p{L}\p{N}])([\p{Lu}][\p{L}\p{M}'’-]*)\s+(?=([\p{L}]+))/gu;
const OWN_PLACEHOLDERS = new RegExp(PLACEHOLDER_TOKEN.source, 'gu');
// The household somewhere else, by a place's name: "while you were in Denver",
// "back from [Name]", "Enjoy [Name]". Places cannot be listed, so the word
// before them is what counts. After "in", "back from", "off to" and other
// travel words the place is any capitalised word that is not a possessive
// ("in Biscuit's bed"), a brand word or the calendar. After "enjoy" and
// "visiting", a Kin is as likely as a place ("Loved visiting Biscuit"), so
// only an unknown name counts there: a Tribe name has become a Tribe
// placeholder by the time the example is read again, a city has become [Name].
const initialEither = (w) => `[${w.charAt(0).toUpperCase()}${w.charAt(0)}]${phraseSource(w.slice(1))}`;
const TRAVEL_BEFORE = [
  'in', 'back from', 'home from', 'off to', 'fly to', 'flying to', 'flew to', 'headed to', 'heading to',
  'trip to', 'drive to', 'driving to',
].map(initialEither);
const NAME_BEFORE = ['enjoy', 'enjoys', 'enjoying', 'enjoyed', 'visit', 'visiting', 'welcome to'].map(initialEither);
const TRAVEL_PLACE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${TRAVEL_BEFORE.join('|')})\\s+(\\[Name\\]|\\p{Lu}[\\p{L}\\p{M}]*)(?![\\p{L}\\p{M}'’-])`,
  'gu',
);
const NAMED_PLACE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NAME_BEFORE.join('|')})\\s+\\[Name\\]`, 'u');
function namesAPlace(source) {
  if (NAMED_PLACE.test(source)) return true;
  for (const [, word] of source.matchAll(TRAVEL_PLACE)) {
    if (word === '[Name]') return true;
    const key = fold(word);
    if (!ALWAYS_WORDS.has(key) && !NOT_STREET_NAMES.has(key)) return true;
  }
  return false;
}

/**
 * The kind of household specific `text` holds ('digit', 'entry', 'medicine',
 * 'health', 'behaviour', 'away', 'address', 'time', 'money', 'diet'), or null when it holds
 * none. A name placeholder stands for a capitalised word ("[Kin 2]" holds no
 * digit); one that stands for a phone, an address or a number is a specific,
 * since something particular was there.
 */
function householdSpecific(text) {
  const source = tidy(text);
  if (DETAIL_PLACEHOLDER.test(source)) return 'address';
  const bare = source.replace(OWN_PLACEHOLDERS, (m) => (/^\[(?:Kin|Kinfolk|Auntie|Name)\b/u.test(m) ? 'Xname' : 'xdetail'));
  if (DIGIT.test(bare)) return 'digit';
  if (MONEY_SIGN.test(bare)) return 'money';
  const folded = fold(bare).replace(/\s+/gu, ' ');
  if (NUMBER_TIME.test(folded) || SPOKEN_TIME.test(folded)) return 'time';
  for (const [kind, pattern] of Object.entries(SPECIFIC_PATTERNS)) if (pattern.test(folded)) return kind;
  if (namesAPlace(source.replace(/\s+/gu, ' '))) return 'away';
  for (const [, first, second] of bare.matchAll(STREET_PAIR)) {
    if (STREET_WORDS.has(fold(second)) && !NOT_STREET_NAMES.has(fold(first))) return 'address';
  }
  return null;
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
  const [threads, texts, tales, broadcasts] = await Promise.all([
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
  return [...threads, ...texts, ...taleRows, ...comments, ...broadcasts];
}

/**
 * The generated copy on file, as shingles, so generated text is left out. Not
 * optional: without it generated copy could pass for the office's own, so a
 * read that fails throws.
 */
async function generatedShingles(db) {
  const rows = await rowsOf(db.collection('generated_drafts').orderBy('createdOn', 'desc').limit(500));
  const out = new Set();
  for (const r of rows) for (const field of ['generated_copy', 'generatedCopy']) for (const s of shingles(r[field])) out.add(s);
  return out;
}

/**
 * Most recent first, at most MAX_PER_KIND of a kind, kinds taken in turn.
 * `prepare` makes one ready to send, or gives null for one that cannot be;
 * that one is passed over and the next of its kind is tried. At most
 * MAX_PREPARED are tried in all.
 */
const MAX_PREPARED = MAX_EXAMPLES * 4;
function pickExamples(candidates, prepare = (c) => c) {
  const byKind = new Map();
  for (const c of [...candidates].sort((a, b) => b.at - a.at)) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  const lists = [...byKind.values()].map((list) => ({ list, next: 0, taken: 0 }));
  const picked = [];
  let tried = 0;
  for (let round = 0; round < MAX_PER_KIND && picked.length < MAX_EXAMPLES; round += 1) {
    for (const kind of lists) {
      if (picked.length >= MAX_EXAMPLES || kind.taken > round) continue;
      while (kind.next < kind.list.length && tried < MAX_PREPARED) {
        tried += 1;
        const ready = prepare(kind.list[kind.next]);
        kind.next += 1;
        if (ready !== null) {
          picked.push(ready);
          kind.taken += 1;
          break;
        }
      }
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
  let candidates;
  let generated;
  try {
    [candidates, generated] = await Promise.all([readCandidates(db), generatedShingles(db)]);
  } catch (_) {
    console.error('generate: the generated drafts could not be read, so no own writing is sent');
    return null;
  }
  const usable = candidates
    .map((c) => ({ ...c, text: c.text.length > MAX_EXAMPLE_CHARS ? `${c.text.slice(0, MAX_EXAMPLE_CHARS).replace(/\s+\S*$/u, '')} ...` : c.text }))
    .filter((c) => c.text.length >= MIN_EXAMPLE_CHARS)
    .filter((c) => ![...shingles(c.text)].some((s) => generated.has(s)));
  // An everyday word is one the voice files write in lowercase. The examples
  // never teach one: a name typed in lowercase twice is still a name.
  const vocabulary = lowercaseWords([voiceText || '']);

  // An example is a style sample only: one that holds anything particular to
  // a household is left out whole, read before and after the replacing.
  let specifics = 0;
  const general = usable.filter((c) => {
    if (householdSpecific(c.text) === null) return true;
    specifics += 1;
    return false;
  });

  const found = new Map();
  let dropped = 0;
  const examples = pickExamples(general, (c) => {
    const mine = new Map();
    const text = scrubExample(c.text, roster, c.names.map(textOf).filter(Boolean), vocabulary, mine);
    if (text === null || householdSpecific(text) !== null) {
      dropped += 1;
      return null;
    }
    for (const [k, v] of mine) found.set(k, v);
    return `[${KIND_LABEL[c.kind]}]\n${text}`;
  });
  console.log('generate: own writing examples', {
    candidates: candidates.length, usable: usable.length, specifics, sent: examples.length, dropped,
  });
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
    if (carried.has(fold(form)) || CALENDAR_WORDS.has(fold(form))) continue;
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
  householdSpecific,
  pickExamples,
  plainText,
  atSentenceStart,
  readCandidates,
  buildOwnWriting,
  loadOwnWriting,
  resetOwnWritingCache,
  tribeNamesIn,
};
