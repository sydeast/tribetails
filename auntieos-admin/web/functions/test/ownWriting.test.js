// #2424 ruling, 2026-11-20: Ask Auntie's voice learns from what the owner and
// the Aunties wrote themselves, as style examples with every name and contact
// detail replaced.
//
// Every name here is invented. Runs with or without the voice corpus.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const own = require('../ownWriting.js');
const gen = require('../generate.js');
const names = require('../sampleNames.js');

// ---- a Firestore double with orderBy, limit and collection groups ----------

function makeDb(data, { failing = [] } = {}) {
  const drafts = [];
  function query(name, rows) {
    const q = {
      _rows: rows,
      where(field, op, value) {
        return query(name, this._rows.filter((r) => (op === 'in' ? value.includes(r[field]) : r[field] === value)));
      },
      orderBy(field, dir) {
        const sorted = [...this._rows].sort((a, b) => {
          const x = a[field];
          const y = b[field];
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        });
        return query(name, sorted);
      },
      limit(n) {
        return query(name, this._rows.slice(0, n));
      },
      async get() {
        if (failing.includes(name)) throw new Error('unavailable');
        return { docs: this._rows.map((r) => ({ id: r.id, exists: true, data: () => r })) };
      },
      doc(id) {
        if (!id) {
          const newId = `draft_${drafts.length + 1}`;
          return { id: newId, async set(obj) { drafts.push({ id: newId, ...obj }); } };
        }
        const found = rows.find((r) => r.id === id);
        return { id, async get() { return { id, exists: !!found, data: () => found }; }, async set(obj) { drafts.push({ id, ...obj }); } };
      },
    };
    return q;
  }
  return {
    _drafts: drafts,
    collection: (name) => query(name, (data[name] || []).slice()),
    collectionGroup: (name) => query(`group:${name}`, Object.entries(data)
      .filter(([path]) => path === name || path.endsWith(`/${name}`))
      .flatMap(([, rows]) => rows)),
  };
}

// Two households and their people, two Aunties, and a Kin whose name is an
// everyday word. "Will" is a household person whose name is also a word.
const KINFOLK = [
  { id: 'h1', firstName: 'Ottoline', lastName: 'Vashti', emergencyContacts: [{ name: 'Grisholm Tarrow', phone: '555-0100' }] },
  { id: 'h2', firstName: 'Leopold', lastName: 'Quince' },
  { id: 'h3', firstName: 'Will', lastName: 'Ambry' },
];
const KIN = [
  { id: 'k1', kinfolkId: 'h1', name: 'Marzipan', species: 'cat' },
  { id: 'k2', kinfolkId: 'h1', name: 'Bramblewick', species: 'dog', status: 'inactive' },
  { id: 'k3', kinfolkId: 'h2', name: 'Sprocket', species: 'dog' },
];
const VOICE = 'we will be there soon. thanks for the note, the walk was lovely and the water is fresh. may i say so.';

