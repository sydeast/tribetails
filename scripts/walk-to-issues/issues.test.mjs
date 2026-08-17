import { describe, expect, it } from 'vitest';
import { draftIssues, fileIssues, findDuplicates } from './issues.mjs';

/**
 * These tests never touch gh and never touch the network.
 *
 * That is not a limitation to work around, it is the reason draftIssues is pure
 * and findDuplicates takes an injectable issue list: the two things worth
 * asserting here are the wording of a report and the arithmetic of the duplicate
 * score, and neither of them needs a GitHub account to be true.
 *
 * The fixtures are hand built rather than recorded, so a walk shape change shows
 * up as a failing assertion about a missing field instead of a test that quietly
 * passes over a file nobody reads.
 */

function walkWith(marks, meta = {}) {
  return {
    meta: {
      id: 'walk-1',
      formatVersion: 1,
      app: 'admin',
      origin: 'https://auntie.tribetails.com',
      startedIso: '2026-08-16T10:00:00.000Z',
      endedIso: '2026-08-16T10:05:00.000Z',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      identity: 'operator@example.com',
      ...meta,
    },
    marks,
    events: [],
  };
}

function markWith(overrides = {}) {
  return {
    id: 'm1',
    at: 65_000,
    isoTime: '2026-08-16T10:01:05.000Z',
    route: '/households/h-42',
    fullUrl: 'https://auntie.tribetails.com/households/h-42',
    note: '',
    element: null,
    viewport: { width: 1440, height: 900 },
    console: [],
    network: [],
    replayIndex: 812,
    ...overrides,
  };
}

const BUTTON = {
  selector: 'main > div.profile > button.book',
  tag: 'BUTTON',
  text: 'Book a walk',
  rect: { x: 100.4, y: 220.7, width: 120, height: 40 },
};

describe('draftIssues: titles', () => {
  it('prefers the operator note over everything else in the mark', () => {
    const [draft] = draftIssues(
      walkWith([markWith({ note: 'Book button does nothing', element: BUTTON })]),
    );
    expect(draft.title).toBe('admin /households/h-42: Book button does nothing');
  });

  it('falls back to the route plus the element text when there is no note', () => {
    const [draft] = draftIssues(walkWith([markWith({ element: BUTTON })]));
    expect(draft.title).toBe('admin /households/h-42: Book a walk (button)');
  });

  it('falls back to the route plus the failing callable when there is no note and no element', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          network: [
            { at: 1000, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getHousehold', callable: 'getHousehold', status: 500, durationMs: 412, requestBody: null, responseBody: '{"error":"boom"}', error: null },
          ],
        }),
      ]),
    );
    expect(draft.title).toBe('admin /households/h-42: getHousehold returned 500');
  });

  it('calls a request that never came back "no response" rather than reading a null status as success', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          network: [
            { at: 1000, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/setActiveTribe', callable: 'setActiveTribe', status: null, durationMs: null, requestBody: null, responseBody: null, error: 'Failed to fetch' },
          ],
        }),
      ]),
    );
    expect(draft.title).toBe('admin /households/h-42: setActiveTribe returned no response');
  });

  it('a mark carrying nothing at all still gets a title naming the route and the moment', () => {
    const [draft] = draftIssues(walkWith([markWith({})]));
    expect(draft.title).toBe('admin /households/h-42: marked at 1m05s into the walk');
    expect(draft.title).not.toMatch(/issue found/i);
  });

  it('keeps titles inside the length GitHub renders in a list', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'x'.repeat(400) })]));
    expect(draft.title.length).toBeLessThanOrEqual(100);
    expect(draft.title.endsWith('...')).toBe(true);
  });
});

