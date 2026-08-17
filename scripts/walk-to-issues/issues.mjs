/**
 * Turn the marks in a recorded walk into GitHub issues a reader can act on.
 *
 * WHY THIS EXISTS. The recorder (packages/issue-recorder) already solves the
 * capture half: the operator hits a hotkey when a screen is wrong and keeps
 * walking. What still costs more than finding the defect is explaining it to
 * somebody who was not looking at the screen. This is that explanation,
 * generated from the evidence the mark already carries, so the operator never
 * has to retype what the recorder saw.
 *
 * THREE STAGES, DELIBERATELY SEPARATE:
 *
 *   draftIssues     pure. No network, no clock, no filesystem. Given the same
 *                   walk it returns the same drafts, which is what makes the
 *                   wording testable at all.
 *   findDuplicates  reads existing issues and ANNOTATES. It never removes a
 *                   draft. The operator has said, in as many words, that a
 *                   duplicate still has to be shown: a tool that quietly ate
 *                   the second report of a defect would recreate the exact
 *                   problem the recorder was built to end.
 *   fileIssues      the only stage that can create anything, and it refuses to
 *                   unless confirm === true is passed explicitly. Filing is
 *                   public and cannot be taken back, so the default has to be
 *                   the harmless one.
 *
 * NOTHING HERE INVENTS DATA. A section is omitted when the mark has nothing to
 * put in it. An empty "Console errors" heading reads as "we looked and it was
 * clean", which is a claim, and a wrong one when the recorder simply never
 * drained anything into that mark.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The repo root, resolved from this file rather than from process.cwd().
 *
 * gh infers the repository from the git remote of the directory it runs in, and
 * a caller can be anywhere, so the working directory is pinned rather than
 * inherited. Getting this wrong does not fail loudly: it files the issue on
 * whatever repo the caller happened to be standing in.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Only 'bug' is emitted, and that is a fact about this repository rather than a
 * design preference. It carries GitHub's default label set and nothing else, and
 * `gh issue create --label` fails the WHOLE create when one label does not
 * exist, so a helpful looking 'app:admin' would turn every filing into an error.
 * Creating labels is a side effect this module has no business performing. The
 * app is in the title and the first line of the body instead, where a human and
 * a search box can both find it.
 */
const DEFAULT_LABELS = ['bug'];

/** Titles longer than this get cut off in every list view GitHub renders. */
const TITLE_LIMIT = 100;

/** How much of a note, an element's text or a response body survives into the issue. */
const NOTE_LIMIT = 400;
const TEXT_LIMIT = 120;
const CELL_LIMIT = 80;
const BODY_SNIPPET_LIMIT = 600;

/** Long walks produce long lists. These keep an issue readable without hiding that there was more. */
const MAX_CONSOLE_LINES = 20;
const MAX_NETWORK_ROWS = 25;
const MAX_FAILING_BODIES = 3;

/** Duplicate scores at or above this are worth showing the operator. See scoreAgainstIssue. */
const DUPLICATE_REPORT_FLOOR = 0.25;

/**
 * The bar for skipDuplicates, which is off by default.
 *
 * Set above the maximum a title match alone can reach (0.40) on purpose: two
 * different defects on the same screen tend to share most of their title words,
 * so title similarity by itself must never be enough to withhold a filing.
 */
const DUPLICATE_STRONG = 0.6;

/** Kept out of title-similarity scoring because they match everything and mean nothing. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'were', 'not',
  'but', 'has', 'have', 'had', 'its', 'when', 'then', 'than', 'does', 'did', 'doing',
  'page', 'screen', 'app', 'admin', 'portal', 'issue', 'bug', 'error', 'errors',
]);

const code = (value) => '`' + String(value) + '`';
const FENCE = '```';

/** Cut long text and SAY it was cut, so a reader never mistakes a truncation for the whole story. */
function clip(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return text.slice(0, limit) + ' ... (truncated, ' + text.length + ' chars total)';
}

/** Markdown tables break on a raw pipe and on any newline, so cells get flattened. */
function cell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return clip(text, CELL_LIMIT) || '-';
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

/** mark.at is milliseconds since the walk started, which reads better as a stopwatch. */
function stopwatch(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown';
  const total = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(total / 60)) + 'm' + String(total % 60).padStart(2, '0') + 's';
}

/**
 * A network call counts as failing when it did not come back 2xx.
 *
 * status null is included because types.ts defines it as the request never
 * completing: aborted, offline, or refused. That is the most interesting row on
 * the table, not a missing one.
 */