function tribeData(extra = {}) {
  return {
    kinfolk: KINFOLK,
    kin: KIN,
    families: [{ id: 'h1', displayName: 'The Vashti Household' }, { id: 'h2' }],
    'families/h1/members': [{ id: 'u1', displayName: 'ottoline@example-household.invalid', firstName: 'Otti' }],
    'families/h1/secondaryKinfolk': [{ id: 'p1', name: 'Perpetua Vashti' }],
    'families/h2/kin': [{ id: 'fk3', name: 'Sprocket', legacyKinId: 'k3' }],
    clients: [],
    staff: [{ id: 's1', displayName: 'Wrenna Ashdown', staffRole: 'auntie' }],
    users: [{ id: 's0', firstName: 'Corvina', lastName: 'Pell' }],
    conversations: [
      { id: 'h1', kinfolkName: 'Ottoline Vashti', lastMessageAtMs: 300 },
      { id: 'h2', kinfolkName: 'Leopold Quince', lastMessageAtMs: 200 },
    ],
    'conversations/h1/messages': [
      { id: 'm1', senderRole: 'auntie', body: '<p>Hi Ottoline, Marzipan was a sweetheart today and Bramblewick\'s bowl is put away. Call me at (555) 010-2233 or write to tess@example-office.invalid.</p>', createdAtMs: 290 },
      { id: 'm2', senderRole: 'kinfolk', body: 'Thank you so much, this is the household writing and it never trains the voice at all.', createdAtMs: 280 },
    ],
    'conversations/h2/messages': [
      { id: 'm3', senderRole: 'auntie', body: 'Leopold, Sprocket and I took the long loop past 1234 Juniper Hollow Lane today, and Dr. Fenwick says hello.', createdAtMs: 190 },
    ],
    sms_messages: [
      { id: 't1', direction: 'outbound', mirroredFrom: 'sendExternalMessage', body: 'On my way now, Will. The gate code 48213 worked fine and Sprocket is fed.', kinfolkName: 'Leopold Quince', timestamp: '2026-11-10T10:00:00.000Z' },
      { id: 't2', direction: 'inbound', body: 'This came in from the household and is long enough to count if it were ours.', timestamp: '2026-11-11T10:00:00.000Z' },
      { id: 't3', direction: 'outbound', body: 'A carrier record with no mirror marker, long enough to count if it were ours.', timestamp: '2026-11-12T10:00:00.000Z' },
    ],
    emails: [
      { id: 'e1', direction: 'outbound', body: 'Will you leave the spare key with Perpetua? See https://example.invalid/portal for the schedule. Thanks!', kinfolkName: 'Ottoline Vashti', timestamp: '2026-11-09T10:00:00.000Z' },
    ],
    kin_care_reports: [
      { id: 'r1', status: 'SENT', bodyCopy: 'Marzipan met me at the door and we sat in the sun for a while before supper.', kinfolkName: 'Ottoline Vashti', authorDisplayName: 'Wrenna Ashdown', sentAt: '2026-11-08T10:00:00.000Z', createdAt: '2026-11-08T09:00:00.000Z' },
      { id: 'r2', status: 'SENT', sourceDraftId: 'd9', bodyCopy: 'Published from a generated draft, so this one is never a style example at all.', sentAt: '2026-11-08T11:00:00.000Z', createdAt: '2026-11-08T10:30:00.000Z' },
      { id: 'legacy_r3', status: 'SENT', sentVia: 'legacy_visit_logs', bodyCopy: 'An old imported visit log that came over in the migration from the old system.', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'r4', status: 'DRAFT', bodyCopy: 'A tale still in the composer is not sent, so it is not one of ours yet either.', createdAt: '2026-11-08T12:00:00.000Z' },
      { id: 'r5', status: 'SENT', bodyCopy: 'Sprocket chased the ball round and round the yard and then flopped down for a nap on the porch.', kinfolkName: 'Leopold Quince', sentAt: '2026-11-07T10:00:00.000Z', createdAt: '2026-11-07T09:00:00.000Z' },
    ],
    'kin_care_reports/r1/comments': [
      { id: 'c1', authorRole: 'admin', body: 'So glad Marzipan had a good day, Ottoline. More sun tomorrow if it holds.', createdAtMs: 50 },
      { id: 'c2', authorRole: 'kinfolk', body: 'A comment the household wrote, which is theirs and never a style example.', createdAtMs: 60 },
    ],
    broadcasts: [
      { id: 'b1', body: 'Hello {{firstName}}, the holiday calendar is open and we would love to see your Kin.', sentAtMs: 400 },
    ],
    generated_drafts: [
      { id: 'd1', generated_copy: 'Sprocket chased the ball round and round the yard and then flopped down for a nap on the porch.', createdOn: '2026-11-07T08:00:00.000Z' },
    ],
    ...extra,
  };
}

const TRIBE_NAMES = ['Ottoline', 'Vashti', 'Grisholm', 'Tarrow', 'Leopold', 'Quince', 'Ambry', 'Marzipan', 'Bramblewick', 'Sprocket', 'Perpetua', 'Otti', 'Wrenna', 'Ashdown', 'Corvina', 'Pell', 'Fenwick', 'Juniper'];

const silence = async (fn) => {
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.map(String).join(' ') + JSON.stringify(a));
  console.error = (...a) => logs.push(a.map(String).join(' ') + JSON.stringify(a));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
};

beforeEach(() => own.resetOwnWritingCache());

describe('contact details in the office\'s own writing', () => {
  it('emails, phones, links, addresses, long numbers and merge tokens become placeholders', () => {
    const out = own.withoutIdentifiers(
      'Write to a@example.invalid or call +1 (555) 010-2233, see www.example.invalid/x and example.com, ' +
      'we are at 1234 Juniper Hollow Lane, code 48213. Hi {{firstName}}.',
    );
    assert.strictEqual(
      out,
      'Write to [email] or call [phone], see [link] and [link], we are at [address], code [number]. Hi [Kinfolk].',
    );
    assert.strictEqual(own.hasIdentifier(out.replace(/\[(?:email|phone|link|address|number)\]/g, '')), false);
  });
  it('keeps clock times, prices and short numbers', () => {
    assert.strictEqual(own.withoutIdentifiers('See you at 10:30, $40 for 2 visits.'), 'See you at 10:30, $40 for 2 visits.');
  });
});

