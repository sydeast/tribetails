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
    'families/h1/members': [{ id: 'u1', displayName: 'catch@hanasamku.com', firstName: 'Otti' }],
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
      { id: 'm1', senderRole: 'auntie', body: '<p>Hi Ottoline, Marzipan was a sweetheart today and Bramblewick\'s bowl is put away. Call me at (555) 010-2233 or write to e2e-admin@tribetails.com.</p>', createdAtMs: 290 },
      { id: 'm4', senderRole: 'auntie', body: 'Hi Ottoline, Marzipan was a sweetheart today and we had a long cuddle on the couch. Talk soon!', createdAtMs: 285 },
      { id: 'm2', senderRole: 'kinfolk', body: 'Thank you so much, this is the household writing and it never trains the voice at all.', createdAtMs: 280 },
    ],
    'conversations/h2/messages': [
      { id: 'm3', senderRole: 'auntie', body: 'Leopold, Sprocket and I took the long loop past 1234 Juniper Hollow Lane today, and Dr. Fenwick says hello.', createdAtMs: 190 },
    ],
    sms_messages: [
      { id: 't1', direction: 'outbound', mirroredFrom: 'sendExternalMessage', body: 'On my way now, Will. The gate code 48213 worked fine and Sprocket is fed.', kinfolkName: 'Leopold Quince', timestamp: '2026-11-10T10:00:00.000Z' },
      { id: 't4', direction: 'outbound', mirroredFrom: 'sendExternalMessage', body: 'On my way now, Will. Sprocket is fed and the water bowl is full again.', kinfolkName: 'Leopold Quince', timestamp: '2026-11-10T09:00:00.000Z' },
      { id: 't2', direction: 'inbound', body: 'This came in from the household and is long enough to count if it were ours.', timestamp: '2026-11-11T10:00:00.000Z' },
      { id: 't3', direction: 'outbound', body: 'A carrier record with no mirror marker, long enough to count if it were ours.', timestamp: '2026-11-12T10:00:00.000Z' },
    ],
    emails: [
      { id: 'e1', direction: 'outbound', body: 'Will you leave the spare key with Perpetua? See https://hanasamku.com/portal for the schedule. Thanks!', kinfolkName: 'Ottoline Vashti', timestamp: '2026-11-09T10:00:00.000Z' },
    ],
    kin_care_reports: [
      { id: 'r1', status: 'SENT', bodyCopy: 'Marzipan met me at the door and we sat in the sun for a while before supper.', kinfolkName: 'Ottoline Vashti', authorDisplayName: 'Wrenna Ashdown', sentAt: '2026-11-08T10:00:00.000Z', createdAt: '2026-11-08T09:00:00.000Z' },
      { id: 'r6', status: 'SENT', bodyCopy: 'Marzipan sat with me in the sun for a while before supper, purring the whole time.', kinfolkName: 'Ottoline Vashti', authorDisplayName: 'Wrenna Ashdown', sentAt: '2026-11-08T08:00:00.000Z', createdAt: '2026-11-08T07:00:00.000Z' },
      { id: 'r2', status: 'SENT', sourceDraftId: 'd9', bodyCopy: 'Published from a generated draft, so this one is never a style example at all.', sentAt: '2026-11-08T11:00:00.000Z', createdAt: '2026-11-08T10:30:00.000Z' },
      { id: 'legacy_r3', status: 'SENT', sentVia: 'legacy_visit_logs', bodyCopy: 'An old imported visit log that came over in the migration from the old system.', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'r4', status: 'DRAFT', bodyCopy: 'A tale still in the composer is not sent, so it is not one of ours yet either.', createdAt: '2026-11-08T12:00:00.000Z' },
      { id: 'r5', status: 'SENT', bodyCopy: 'Sprocket chased the ball round and round the yard and then flopped down for a nap in the shade.', kinfolkName: 'Leopold Quince', sentAt: '2026-11-07T10:00:00.000Z', createdAt: '2026-11-07T09:00:00.000Z' },
    ],
    'kin_care_reports/r1/comments': [
      { id: 'c1', authorRole: 'admin', body: 'So glad Marzipan had a good day, Ottoline. More sun tomorrow if it holds.', createdAtMs: 50 },
      { id: 'c2', authorRole: 'kinfolk', body: 'A comment the household wrote, which is theirs and never a style example.', createdAtMs: 60 },
    ],
    broadcasts: [
      { id: 'b1', body: 'Hello {{firstName}}, the holiday calendar is open and we would love to see your Kin.', sentAtMs: 400 },
    ],
    generated_drafts: [
      { id: 'd1', generated_copy: 'Sprocket chased the ball round and round the yard and then flopped down for a nap in the shade.', createdOn: '2026-11-07T08:00:00.000Z' },
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
      'Write to pawsome@hanasamku.com or call +1 (555) 010-2233, see www.hanasamku.com/x and tribetails.com, ' +
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
  it('a name that is also an everyday word is replaced in any case', () => {
    const out = own.scrubExample('Will, we will be by at noon.', roster(), [], vocab, new Map());
    assert.strictEqual(out, '[Kinfolk], we [Kinfolk] be by at noon.');
  });
  it('a name inside brackets is still a name; only a placeholder of our own is left alone', () => {
    const out = own.scrubExample('[Marzipan: one pill] and [Fenwick called], [email] and [Kin 2].', roster(), [], vocab, new Map());
    assert.strictEqual(out, '[[Kin]: one pill] and [[Name] called], [email] and [Kin 2].');
  });
  it('an everyday-word name in lowercase is replaced but not handed to the draft check', () => {
    const found = new Map();
    const withHappy = own.addNames(roster(), 'kin', ['Happy']);
    const vocabHappy = new Set([...vocab, 'happy', 'we', 'say']);
    assert.strictEqual(own.scrubExample('We had a happy walk.', withHappy, [], vocabHappy, found), 'We had a [Kin] walk.');
    assert.ok(!found.has('happy'));
    own.scrubExample('Say hi to Happy for me.', withHappy, [], vocabHappy, found);
    assert.ok(found.has('happy'));
  });
  it('a household person named for a month is replaced, and the month alone keeps its capital', () => {
    const withApril = own.addNames(roster(), 'kinfolk', ['April Dunmore']);
    assert.ok(withApril.has('april'));
    assert.strictEqual(
      own.scrubExample('April, see you Monday in March.', withApril, [], vocab, new Map()),
      '[Kinfolk], see you Monday in March.',
    );
    assert.strictEqual(own.scrubExample('See you Monday in April.', roster(), [], new Set([...vocab, 'see']), new Map()), 'See you Monday in April.');
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
  it('mid-sentence, a capital is a name even when the word is an everyday one', () => {
    // "Rose" is not in the roster; the voice files write "rose" in lowercase.
    const out = own.scrubExample('The sun rose early. Say hi to Rose for me.', roster(), [], new Set([...vocab, 'rose', 'say']), new Map());
    assert.strictEqual(out, 'The sun rose early. Say hi to [Name] for me.');
  });
  it('at the start of a line an everyday word keeps its capital', () => {
    const out = own.scrubExample('Hi [Kinfolk],\n\nThe walk was lovely.', roster(), [], vocab, new Map());
    assert.strictEqual(out, 'Hi [Kinfolk],\n\nThe walk was lovely.');
  });
});

describe('the roster', () => {
  it('a field holding two people gives each of them, and an email is no name', () => {
    const roster = own.addNames(new Map(), 'kinfolk', ['Ottoline & Leopold Quince', 'Perpetua and Grisholm', 'Corvina/Pell', 'catch@hanasamku.com']);
    for (const key of ['ottoline', 'leopold', 'quince', 'perpetua', 'grisholm', 'corvina', 'pell']) assert.ok(roster.has(key), key);
    assert.ok(![...roster.keys()].some((k) => k.includes('catch') || k.includes('hanasamku')));
  });
  it('words a household name is built with are not names of their own', () => {
    const roster = own.addNames(new Map(), 'kinfolk', ['The Vashti Household']);
    assert.ok(roster.has('vashti') && roster.has('the vashti household'));
    assert.ok(!roster.has('the') && !roster.has('household'));
  });
});

describe('household specifics: an example is a style sample only', () => {
  const MUST_DROP = {
    digit: [
      'See you at 10:30 tomorrow, the walk went well.',
      'That comes to $40 for the two visits this week.',
      'Back on the 3rd, we will see everyone then.',
    ],
    time: [
      'I will be by around noon to check on everyone.',
      'See you at seven o\'clock, all is well here.',
      'Dropping in by six pm, all is well here.',
      'See you after 5 p.m. tomorrow.',
      'I will be there around six tonight.',
      'See you at seven thirty, all is well here.',
      'Back by half past four with everyone fed.',
      'Dinner went down at quarter to six.',
    ],
    money: [
      'That comes to forty dollars for the week.',
      'It was twenty bucks at the shop.',
      'Your invoice is ready whenever you are.',
      'Thanks for the payment, your balance is all clear.',
      'Thanks, I got your Venmo this morning.',
      'I added the tip to your account credit.',
    ],
    diet: [
      'Half a can at breakfast, as always.',
      'Two scoops in the bowl and fresh water.',
      'She is on a raw diet now, so no kibble.',
      'He only gets wet food in the evening.',
    ],
    entry: [
      'The gate sticks a little, so give it a shove.',
      'I left the spare key under the mat for you.',
      'The back door was open when I arrived.',
      'I set the alarm and locked up behind me.',
      'The lockbox is on the side of the house.',
      'The code changed, so I used the new one.',
      'Your keychain is on the hook by the fridge.',
      'I disarmed it on my way in and armed it again when I left.',
      'The combo worked first try, all good.',
      'The gatepost is a little wobbly again.',
      'The back window was unlatched, so I closed it.',
      'The backdoor sticks in the rain.',
      'The padlock on the shed is new.',
      'The housekey is with the neighbour now.',
      'The passkey worked fine today.',
      'I closed the back window before I left.',
      'The kitchen window was open a crack, so I shut it.',
      'Everyone came in through the dog flap after the rain.',
      'I left everything on the porch for you.',
      'The slider in the den sticks a little.',
      'Your neighbour has the other set now.',
      'I let myself in through the side and all was quiet.',
      'I came in through the back and all was quiet.',
    ],
    away: [
      'Hope you have a wonderful trip, we will take good care of everyone while you are away.',
      'See you when you are back Sunday, all is well here.',
      'Back Sunday? We will be ready for you.',
      'Enjoy your vacation, everyone is settled.',
      'Safe travels home, everyone is happy.',
      'Hope the flight was smooth and you landed safely.',
      'Welcome home, everyone was so good while you were gone.',
      'She misses you but is eating well.',
      'I brought the mail and the packages inside.',
      'The bins went out and the house is quiet.',
      'Let me know when you get back and I will stop by.',
      'Enjoy your holiday, we have everything here.',
      'See you when you come home, all is well.',
      'We will be here until you come back.',
      'Everyone has been good since you have been gone.',
      'Before you leave, let me know where the leash is.',
      'See you Sunday, have fun!',
      'Have a great week away, everyone is fine.',
    ],
    medicine: [
      'She took half a pill of gabapentin with her supper.',
      'Gave him the Apoquel with breakfast, no fuss at all.',
      'Her medication is in the cupboard above the sink.',
      'Ear drops went in twice a day as you asked.',
      'He gets one tablet every eight hours.',
      'The flea treatment is due again soon.',
    ],
    health: [
      'She threw up a little after dinner but seemed fine.',
      'The stitches look clean and dry today.',
      'He was limping a little on the back leg.',
      'The vet said to keep an eye on her appetite.',
      'His allergies are better this week.',
      'She wore the cone all afternoon like a champ.',
    ],
    behaviour: [
      'He growled at the mail carrier again.',
      'Keep her away from the other cat, she bites.',
      'She tried to escape when the delivery came.',
      'He gets anxious when the thunder starts.',
      'Do not let him off the leash near the pond.',
      'There was an accident on the rug, all cleaned up.',
      'She spent most of the visit hiding under the bed.',
      'He hid behind the couch until I sat down.',
      'He barks at people walking past the house.',
      'She was a little shy at first but warmed up to me.',
      'He is scared of the vacuum, so I left it.',
      'She gets nervous around strangers.',
      'He does not like other dogs on the trail.',
      'She jumps on people when they come in.',
      'He was shaking during the storm, so we cuddled.',
      'She chewed the corner of the rug again.',
      'She would not come out from the closet.',
      'He hates the vacuum, so I left it in the cupboard.',
      'She snaps at the other cat over the food bowl.',
      'He scratched at the couch until I gave him a toy.',
    ],
    address: [
      'We took the long way down Quarry Road and back.',
      'We walked past Old Quarry Road and back again.',
      'We walked all the way to the end of Larkspur Lane.',
      'She loves the walk up Main Street in the morning.',
      'The new apartment is so bright and sunny.',
      'We met at the corner of the two big roads.',
      'turned onto maple rd, see you soon',
    ],
  };
  for (const [kind, texts] of Object.entries(MUST_DROP)) {
    it(`drops ${kind} wording`, () => {
      for (const t of texts) assert.notStrictEqual(own.householdSpecific(t), null, t);
    });
  }
  it('drops an example whose placeholder stood for a phone, an address or a long number', () => {
    for (const t of ['Call me on [phone] any time.', 'See you at [address] soon.', 'Use [number] at the side.']) {
      assert.notStrictEqual(own.householdSpecific(t), null, t);
    }
  });
  const MUST_SURVIVE = [
    'Thank you so much! It was a joy to spend the afternoon with your Kin. Talk soon!',
    'We had a lovely long walk, fresh water in the bowl and lots of cuddles on the couch before I left.',
    'Hi [Kinfolk], all went well today. [Kin] and [Kin 2] played in the yard and then napped in the sun.',
    'The clock in the hall chimed while we played with the monkey toy.',
    'She curled up on her pillow and we refilled the water bowl before heading off.',
    'The road was quiet and by the way, the leaves are turning.',
    'Missing you already, see you next time. Lots of love from the Tribe!',
    'Happy holidays from all of us, and thank you for a wonderful year.',
    'We played indoors while it rained and then had a little nap together.',
    'Thank you for trusting us with your family, it means the world. Talk soon!',
    'Sending lots of love and tail wags your way, see you next visit!',
    'Everyone was fed, cuddled and settled before I headed out for the night.',
    'Have a wonderful weekend, and thanks again for the kind note.',
    'I will reply right away, thank you for checking in with us.',
    'What a terrific afternoon of play, belly rubs and a long nap.',
    'All tucked in and happy, fresh water in every bowl.',
    'She was so happy to see me and we played fetch until she was tired out.',
    'Time flew by, we had such fun this afternoon.',
    'She loved her ear scratches and her new chew toy today.',
    'Got everything squared away, bowls clean and water fresh.',
    'I will snap a few photos for you next visit, she looked so cute.',
    'Every little moment lands just right when we play together.',
  ];
  it('keeps plain sign-offs and generic visit wording, two Kin placeholders included', () => {
    for (const t of MUST_SURVIVE) assert.strictEqual(own.householdSpecific(t), null, t);
  });
  it('of the six builder fixture examples that reach the scrub, the KinTale comment and the broadcast survive', () => {
    const data = tribeData();
    const sent = {
      m1: data['conversations/h1/messages'][0].body,
      m3: data['conversations/h2/messages'][0].body,
      t1: data.sms_messages[0].body,
      r1: data.kin_care_reports[0].bodyCopy,
      c1: data['kin_care_reports/r1/comments'][0].body,
      b1: data.broadcasts[0].body,
    };
    const kept = Object.entries(sent).filter(([, body]) => own.householdSpecific(own.plainText(body)) === null).map(([id]) => id);
    assert.deepStrictEqual(kept, ['c1', 'b1']);
  });
  it('when the newest of a kind hold specifics, the next ones of that kind are sent', async () => {
    const data = tribeData({
      broadcasts: [
        { id: 'b1', body: 'Holiday visits are booking up, the door is always open for your Kin.', sentAtMs: 905 },
        { id: 'b2', body: 'Remember the flea season is here, so ask us about a reminder.', sentAtMs: 904 },
        { id: 'b3', body: 'Our rates change in January to forty dollars a visit for everyone.', sentAtMs: 903 },
        { id: 'b4', body: 'Thank you all for a wonderful year of walks, naps and cuddles.', sentAtMs: 902 },
        { id: 'b5', body: 'We are so grateful for every one of you and your Kin this season.', sentAtMs: 901 },
      ],
    });
    const { value, logs } = await silence(() => own.buildOwnWriting(makeDb(data), VOICE));
    assert.strictEqual((value.text.match(/\[Broadcast\]/g) || []).length, 2);
    assert.match(value.text, /wonderful year of walks/);
    assert.match(value.text, /so grateful for every one/);
    assert.doesNotMatch(value.text, /door is always open|flea season|forty dollars/);
    assert.match(logs.join('\n'), /specifics/);
  });
  it('an example that only shows a specific after the replacing is dropped too', () => {
    // "Tarn" is on the roster as a Kin, so the street word reads after a placeholder.
    const roster = own.addNames(new Map(), 'kin', ['Tarn']);
    const scrubbed = own.scrubExample('We walked along tarn way and back again for a long while.', roster, [], new Set(['we', 'way']), new Map());
    assert.strictEqual(scrubbed, 'We walked along [Kin] way and back again for a long while.');
    assert.notStrictEqual(own.householdSpecific(scrubbed), null);
  });
  it('the collected examples are read before the replacing: a medicine written as a name is not hidden by it', async () => {
    // Mid-sentence, "Apoquel" would become [Name] and the sentence would read
    // clean, so only the read before the replacing catches it.
    const data = tribeData({
      broadcasts: [
        { id: 'b7', body: 'Everyone had their Apoquel with breakfast and then a long nap in the sun by the window.', sentAtMs: 990 },
        ...tribeData().broadcasts,
      ],
    });
    const { value } = await silence(() => own.buildOwnWriting(makeDb(data), VOICE));
    assert.doesNotMatch(value.text, /with breakfast and then a long nap/);
    assert.match(value.text, /holiday calendar is open/);
  });
  it('the collected examples are read again after the replacing, and one that turns specific is not sent', async () => {
    // "Tarn" is a Kin on the roster, so "tarn way" becomes "[Kin] way": a street.
    const data = tribeData({
      kin: [...KIN, { id: 'k9', kinfolkId: 'h2', name: 'Tarn', species: 'cat' }],
      broadcasts: [
        { id: 'b8', body: 'We walked along tarn way and back again for a long while, thank you all.', sentAtMs: 990 },
        ...tribeData().broadcasts,
      ],
    });
    const { value } = await silence(() => own.buildOwnWriting(makeDb(data), VOICE));
    assert.doesNotMatch(value.text, /back again for a long while/);
    assert.match(value.text, /holiday calendar is open/);
  });
});

describe('the emails collection', () => {
  it('is never read: nothing marks a row there as the office\'s own typing', async () => {
    const db = makeDb(tribeData());
    const base = db.collection;
    const asked = [];
    db.collection = (name) => { asked.push(name); return base(name); };
    const { value } = await silence(() => own.buildOwnWriting(db, VOICE));
    assert.ok(!asked.includes('emails'));
    assert.doesNotMatch(value.text, /spare key|\[Email\]/);
  });
});

describe('the office\'s own writing, collected', () => {
  const build = async (data = tribeData(), voice = VOICE) => (await silence(() => own.buildOwnWriting(makeDb(data), voice))).value;

  it('takes inbox replies, text replies, sent KinTales, office comments and broadcasts', async () => {
    const result = await build();
    for (const label of ['[Inbox reply]', '[Text reply]', '[KinTale]', '[KinTale comment]', '[Broadcast]']) {
      assert.ok(result.text.includes(label), `${label} is sent`);
    }
  });
  it('carries no Tribe name, no contact detail and no unknown name', async () => {
    const { text } = await build();
    for (const name of TRIBE_NAMES) assert.ok(!text.includes(name), 'a Tribe name is in the examples');
    assert.doesNotMatch(text, /@|555|https?:|hanasamku|tribetails\.com|48213|1234|\{\{/);
    assert.match(text, /\[Kinfolk\], \[Kin\] was a sweetheart today/);
    assert.match(text, /Hello \[Kinfolk\], the holiday calendar is open/);
  });
  it('leaves out an example that holds a code, a phone, an address or a door, and sends the next of its kind', async () => {
    const { text } = await build();
    assert.doesNotMatch(text, /bowl is put away|Call me|long loop|says hello|gate|worked fine|met me at|door/);
    assert.match(text, /\[Inbox reply\]\nHi \[Kinfolk\], \[Kin\] was a sweetheart today and we had a long cuddle/);
    assert.match(text, /\[Text reply\]\n\[Name\] my way now, \[Kinfolk\]\. \[Kin\] is fed/);
    assert.match(text, /\[KinTale\]\n\[Kin\] sat with me in the sun/);
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
    const { value } = await silence(() => own.buildOwnWriting(makeDb(tribeData(), { failing: ['sms_messages', 'broadcasts'] }), VOICE));
    assert.ok(value.text.includes('[Inbox reply]'));
    assert.ok(!value.text.includes('[Text reply]') && !value.text.includes('[Broadcast]'));
  });
  it('with the generated drafts unreadable, nothing is built', async () => {
    const { value, logs } = await silence(() => own.buildOwnWriting(makeDb(tribeData(), { failing: ['generated_drafts'] }), VOICE));
    assert.strictEqual(value, null);
    assert.match(logs.join('\n'), /generated drafts could not be read/);
  });
  it('a name nobody has on file, typed in lowercase in two examples, is still a name at a sentence start', async () => {
    const data = tribeData({
      broadcasts: [
        { id: 'b1', body: 'The walk was lovely and fenwold the neighbour waved at us from the gate.', sentAtMs: 400 },
        { id: 'b2', body: 'The water is fresh and fenwold the neighbour says the gate is fixed now.', sentAtMs: 401 },
        { id: 'b3', body: 'Fenwold the baker waved at us from the shop while we were out on the walk.', sentAtMs: 402 },
      ],
    });
    const { text } = await build(data);
    assert.doesNotMatch(text, /Fenwold/);
    assert.match(text, /\[Name\] the baker waved at us/);
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
  it('a month or a day in a draft is the calendar, even when someone is named for it', () => {
    const withApril = [...entries, { role: 'kinfolk', forms: ['April'] }];
    assert.deepStrictEqual(own.tribeNamesIn('See you in April, Marzipan.', withApril, vocab, 'notes', ['Marzipan']), []);
  });
  it('the start of a new paragraph is a sentence start too', () => {
    assert.deepStrictEqual(own.tribeNamesIn('Hi Leopold,\n\nWill you call?', entries, vocab, 'notes', []), []);
  });
});

describe('a slow build', () => {
  it('is not waited for past the budget, and still fills the cache for the next request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const db = makeDb(tribeData());
    const base = db.collection;
    db.collection = (name) => {
      const c = base(name);
      if (name !== 'kinfolk') return c;
      return { ...c, async get() { await gate; return c.get(); } };
    };
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => realSetTimeout(fn, ms > 1000 ? 5 : ms);
    try {
      const first = (await silence(() => own.loadOwnWriting(db, VOICE))).value;
      assert.strictEqual(first.text, '');
      release();
      await new Promise((resolve) => realSetTimeout(resolve, 20));
      const second = (await silence(() => own.loadOwnWriting(makeDb({}), VOICE))).value;
      assert.ok(second.text.includes('[Inbox reply]'));
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});