describe('draftIssues: bodies', () => {
  it('says where the walk was, on which app, and as whom', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'wrong total' })]));
    expect(draft.body).toContain('**App:** admin');
    expect(draft.body).toContain('**Origin:** https://auntie.tribetails.com');
    expect(draft.body).toContain('/households/h-42');
    expect(draft.body).toContain('operator@example.com');
    expect(draft.body).toContain('2026-08-16T10:01:05.000Z');
  });

  it('quotes the note verbatim, including its own punctuation', () => {
    const note = "Total says $0.00 but the walk was 45 minutes; it's been wrong all week";
    const [draft] = draftIssues(walkWith([markWith({ note })]));
    expect(draft.body).toContain('> ' + note);
  });

  it('gives the element a reader can go and look at: selector, tag and visible text', () => {
    const [draft] = draftIssues(walkWith([markWith({ element: BUTTON })]));
    expect(draft.body).toContain('main > div.profile > button.book');
    expect(draft.body).toContain('button');
    expect(draft.body).toContain('Book a walk');
  });

  it('omits the console section entirely when the mark recorded no console output', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'looks wrong' })]));
    expect(draft.body).not.toContain('## Console');
  });

  it('prints console errors when there are some, with the level and the moment', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          console: [
            { level: 'error', at: 64_000, text: 'TypeError: cannot read property name of undefined' },
            { level: 'warn', at: 64_500, text: 'React key warning' },
          ],
        }),
      ]),
    );
    expect(draft.body).toContain('## Console');
    expect(draft.body).toContain('ERROR TypeError: cannot read property name of undefined');
    expect(draft.body).toContain('WARN React key warning');
  });

  it('omits the network section entirely when the mark recorded no requests', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'looks wrong' })]));
    expect(draft.body).not.toContain('## Network');
  });

  it('tables the network calls with callable, status and duration, and flags the non-2xx ones', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          network: [
            { at: 500, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getMyAccess', callable: 'getMyAccess', status: 200, durationMs: 88, requestBody: null, responseBody: '{}', error: null },
            { at: 900, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getHousehold', callable: 'getHousehold', status: 500, durationMs: 1204, requestBody: null, responseBody: '{"error":"internal"}', error: null },
          ],
        }),
      ]),
    );
    expect(draft.body).toContain('1 of 2 requests did not return 2xx.');
    expect(draft.body).toContain('getMyAccess');
    expect(draft.body).toContain('88 ms');
    expect(draft.body).toContain('1204 ms');
    // The failing row is the one marked, and the successful one is not.
    const rows = draft.body.split('\n').filter((line) => line.startsWith('| '));
    const failing = rows.filter((line) => line.includes('**FAIL**'));
    expect(failing).toHaveLength(1);
    expect(failing[0]).toContain('getHousehold');
    expect(failing[0]).toContain('**500**');
    // Only the failing call's response body is worth the space in an issue.
    expect(draft.body).toContain('{"error":"internal"}');
  });

  it('does not claim a request failed when every call came back 2xx', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          network: [
            { at: 500, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getMyAccess', callable: 'getMyAccess', status: 204, durationMs: 12, requestBody: null, responseBody: null, error: null },
          ],
        }),
      ]),
    );
    expect(draft.body).toContain('## Network');
    expect(draft.body).not.toContain('FAIL');
    expect(draft.body).not.toContain('did not return 2xx');
  });

  it('truncates a long response body and says that it was truncated', () => {
    const [draft] = draftIssues(
      walkWith([
        markWith({
          network: [
            { at: 500, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getHousehold', callable: 'getHousehold', status: 503, durationMs: 30, requestBody: null, responseBody: 'y'.repeat(4000), error: null },
          ],
        }),
      ]),
    );
    expect(draft.body).toContain('(truncated, 4000 chars total)');
    expect(draft.body.length).toBeLessThan(3000);
  });

  it('names the screenshot by path when the shot worked', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'wrong' })]), [
      { markId: 'm1', pngPath: '/tmp/walk/m1.png', ok: true, error: null },
    ]);
    expect(draft.body).toContain('/tmp/walk/m1.png');
  });

  it('says the shot failed, with the reason, rather than pointing at a file that is not there', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'wrong' })]), [
      { markId: 'm1', pngPath: '', ok: false, error: 'replay never reached this index' },
    ]);
    expect(draft.body).toContain('## Screenshot');
    expect(draft.body).toContain('replay never reached this index');
  });

  it('says nothing about screenshots when no shot was produced for the mark', () => {
    const withNoShots = draftIssues(walkWith([markWith({ note: 'wrong' })]));
    const withOtherShot = draftIssues(walkWith([markWith({ note: 'wrong' })]), [
      { markId: 'some-other-mark', pngPath: '/tmp/x.png', ok: true, error: null },
    ]);
    expect(withNoShots[0].body).not.toContain('Screenshot');
    expect(withOtherShot[0].body).not.toContain('Screenshot');
  });

  it('points at the replay so a reader can watch the moment rather than imagine it', () => {
    const [draft] = draftIssues(walkWith([markWith({ note: 'wrong' })]));
    expect(draft.body).toContain('walk-1');
    expect(draft.body).toContain('rrweb event index 812');
  });
});