describe('the names on a household record', () => {
  it('finds every name field, nested contacts included, and skips the business name', () => {
    const found = own.namesInRecord({
      firstName: 'Ottoline', lastName: 'Vashti', businessName: 'Not A Name Co', fileName: 'x.jpg',
      emergencyContacts: [{ name: 'Grisholm Tarrow', phone: '555-0100' }], emergencyContactName: 'Perpetua',
    });
    assert.deepStrictEqual(found.sort(), ['Grisholm Tarrow', 'Ottoline', 'Perpetua', 'Vashti']);
  });
});

describe('one example made safe', () => {
  const roster = () => own.addNames(own.addNames(new Map(), 'kin', ['Marzipan', 'Sprocket']), 'kinfolk', ['Ottoline Vashti', 'Will Ambry']);
  const vocab = new Set(['will', 'the', 'thanks', 'you', 'may', 'tell']);
  it('replaces each Tribe name with its numbered placeholder, possessive and plural included', () => {
    const found = new Map();
    const out = own.scrubExample('Ottoline, Marzipan\'s bowl and the two Sprockets are fine. OTTOLINE!', roster(), [], vocab, found);
    assert.strictEqual(out, '[Kinfolk], [Kin]\'s bowl and the two [Kin 2]s are fine. [Kinfolk]!');
    assert.deepStrictEqual([...found.keys()].sort(), ['marzipan', 'ottoline', 'sprocket']);
  });
  it('a name that is also an everyday word is replaced only with its capital', () => {
    const out = own.scrubExample('Will, we will be by at noon.', roster(), [], vocab, new Map());
    assert.strictEqual(out, '[Kinfolk], we will be by at noon.');
  });
  it('a name in lowercase that is not an everyday word is still replaced', () => {
    assert.strictEqual(own.scrubExample('marzipan ate.', roster(), [], vocab, new Map()), '[Kin] ate.');
  });
  it('a capitalised word nothing vouches for becomes [Name], everyday words and brand words stay', () => {
    const out = own.scrubExample('Thanks! Dr. Fenwick Oakhurst says the Kin may go out on Monday.', roster(), [], vocab, new Map());
    assert.strictEqual(out, 'Thanks! Dr. [Name] says the Kin may go out on Monday.');
  });
  it('names on the row itself are replaced even when the roster lacks them', () => {
    const out = own.scrubExample('Tell Hollis I said hi.', roster(), ['Hollis'], vocab, new Map());
    assert.strictEqual(out, 'Tell [Kinfolk] I said hi.');
  });
});