function isFailure(entry) {
  const status = entry?.status;
  if (status === null || status === undefined) return true;
  return !(status >= 200 && status < 300);
}

/** The last path segment of a URL, for the table's identity column when there is no callable. */
function shortUrl(url) {
  const text = String(url ?? '');
  try {
    const parsed = new URL(text);
    return parsed.pathname + (parsed.search ? parsed.search : '');
  } catch {
    return text;
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The shot for this mark, or null.
 *
 * shots comes from a sibling module that drives a replay and writes PNGs, so it
 * is treated strictly as data: absent, short, out of order, or carrying ok:false
 * are all normal and none of them are this module's problem to fix.
 */
function shotFor(shots, markId) {
  for (const shot of safeArray(shots)) {
    if (shot && shot.markId === markId) return shot;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Titles
// -----------------------------------------------------------------------------

/**
 * The subject half of the title, in the order the operator asked for.
 *
 * The note wins because it is the only part of a mark that carries intent: the
 * recorder can see that a callable returned 500, but only the operator knows
 * that the screen was supposed to show a household. When there is no note the
 * element is the next most recognisable thing, since "the button that says Book"
 * is something a reader can go and look at. The failing callable comes after
 * that because it names a cause rather than a symptom.
 *
 * There is no generic branch. A mark with nothing in it still gets a title
 * naming its route and its position in the walk, which is enough to find it
 * again in the replay.
 */
function subjectFor(mark) {
  const note = firstLine(mark.note);
  if (note) return note;

  const element = mark.element;
  const elementText = firstLine(element?.text);
  if (elementText) {
    const tag = String(element?.tag ?? '').toLowerCase();
    return tag ? elementText + ' (' + tag + ')' : elementText;
  }

  const failing = safeArray(mark.network).filter(isFailure);
  const named = failing.find((entry) => entry?.callable);
  if (named) {
    const status = named.status === null || named.status === undefined ? 'no response' : String(named.status);
    return named.callable + ' returned ' + status;
  }
  if (failing.length > 0) {
    return failing.length + ' failed request' + (failing.length === 1 ? '' : 's');
  }

  if (element?.selector) return 'element ' + element.selector;

  const consoleLine = firstLine(safeArray(mark.console)[0]?.text);
  if (consoleLine) return 'console: ' + consoleLine;

  return 'marked at ' + stopwatch(mark.at) + ' into the walk';
}

function titleFor(app, mark) {
  const route = firstLine(mark.route) || firstLine(mark.fullUrl) || 'unknown route';
  const prefix = (app ? app + ' ' : '') + route + ': ';
  const room = Math.max(24, TITLE_LIMIT - prefix.length);
  const subject = subjectFor(mark);
  const trimmed = subject.length <= room ? subject : subject.slice(0, room - 3).trimEnd() + '...';
  return prefix + trimmed;
}

// -----------------------------------------------------------------------------
// Bodies
// -----------------------------------------------------------------------------

function whereSection(meta, mark, lines) {
  const bits = [];
  if (meta.app) bits.push('**App:** ' + meta.app);
  if (meta.origin) bits.push('**Origin:** ' + meta.origin);
  if (mark.route) bits.push('**Route:** ' + code(mark.route));
  if (mark.isoTime) bits.push('**Marked:** ' + mark.isoTime + ' (' + stopwatch(mark.at) + ' into the walk)');
  if (meta.identity) bits.push('**Signed in as:** ' + meta.identity);
  if (mark.viewport?.width) bits.push('**Viewport:** ' + mark.viewport.width + 'x' + mark.viewport.height);
  if (bits.length === 0) return;
  lines.push(bits.join('  \n'), '');

  // The full URL only earns a line when it says something the route did not,
  // which is the case whenever the walk happened somewhere other than the
  // origin already printed above.
  if (mark.fullUrl && !String(mark.fullUrl).endsWith(String(mark.route ?? ''))) {
    lines.push('URL: ' + code(mark.fullUrl), '');
  }
}

function noteSection(mark, lines) {
  const note = String(mark.note ?? '').trim();
  if (!note) return;
  // Verbatim and quoted. The operator's three words are the only part of the
  // issue nobody else could have written, so they are never paraphrased.
  lines.push('## What the operator said', '');
  for (const line of clip(note, NOTE_LIMIT).split(/\r?\n/)) lines.push('> ' + line);
  lines.push('');
}

function elementSection(mark, lines) {
  const element = mark.element;
  if (!element) return;
  lines.push('## Element under the cursor', '');
  if (element.tag) lines.push('- Tag: ' + code(String(element.tag).toLowerCase()));
  if (element.text) lines.push('- Visible text: ' + code(clip(String(element.text).replace(/\s+/g, ' ').trim(), TEXT_LIMIT)));
  if (element.selector) lines.push('- Selector: ' + code(element.selector));
  const rect = element.rect;
  if (rect && typeof rect.x === 'number') {
    lines.push('- Box: ' + Math.round(rect.x) + ', ' + Math.round(rect.y) + ' at ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
  }
  lines.push('');
}

function consoleSection(mark, lines) {
  const entries = safeArray(mark.console);
  if (entries.length === 0) return;
  lines.push('## Console', '');
  lines.push('Emitted since the previous mark, so these belong to this screen rather than to the whole walk.', '');
  lines.push(FENCE);
  for (const entry of entries.slice(0, MAX_CONSOLE_LINES)) {
    lines.push('[' + stopwatch(entry?.at) + '] ' + String(entry?.level ?? 'log').toUpperCase() + ' ' + clip(firstLine(entry?.text) || String(entry?.text ?? ''), 300));
  }
  lines.push(FENCE);
  if (entries.length > MAX_CONSOLE_LINES) {
    lines.push('', '(' + (entries.length - MAX_CONSOLE_LINES) + ' more console lines in the walk file.)');
  }
  lines.push('');
}

function networkSection(mark, lines) {
  const entries = safeArray(mark.network);
  if (entries.length === 0) return;
  const failing = entries.filter(isFailure);

  lines.push('## Network', '');
  if (failing.length > 0) {
    lines.push(failing.length + ' of ' + entries.length + ' request' + (entries.length === 1 ? '' : 's') + ' did not return 2xx.', '');
  }
  lines.push('| | When | Call | Method | Status | Duration |');
  lines.push('|---|---|---|---|---|---|');
  for (const entry of entries.slice(0, MAX_NETWORK_ROWS)) {
    const bad = isFailure(entry);
    const flag = bad ? '**FAIL**' : 'ok';
    const name = entry?.callable ? code(entry.callable) : cell(shortUrl(entry?.url));
    const status = entry?.status === null || entry?.status === undefined ? (entry?.error ? cell(entry.error) : 'no response') : String(entry.status);
    const duration = typeof entry?.durationMs === 'number' ? Math.round(entry.durationMs) + ' ms' : '-';
    lines.push('| ' + flag + ' | ' + stopwatch(entry?.at) + ' | ' + name + ' | ' + cell(entry?.method) + ' | ' + (bad ? '**' + status + '**' : status) + ' | ' + duration + ' |');
  }
  if (entries.length > MAX_NETWORK_ROWS) {
    lines.push('', '(' + (entries.length - MAX_NETWORK_ROWS) + ' more requests in the walk file.)');
  }
  lines.push('');

  // The response body of a failing call is usually the whole answer, so it is
  // worth the space. Successful calls are not printed: their bodies are large,
  // uninteresting, and can carry household data.
  const withBodies = failing.filter((entry) => entry?.responseBody || entry?.error).slice(0, MAX_FAILING_BODIES);
  for (const entry of withBodies) {
    lines.push('<details><summary>Response from ' + (entry.callable ?? shortUrl(entry.url)) + '</summary>', '');
    lines.push(FENCE);
    if (entry.error) lines.push('error: ' + clip(entry.error, BODY_SNIPPET_LIMIT));
    if (entry.responseBody) lines.push(clip(entry.responseBody, BODY_SNIPPET_LIMIT));
    lines.push(FENCE, '', '</details>', '');
  }
}

/**
 * The screenshot line, or nothing at all.
 *
 * Three states and they are not the same: a shot that worked gets its path, a
 * shot that failed says so with the reason (a reader who sees no image should
 * know whether one was attempted), and no shot at all produces no section,
 * because claiming a screenshot exists is worse than having none.
 */
function screenshotSection(shot, lines) {
  if (!shot) return;
  lines.push('## Screenshot', '');
  if (shot.ok && shot.pngPath) {
    lines.push('Frame from the replay at this mark: ' + code(shot.pngPath));
    lines.push('', 'Drag that file onto this issue to attach it. The GitHub CLI cannot upload images, so the path is the reference.');
  } else {
    lines.push('The replay frame for this mark could not be captured: ' + (shot.error ? code(clip(shot.error, 300)) : 'no reason given') + '.');
  }
  lines.push('');
}

function replaySection(meta, mark, lines) {
  const bits = [];
  if (meta.id) bits.push('walk ' + code(meta.id));
  if (mark.id) bits.push('mark ' + code(mark.id));
  if (typeof mark.replayIndex === 'number') bits.push('rrweb event index ' + mark.replayIndex);
  if (bits.length === 0) return;
  lines.push('---', '', 'Recorded by the issue recorder: ' + bits.join(', ') + '.');
  if (meta.userAgent) lines.push('', 'User agent: ' + code(clip(meta.userAgent, 200)));
}

function bodyFor(meta, mark, shot) {
  const lines = [];
  whereSection(meta, mark, lines);
  noteSection(mark, lines);
  elementSection(mark, lines);
  consoleSection(mark, lines);
  networkSection(mark, lines);
  screenshotSection(shot, lines);
  replaySection(meta, mark, lines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// -----------------------------------------------------------------------------
// draftIssues
// -----------------------------------------------------------------------------

/**
 * One draft per mark.
 *
 * Deterministic and side effect free: no clock, no filesystem, no network. Every
 * timestamp printed comes out of the walk itself, which is what lets the wording
 * be asserted in a test instead of eyeballed.
 *
 * A mark that cannot be drafted degrades into a draft that says so and the loop
 * continues. Losing the other nine marks of a walk because the third one was
 * malformed would be the worst possible failure mode for a tool whose entire
 * purpose is that defects stop getting dropped.
 *
 * @param {object} walk a CapturedWalk (packages/issue-recorder/src/types.ts)
 * @param {Array<{markId: string, pngPath: string, ok: boolean, error: string|null}>} [shots]
 * @returns {Array<{markId: string, title: string, body: string, labels: string[], duplicates: Array, signals: object}>}
 */
export function draftIssues(walk, shots) {
  const marks = safeArray(walk?.marks);
  const meta = walk?.meta ?? {};
  const drafts = [];

  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const markId = (mark && typeof mark.id === 'string' && mark.id) || 'mark-' + index;
    try {
      const shot = shotFor(shots, markId);
      const callables = [];
      for (const entry of safeArray(mark.network)) {
        if (entry?.callable && !callables.includes(entry.callable)) callables.push(entry.callable);
      }
      drafts.push({
        markId,
        title: titleFor(meta.app, mark),
        body: bodyFor(meta, mark, shot),
        labels: [...DEFAULT_LABELS],
        duplicates: [],
        // What findDuplicates scores on, carried alongside rather than parsed
        // back out of the rendered body. Re-reading prose to recover facts we
        // already had would be fragile the first time the wording changed.
        signals: {
          app: meta.app ?? null,
          route: typeof mark.route === 'string' ? mark.route : null,
          selector: mark.element?.selector ?? null,
          callables,
        },
      });
    } catch (error) {
      drafts.push({
        markId,
        title: (meta.app ? meta.app + ' ' : '') + 'walk mark ' + markId + ': could not be read from the walk file',
        body:
          'This mark was recorded but could not be turned into a report: ' +
          code(clip(error?.message ?? String(error), 300)) +
          '\n\nOpen the walk file and look at mark ' +
          code(markId) +
          ' directly. Everything the recorder captured is still in there; only this summary failed.\n',
        labels: [...DEFAULT_LABELS],
        duplicates: [],
        signals: { app: meta.app ?? null, route: null, selector: null, callables: [] },
      });
    }
  }

  return drafts;
}

// -----------------------------------------------------------------------------
// findDuplicates
// -----------------------------------------------------------------------------

function tokenise(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length > 2 && !STOPWORDS.has(word)));
}

/**
 * How alike a draft and an existing issue are, from 0 to 1.
 *
 * FOUR SIGNALS, WEIGHTED TO SUM TO 1. A simple heuristic that can be explained
 * in a sentence beats a clever one, because the operator has to be able to look
 * at a 0.7 and know why it said 0.7.
 *
 *   0.40  title word overlap. The share of the draft's meaningful title words
 *         that also appear in the existing issue's title. Weighted highest
 *         because it is the only signal that survives a human rewriting the
 *         issue, but capped below the skip threshold on its own: two unrelated
 *         defects on one screen share most of their words.
 *   0.25  the route appears anywhere in the existing issue. Strong evidence,
 *         since routes are long and specific. Ignored for "/" which matches
 *         everything.
 *   0.20  the CSS selector appears in the existing issue. Almost conclusive
 *         when it hits, but it only hits on issues that were themselves filed
 *         from a walk, so it cannot carry more weight than that.
 *   0.15  the share of this draft's callables named in the existing issue.
 *         Cheapest signal: a screen calls the same handful of callables whether
 *         it is broken or not.
 */
function scoreAgainstIssue(draft, issue) {
  const issueText = (String(issue?.title ?? '') + '\n' + String(issue?.body ?? '')).toLowerCase();
  const issueTitleTokens = tokenise(issue?.title);
  const draftTitleTokens = tokenise(draft?.title);

  let shared = 0;
  for (const token of draftTitleTokens) if (issueTitleTokens.has(token)) shared += 1;
  const titleOverlap = draftTitleTokens.size === 0 ? 0 : shared / draftTitleTokens.size;

  const signals = draft?.signals ?? {};
  const route = typeof signals.route === 'string' ? signals.route.toLowerCase() : '';
  const routeHit = route.length > 1 && issueText.includes(route) ? 1 : 0;

  const selector = typeof signals.selector === 'string' ? signals.selector.toLowerCase() : '';
  const selectorHit = selector.length > 0 && issueText.includes(selector) ? 1 : 0;

  const callables = safeArray(signals.callables);
  const matchedCallables = callables.filter((name) => issueText.includes(String(name).toLowerCase())).length;
  const callableShare = callables.length === 0 ? 0 : matchedCallables / callables.length;

  const score = 0.4 * titleOverlap + 0.25 * routeHit + 0.2 * selectorHit + 0.15 * callableShare;
  return Math.round(score * 100) / 100;
}

/** Shell out to gh once for the whole run, not once per draft. */
function listExistingIssues(opts) {
  const args = ['issue', 'list', '--state', 'all', '--limit', '200', '--json', 'number,title,url,body'];
  if (opts?.repo) args.push('--repo', opts.repo);
  return run('gh', args, { cwd: opts?.cwd ?? REPO_ROOT }).then((result) => {
    if (result.code !== 0) {
      throw new Error('gh issue list failed (exit ' + result.code + '): ' + (result.stderr.trim() || 'no output'));
    }
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  });
}

/**
 * Annotate every draft with the existing issues that look like it.
 *
 * ANNOTATES, NEVER FILTERS. The returned array has the same length and the same
 * order as the input. Deciding what to do about a duplicate is the operator's
 * call and it happens at filing time, where it is visible.
 *
 * A failure to reach gh is recorded on the draft rather than thrown, so a run
 * without network still produces drafts. Silence would be worse than an empty
 * duplicates list here, so the reason is attached where the caller will see it.
 *
 * @param {Array} drafts
 * @param {{issues?: Array, repo?: string, cwd?: string}} [opts] pass issues to score offline
 */
export async function findDuplicates(drafts, opts = {}) {
  const list = safeArray(drafts);
  let issues = safeArray(opts.issues);
  let lookupError = null;

  if (!Array.isArray(opts.issues)) {
    try {
      issues = await listExistingIssues(opts);
    } catch (error) {
      issues = [];
      lookupError = error?.message ?? String(error);
    }
  }

  return list.map((draft) => {
    const annotated = { ...draft, duplicates: [], duplicateLookupError: lookupError };
    try {
      annotated.duplicates = issues
        .map((issue) => ({
          number: issue?.number ?? null,
          title: issue?.title ?? '',
          url: issue?.url ?? '',
          score: scoreAgainstIssue(draft, issue),
        }))
        .filter((match) => match.score >= DUPLICATE_REPORT_FLOOR)
        // Highest first, then by issue number so the order never depends on how
        // gh happened to sort its output.
        .sort((a, b) => b.score - a.score || (a.number ?? 0) - (b.number ?? 0))
        .slice(0, 5);
    } catch (error) {
      annotated.duplicateLookupError = error?.message ?? String(error);
    }
    return annotated;
  });
}

// -----------------------------------------------------------------------------
// fileIssues
// -----------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // No shell. Titles and bodies are operator text and page text, and a walk on
    // a real site will eventually contain a backtick or a semicolon.
    const child = spawn(command, args, { cwd: options.cwd ?? REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Refuse the whole run rather than file half of it.
 *
 * Checked once, before the first create. An auth failure discovered on draft
 * four leaves three issues filed and no obvious way to tell which, so the
 * question is asked while the answer still costs nothing.
 */
async function requireGh(opts) {
  let version;
  try {
    version = await run('gh', ['--version'], { cwd: opts.cwd });
  } catch (error) {
    throw new Error(
      'Cannot file issues: the GitHub CLI (gh) is not available. ' +
        'Install it from https://cli.github.com and run `gh auth login`. Underlying error: ' +
        (error?.message ?? String(error)),
    );
  }
  if (version.code !== 0) {
    throw new Error('Cannot file issues: `gh --version` exited ' + version.code + '. ' + (version.stderr.trim() || ''));
  }
  const auth = await run('gh', ['auth', 'status'], { cwd: opts.cwd });
  if (auth.code !== 0) {
    throw new Error(
      'Cannot file issues: gh is installed but not authenticated. Run `gh auth login`, then try again. ' +
        'Nothing was filed. gh said: ' + (auth.stderr.trim() || auth.stdout.trim() || 'nothing'),
    );
  }
}

function createArgsFor(draft, opts) {
  const args = ['issue', 'create', '--title', draft.title, '--body-file', '-'];
  for (const label of safeArray(draft.labels)) args.push('--label', label);
  if (opts.repo) args.push('--repo', opts.repo);
  if (opts.assignee) args.push('--assignee', opts.assignee);
  return args;
}

/**
 * File the drafts, or say what filing them would do.
 *
 * GATED ON PURPOSE. Without opts.confirm === true this creates nothing and
 * touches no network at all: it returns the same array it would have returned,
 * with dryRun true and the exact argv it would have run. A GitHub issue is
 * public the instant it exists and cannot be unmade, so the accident this guards
 * against is somebody running the tool to see what it does.
 *
 * SCREENSHOTS ARE REFERENCED, NOT ATTACHED. gh has no path for uploading an
 * image to an issue, so the body carries the PNG's path and the operator drags
 * the file in if the picture is worth having.
 *
 * @param {Array} drafts drafts, ideally already through findDuplicates
 * @param {{confirm?: boolean, skipDuplicates?: boolean, repo?: string, cwd?: string, assignee?: string}} [opts]
 * @returns {Promise<Array<{draft: object, url: string|null, skipped: boolean, error: string|null, dryRun: boolean, args: string[]}>>}
 */
export async function fileIssues(drafts, opts = {}) {
  const list = safeArray(drafts);
  const confirm = opts.confirm === true;
  // Defaults to false because the operator has ruled that a duplicate still gets
  // shown. Even with it on, the entry stays in the result with its duplicates
  // attached: skipped means "not filed", never "not mentioned".
  const skipDuplicates = opts.skipDuplicates === true;

  const decide = (draft) => {
    const strongest = safeArray(draft?.duplicates).reduce((best, match) => Math.max(best, match?.score ?? 0), 0);
    return skipDuplicates && strongest >= DUPLICATE_STRONG;
  };

  if (!confirm) {
    return list.map((draft) => ({
      draft,
      url: null,
      skipped: decide(draft),
      error: null,
      dryRun: true,
      args: createArgsFor(draft, opts),
    }));
  }

  await requireGh(opts);

  const results = [];
  for (const draft of list) {
    if (decide(draft)) {
      results.push({ draft, url: null, skipped: true, error: null, dryRun: false, args: createArgsFor(draft, opts) });
      continue;
    }
    const args = createArgsFor(draft, opts);
    try {
      const result = await run('gh', args, { cwd: opts.cwd, input: draft.body ?? '' });
      if (result.code !== 0) {
        results.push({
          draft,
          url: null,
          skipped: false,
          error: 'gh issue create exited ' + result.code + ': ' + (result.stderr.trim() || 'no output'),
          dryRun: false,
          args,
        });
        continue;
      }
      // gh prints the new issue's URL on stdout and nothing else worth keeping.
      const url = (result.stdout.match(/https:\/\/\S+/) ?? [null])[0];
      results.push({ draft, url, skipped: false, error: null, dryRun: false, args });
    } catch (error) {
      // One draft failing does not end the run: the remaining marks are still
      // worth filing, and the failure is reported per draft so nothing is lost.
      results.push({ draft, url: null, skipped: false, error: error?.message ?? String(error), dryRun: false, args });
    }
  }
  return results;
}