describe('draftIssues: robustness and purity', () => {
  it('returns an empty array for a walk that is missing, empty, or the wrong shape', () => {
    expect(draftIssues(undefined)).toEqual([]);
    expect(draftIssues(null)).toEqual([]);
    expect(draftIssues({})).toEqual([]);
    expect(draftIssues({ marks: 'not an array' })).toEqual([]);
  });

  it('tolerates shots being missing, empty, or not an array at all', () => {
    const walk = walkWith([markWith({ note: 'wrong' })]);
    expect(draftIssues(walk).length).toBe(1);
    expect(draftIssues(walk, []).length).toBe(1);
    expect(draftIssues(walk, null).length).toBe(1);
    expect(draftIssues(walk, 'nope').length).toBe(1);
  });

  it('degrades one unreadable mark instead of losing the rest of the walk', () => {
    const exploding = markWith({ id: 'bad' });
    Object.defineProperty(exploding, 'route', {
      get() {
        throw new Error('route is a getter that blew up');
      },
    });
    const drafts = draftIssues(walkWith([markWith({ id: 'a', note: 'first' }), exploding, markWith({ id: 'c', note: 'third' })]));
    expect(drafts).toHaveLength(3);
    expect(drafts[0].title).toContain('first');
    expect(drafts[1].title).toContain('could not be read from the walk file');
    expect(drafts[1].body).toContain('route is a getter that blew up');
    expect(drafts[2].title).toContain('third');
  });

  it('gives a mark with no id a stable identity from its position', () => {
    const [draft] = draftIssues(walkWith([markWith({ id: undefined })]));
    expect(draft.markId).toBe('mark-0');
  });

  it('is deterministic: the same walk drafts identically twice', () => {
    const walk = walkWith([
      markWith({ note: 'one' }),
      markWith({ id: 'm2', element: BUTTON, console: [{ level: 'error', at: 1, text: 'boom' }] }),
    ]);
    expect(draftIssues(walk)).toEqual(draftIssues(walk));
  });

  it('labels every draft bug, which is the only label this repo actually has', () => {
    const drafts = draftIssues(walkWith([markWith({ note: 'a' }), markWith({ id: 'm2', note: 'b' })]));
    for (const draft of drafts) expect(draft.labels).toEqual(['bug']);
  });

  it('writes no em dashes into any generated title or body', () => {
    const drafts = draftIssues(
      walkWith([
        markWith({
          note: 'the total is wrong',
          element: BUTTON,
          console: [{ level: 'error', at: 1, text: 'boom' }],
          network: [{ at: 1, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/getHousehold', callable: 'getHousehold', status: 500, durationMs: 9, requestBody: null, responseBody: 'nope', error: null }],
        }),
      ]),
      [{ markId: 'm1', pngPath: '/tmp/m1.png', ok: true, error: null }],
    );
    // Written as the escape rather than the character, because the rule the
    // assertion enforces applies to this file too.
    const EM_DASH = '\u2014';
    for (const draft of drafts) {
      expect(draft.title).not.toContain(EM_DASH);
      expect(draft.body).not.toContain(EM_DASH);
    }
  });
});

describe('findDuplicates', () => {
  const drafted = () =>
    draftIssues(
      walkWith([
        markWith({
          note: 'Book button does nothing',
          element: BUTTON,
          network: [
            { at: 1, method: 'POST', url: 'https://us-central1-x.cloudfunctions.net/bookWalk', callable: 'bookWalk', status: 500, durationMs: 20, requestBody: null, responseBody: null, error: null },
          ],
        }),
      ]),
    );

  it('scores a near identical existing issue high on every signal', async () => {
    const [annotated] = await findDuplicates(drafted(), {
      issues: [
        {
          number: 12,
          title: 'admin /households/h-42: Book button does nothing',
          url: 'https://github.com/x/y/issues/12',
          body: 'Route /households/h-42, selector main > div.profile > button.book, bookWalk returns 500.',
        },
      ],
    });
    expect(annotated.duplicates).toHaveLength(1);
    expect(annotated.duplicates[0].number).toBe(12);
    expect(annotated.duplicates[0].score).toBe(1);
  });

  it('scores an unrelated issue below the reporting floor and leaves it out', async () => {
    const [annotated] = await findDuplicates(drafted(), {
      issues: [
        { number: 3, title: 'Android build fails on Gradle 9', url: 'u', body: 'Nothing to do with the web apps.' },
      ],
    });
    expect(annotated.duplicates).toEqual([]);
  });

  it('reports a route only match, because the same screen twice is worth a look', async () => {
    const [annotated] = await findDuplicates(drafted(), {
      issues: [
        { number: 7, title: 'Household profile spacing', url: 'u', body: 'Seen on /households/h-42 at desktop width.' },
      ],
    });
    expect(annotated.duplicates).toHaveLength(1);
    expect(annotated.duplicates[0].score).toBe(0.25);
  });

  it('never lets title similarity alone reach the bar that skipping uses', async () => {
    // Same screen, same words, genuinely different defect. This is exactly the
    // case that must not be auto skipped, so the score has to stay under 0.6.
    const [annotated] = await findDuplicates(drafted(), {
      issues: [
        { number: 9, title: 'admin Book button does nothing on mobile', url: 'u', body: 'No route or selector recorded.' },
      ],
    });
    expect(annotated.duplicates[0].score).toBeLessThan(0.6);
  });

  it('adds the selector and the callable on top of the route', async () => {
    const [routeOnly] = await findDuplicates(drafted(), {
      issues: [{ number: 1, title: 'unrelated words entirely', url: 'u', body: '/households/h-42' }],
    });
    const [routeAndSelector] = await findDuplicates(drafted(), {
      issues: [{ number: 1, title: 'unrelated words entirely', url: 'u', body: '/households/h-42 main > div.profile > button.book' }],
    });
    const [everything] = await findDuplicates(drafted(), {
      issues: [{ number: 1, title: 'unrelated words entirely', url: 'u', body: '/households/h-42 main > div.profile > button.book bookWalk' }],
    });
    expect(routeOnly.duplicates[0].score).toBe(0.25);
    expect(routeAndSelector.duplicates[0].score).toBe(0.45);
    expect(everything.duplicates[0].score).toBe(0.6);
  });

  it('sorts the strongest match first', async () => {
    const [annotated] = await findDuplicates(drafted(), {
      issues: [
        { number: 4, title: 'weak', url: 'u', body: '/households/h-42' },
        { number: 5, title: 'admin /households/h-42: Book button does nothing', url: 'u', body: 'main > div.profile > button.book bookWalk' },
      ],
    });
    expect(annotated.duplicates.map((d) => d.number)).toEqual([5, 4]);
    expect(annotated.duplicates[0].score).toBeGreaterThan(annotated.duplicates[1].score);
  });

  it('annotates without removing: every draft comes back, in order, duplicate or not', async () => {
    const drafts = draftIssues(
      walkWith([markWith({ id: 'a', note: 'Book button does nothing' }), markWith({ id: 'b', note: 'something else' })]),
    );
    const annotated = await findDuplicates(drafts, {
      issues: [{ number: 12, title: 'admin /households/h-42: Book button does nothing', url: 'u', body: '/households/h-42' }],
    });
    expect(annotated.map((d) => d.markId)).toEqual(['a', 'b']);
    expect(annotated[0].duplicates.length).toBeGreaterThan(0);
    expect(annotated[0].title).toBe(drafts[0].title);
    expect(annotated[0].body).toBe(drafts[0].body);
  });

  it('handles an empty issue list and an empty draft list without complaint', async () => {
    expect(await findDuplicates([], { issues: [] })).toEqual([]);
    const [annotated] = await findDuplicates(drafted(), { issues: [] });
    expect(annotated.duplicates).toEqual([]);
  });
});

describe('fileIssues', () => {
  const draftWithDuplicate = (score) => ({
    markId: 'm1',
    title: 'admin /households/h-42: Book button does nothing',
    body: 'body text',
    labels: ['bug'],
    duplicates: [{ number: 12, title: 'the same thing', url: 'u', score }],
  });

  it('defaults to a dry run: nothing is created and the argv is returned instead', async () => {
    const [result] = await fileIssues([draftWithDuplicate(0.1)]);
    expect(result.dryRun).toBe(true);
    expect(result.url).toBeNull();
    expect(result.error).toBeNull();
    expect(result.args).toContain('create');
    expect(result.args).toContain('admin /households/h-42: Book button does nothing');
    // The body goes over stdin rather than the command line, so a walk that
    // recorded a shell metacharacter cannot become an argument.
    expect(result.args).toContain('--body-file');
    expect(result.args).toContain('-');
    expect(result.args.join(' ')).not.toContain('body text');
  });

  it('treats anything other than confirm === true as a dry run', async () => {
    for (const confirm of [undefined, false, 'true', 1, {}]) {
      const [result] = await fileIssues([draftWithDuplicate(0.1)], { confirm });
      expect(result.dryRun).toBe(true);
    }
  });

  it('does not skip a duplicate by default, however strong the match', async () => {
    const [result] = await fileIssues([draftWithDuplicate(1)]);
    expect(result.skipped).toBe(false);
  });

  it('skips only above the strong bar when the caller asks for it, and still returns the draft and its duplicates', async () => {
    const [strong] = await fileIssues([draftWithDuplicate(0.9)], { skipDuplicates: true });
    const [weak] = await fileIssues([draftWithDuplicate(0.4)], { skipDuplicates: true });
    expect(strong.skipped).toBe(true);
    expect(strong.draft.duplicates[0].number).toBe(12);
    expect(weak.skipped).toBe(false);
  });

  it('passes every label through, and the repo when one is given', async () => {
    const [result] = await fileIssues([{ ...draftWithDuplicate(0), labels: ['bug', 'triage'] }], { repo: 'owner/name' });
    expect(result.args.filter((arg) => arg === '--label')).toHaveLength(2);
    expect(result.args).toContain('triage');
    expect(result.args).toContain('owner/name');
  });

  it('returns an empty array for an empty or missing draft list', async () => {
    expect(await fileIssues([])).toEqual([]);
    expect(await fileIssues(undefined)).toEqual([]);
  });
});