describe('the office\'s own writing, collected', () => {
  const build = async (data = tribeData(), voice = VOICE) => (await silence(() => own.buildOwnWriting(makeDb(data), voice))).value;

  it('takes inbox replies, text replies, emails, sent KinTales, office comments and broadcasts', async () => {
    const result = await build();
    for (const label of ['[Inbox reply]', '[Text reply]', '[Email]', '[KinTale]', '[KinTale comment]', '[Broadcast]']) {
      assert.ok(result.text.includes(label), `${label} is sent`);
    }
  });
  it('carries no Tribe name, no contact detail and no unknown name', async () => {
    const { text } = await build();
    for (const name of TRIBE_NAMES) assert.ok(!text.includes(name), 'a Tribe name is in the examples');
    assert.doesNotMatch(text, /@|555|https?:|example\.invalid|48213|1234|\{\{/);
    assert.match(text, /\[Kinfolk\], \[Kin\] was a sweetheart today/);
    assert.match(text, /Hello \[Kinfolk\], the holiday calendar is open/);
  });
  it('never takes what the household wrote, a carrier record, a draft or an import', async () => {
    const { text } = await build();
    assert.doesNotMatch(text, /household writing|came in from the household|carrier record|generated draft|old imported|still in the composer|household wrote/);
  });
  it('leaves out writing that matches a generated draft', async () => {
    const { text } = await build();
    assert.doesNotMatch(text, /chased the ball/);
    const without = await build(tribeData({ generated_drafts: [] }));
    assert.match(without.text, /chased the ball/);
  });
  it('hands back the Tribe names it replaced, the Aunties left out, for the draft check', async () => {
    const { names: found } = await build();
    const forms = found.map((e) => e.forms[0]);
    assert.ok(forms.includes('Marzipan') && forms.includes('Ottoline') && forms.includes('Sprocket'));
    assert.ok(!forms.includes('Wrenna'));
    assert.ok(found.every((e) => e.role === 'kin' || e.role === 'kinfolk'));
  });
  it('with the Tribe names unreadable, nothing is built', async () => {
    const failed = (await silence(() => own.buildOwnWriting(makeDb(tribeData(), { failing: ['group:members'] }), VOICE))).value;
    assert.strictEqual(failed, null);
  });
  it('one source that cannot be read leaves the others', async () => {
    const { value } = await silence(() => own.buildOwnWriting(makeDb(tribeData(), { failing: ['emails', 'broadcasts'] }), VOICE));
    assert.ok(value.text.includes('[Inbox reply]'));
    assert.ok(!value.text.includes('[Email]') && !value.text.includes('[Broadcast]'));
  });
  it('is held to a count, a length and a share per kind', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `b${i}`, body: `${'The walk was lovely and the water is fresh. '.repeat(40)}${i}`, sentAtMs: 1000 + i,
    }));
    const { text } = await build(tribeData({ broadcasts: many }));
    const examples = text.split('\n\n[').length;
    assert.ok(examples <= own.MAX_EXAMPLES);
    assert.strictEqual((text.match(/\[Broadcast\]/g) || []).length, 3);
    for (const part of text.split(/\n\n(?=\[)/)) assert.ok(part.length <= own.MAX_EXAMPLE_CHARS + 60);
  });
  it('logs counts and never a line or a name', async () => {
    const { logs } = await silence(() => own.buildOwnWriting(makeDb(tribeData()), VOICE));
    const all = logs.join('\n');
    for (const name of TRIBE_NAMES) assert.ok(!all.includes(name));
    assert.doesNotMatch(all, /sweetheart|holiday calendar/);
  });
});

describe('one set per instance', () => {
  it('is built once and reused, and a failed build is tried again after a minute', async () => {
    let clock = 0;
    const now = () => clock;
    let reads = 0;
    const db = makeDb(tribeData(), { failing: ['group:members'] });
    const base = db.collection;
    db.collection = (name) => { if (name === 'kinfolk') reads += 1; return base(name); };
    await silence(() => own.loadOwnWriting(db, VOICE, now));
    await silence(() => own.loadOwnWriting(db, VOICE, now));
    assert.strictEqual(reads, 1);
    clock = 61_000;
    await silence(() => own.loadOwnWriting(db, VOICE, now));
    assert.strictEqual(reads, 2);
    const ok = makeDb(tribeData());
    own.resetOwnWritingCache();
    const first = (await silence(() => own.loadOwnWriting(ok, VOICE, now))).value;
    clock += 9 * 60 * 1000;
    const second = (await silence(() => own.loadOwnWriting(makeDb({}), VOICE, now))).value;
    assert.strictEqual(second, first);
  });
});

// ---- what a generate sends, and what it refuses ---------------------------

function model(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} };
      },
    },
  };
}
const ownSet = async () => (await silence(() => own.buildOwnWriting(makeDb(tribeData()), VOICE))).value;
const generate = (ownWriting, anthropic, body) =>
  silence(() => gen.runGenerate({ db: makeDb(tribeData()), anthropic, model: 'm', voiceSource: VOICE, ownWriting }, body));
const EMAIL_TO_H2 = { communication_type: 'email', kinfolk_id: 'h2', raw_notes: 'say the walk went well' };
const EMAIL_TO_H1 = { communication_type: 'email', kinfolk_id: 'h1', raw_notes: 'say the walk went well' };

describe('a generate with the office\'s own writing', () => {
  it('sends it as a second system block, inside data markers, after the voice', async () => {
    const set = await ownSet();
    const a = model(['The walk went well today.']);
    await generate(set, a, EMAIL_TO_H2);
    const system = a.calls[0].system;
    assert.strictEqual(system.length, 2);
    assert.ok(system[0].text.includes(VOICE));
    assert.ok(system[1].text.startsWith(gen.OWN_WRITING_LABEL));
    assert.match(system[1].text, /<DATA_START>\n\[/);
    assert.strictEqual(system[1].cache_control.type, 'ephemeral');
  });
  it('is the same set whichever household the message is for, and never in the user message', async () => {
    const set = await ownSet();
    const a = model(['The walk went well today.']);
    await generate(set, a, EMAIL_TO_H2);
    await generate(set, a, EMAIL_TO_H1);
    assert.deepStrictEqual(a.calls[0].system, a.calls[1].system);
    assert.doesNotMatch(a.calls[0].messages[0].content, /OWN WRITING|sweetheart/);
  });
  it('with nothing to send the prompt is the voice block alone, as before', async () => {
    const a = model(['The walk went well today.']);
    await generate({ text: '', names: [], vocabulary: new Set() }, a, EMAIL_TO_H2);
    assert.strictEqual(a.calls[0].system.length, 1);
  });
  it('a draft that brings in a name from another household is written again, then thrown away', async () => {
    const set = await ownSet();
    const a = model(['Marzipan says hello.', 'Marzipan says hello again.']);
    const { value: err } = await silence(() =>
      gen.runGenerate({ db: makeDb(tribeData()), anthropic: a, model: 'm', voiceSource: VOICE, ownWriting: set }, EMAIL_TO_H2)
        .then(() => null, (e) => e));
    assert.ok(err instanceof gen.GenerateError);
    assert.strictEqual(err.status, 422);
    assert.strictEqual(err.extra.code, 'draft_names_sample_name');
    assert.doesNotMatch(err.message, /Marzipan/);
    assert.match(a.calls[1].messages[0].content, /CORRECTION: your last draft used the name Marzipan/);
  });
  it('the requested household\'s own names are its to use', async () => {
    const set = await ownSet();
    const a = model(['Sprocket had a lovely walk, Leopold.']);
    const { value } = await generate(set, a, EMAIL_TO_H2);
    assert.strictEqual(value.generated_copy, 'Sprocket had a lovely walk, Leopold.');
    assert.strictEqual(a.calls.length, 1);
  });
  it('an everyday word at the start of a sentence is not a name ("Will you")', async () => {
    const set = await ownSet();
    assert.ok(set.names.some((e) => e.forms[0] === 'Will'), 'the fixture has a household person named Will');
    const a = model(['Will you let me know about Friday? The walk went well.']);
    const { value } = await generate(set, a, EMAIL_TO_H2);
    assert.strictEqual(a.calls.length, 1);
    assert.match(value.generated_copy, /^Will you/);
  });
  it('a draft that writes a new placeholder is written again', async () => {
    const set = await ownSet();
    const a = model(['Hi [Name], the walk went well.', 'The walk went well.']);
    const { value } = await generate(set, a, EMAIL_TO_H2);
    assert.strictEqual(a.calls.length, 2);
    assert.strictEqual(value.generated_copy, 'The walk went well.');
  });
});

describe('the placeholder check', () => {
  it('knows the new placeholders', () => {
    for (const t of ['[Name]', '[email]', '[phone]', '[link]', '[address]', '[number]', '[Name 2]']) {
      assert.strictEqual(names.hasPlaceholder(`Hi ${t}.`), true, t);
    }
    assert.strictEqual(names.hasPlaceholder('the [name of the game] stays'), false);
  });
});

describe('the Tribe-name check on a draft', () => {
  const entries = [{ role: 'kin', forms: ['Marzipan'] }, { role: 'kinfolk', forms: ['Will'] }];
  const vocab = new Set(['will']);
  it('finds a capitalised Tribe name the request does not carry', () => {
    assert.deepStrictEqual(own.tribeNamesIn('Marzipan ate.', entries, vocab, 'notes', []), ['Marzipan']);
  });
  it('lets through one the request carries, or one of the household it is for', () => {
    assert.deepStrictEqual(own.tribeNamesIn('Marzipan ate.', entries, vocab, 'fed Marzipan', []), []);
    assert.deepStrictEqual(own.tribeNamesIn('Marzipan ate.', entries, vocab, 'notes', ['Marzipan']), []);
  });
  it('an everyday-word name counts mid-sentence, not at a sentence start', () => {
    assert.deepStrictEqual(own.tribeNamesIn('Will you call? Thanks.', entries, vocab, 'notes', []), []);
    assert.deepStrictEqual(own.tribeNamesIn('Say hi to Will for me.', entries, vocab, 'notes', []), ['Will']);
  });
});
