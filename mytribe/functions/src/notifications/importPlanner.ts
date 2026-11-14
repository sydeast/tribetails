/**
 * What an import WOULD do, worked out before anything is written.
 *
 * Pure on purpose. The planner takes the corpus and the current documents as
 * arguments and returns a report; it never touches Firestore, so the dry run
 * and the real run are the same computation and cannot disagree about what was
 * promised. `admin/importSeedTemplates.ts` calls this once, prints it when the
 * caller asked for a dry run, and otherwise turns the same plan into writes.
 *
 * Being pure is also what makes the guard testable. The committed corpus is
 * clean, so proving that a triple stash is refused needs a poisoned corpus, and
 * here that is one argument rather than a mocked generated module.
 */
import {
  pushTemplateIssues,
  smsTemplateIssues,
  templateIdIssue,
  visualEmailTemplateIssues,
} from '../lib/templateValidation';
import { sanitizePlainText } from '../lib/richText';
import { parsePushTxt } from './templateParsers';
import type { SeedCorpusEntry } from './seedCorpus.generated';

/** The three collections a seed directory writes into. */
export type TemplateChannel = 'email' | 'sms' | 'push';

export const CHANNEL_COLLECTIONS: Readonly<Record<TemplateChannel, string>> = Object.freeze({
  email: 'emailTemplates',
  sms: 'smsTemplates',
  push: 'pushTemplates',
});

/**
 * What the import will do to one channel of one template.
 *
 * `blocked` is the outcome that matters most, because it is the one that keeps
 * a bad template out. `skipped` and `unchanged` look alike in a list and are
 * deliberately different words: unchanged means the stored copy already matches
 * the repo, skipped means it does NOT match and the operator did not ask for
 * the overwrite.
 */
export type ImportOutcome = 'create' | 'overwrite' | 'skipped' | 'unchanged' | 'blocked';

export interface ChannelPlan {
  channel: TemplateChannel;
  collection: string;
  outcome: ImportOutcome;
  /** The content fields to merge onto the document. Absent when nothing is written. */
  content?: Record<string, string | null>;
  /** Why it is blocked, or what differs. One sentence per entry, operator facing. */
  notes: string[];
  /**
   * #1936: what differs, for a `skipped` or `overwrite` channel. Absent on
   * every other outcome. See [ChannelDifference].
   */
  differences?: ChannelDifference[];
}

/**
 * One wording that differs between the stored copy and the repo copy, both
 * as an operator reads them (#1936).
 *
 * Before this the import screen said "the stored sms copy differs from the
 * repo copy" and showed neither, so ticking "replace" was a blind choice.
 *
 * `stored` and `repo` are READABLE text, never markup: an email's message
 * is HTML in both places and is shown with its paragraphs and line breaks
 * kept and its tags dropped. An empty string means that copy has no wording
 * there. Only parts whose readable text differs are listed; when the stored
 * copy differs only in its formatting or in the older email format, the list
 * has one entry with `stored === repo` and a `note` saying so, so a client
 * never draws an empty comparison that reads as "identical".
 */
export interface ChannelDifference {
  /** The stored field the wording sits in: subject, headline, content, text, title, body. */
  field: string;
  /** The operator's name for it: "Subject", "Message", "Text message", "Title"... */
  label: string;
  stored: string;
  repo: string;
  /** Set only when the wording matches and something else about the copy differs. */
  note?: string;
}

export interface TemplatePlan {
  templateId: string;
  channels: ChannelPlan[];
  /** True when at least one channel differs from the stored copy. */
  differsFromRepo: boolean;
  /** True when any channel is blocked. Nothing for this template is written. */
  blocked: boolean;
  /** Every complaint across the template's channels, for a compact report line. */
  issues: string[];
}

export interface ImportPlan {
  templates: TemplatePlan[];
  counts: Record<ImportOutcome, number>;
}

/** The stored documents the planner compares against, keyed by full path. */
export type ExistingDocs = Record<string, Record<string, unknown> | undefined>;

export interface PlanInput {
  corpus: readonly SeedCorpusEntry[];
  existing: ExistingDocs;
  /**
   * The template ids the operator explicitly chose to overwrite. Anything not
   * named here that already differs is SKIPPED. This is the whole point of the
   * two-step flow: an import can never quietly replace wording an operator
   * edited in the Template Bank.
   */
  overwriteIds?: readonly string[];
  /** When set, only these ids are considered at all. */
  onlyIds?: readonly string[];
}

/**
 * The stored fields the planner compares and the importer writes, per channel.
 *
 * Deliberately narrow. `emailTemplates` documents also carry `title`,
 * `description`, `tags`, `category`, `usageInstructions` and
 * `sectionDefinitions`, all of which belong to whoever authored the template in
 * the Template Bank, and none of which the corpus has an opinion about. The
 * seed script overwrote the whole document and dropped them; an import that did
 * the same would erase an operator's categorisation every time it ran.
 */
const CONTENT_FIELDS: Readonly<Record<TemplateChannel, readonly string[]>> = Object.freeze({
  // All six, not just the three the corpus fills in. An import that only
  // compared subject/headline/content could call a stored old-format document
  // "unchanged" and leave its body/html sitting next to the new visual
  // fields; comparing format/body/html too means an overwrite is the only way
  // to reach "unchanged", and an overwrite always clears the old pair (see
  // `channelContent`'s email branch below).
  email: ['subject', 'headline', 'content', 'format', 'body', 'html'],
  sms: ['text'],
  push: ['title', 'body'],
});

/** The corpus files for one channel, parsed into the fields as stored. */
function channelContent(
  entry: SeedCorpusEntry,
  channel: TemplateChannel,
): { content: Record<string, string | null>; issues: string[] } {
  try {
    if (channel === 'email') {
      // The importer writes visual documents. `body: null, html: null` on
      // every write means an overwrite clears whatever old-format pair was
      // stored, so a document can never end up holding both formats.
      const content = {
        subject: entry.emailSubject,
        headline: entry.emailHeadline,
        content: entry.emailContent,
        format: 'visual',
        body: null,
        html: null,
      };
      return { content, issues: visualEmailTemplateIssues(content) };
    }
    if (channel === 'sms') {
      const text = entry.smsTxt.trim();
      return { content: { text }, issues: smsTemplateIssues(text) };
    }
    const { title, body } = parsePushTxt(entry.pushTxt);
    return { content: { title, body }, issues: pushTemplateIssues(title, body) };
  } catch (err) {
    // A parse refusal is a content problem like any other, and reads better in
    // the report next to the triple-stash complaints than as a thrown error
    // that aborts the other 44 templates.
    return { content: {}, issues: [(err as Error).message] };
  }
}

/** True when every content field of the stored doc already matches the repo. */
function matchesStored(
  content: Record<string, string | null>,
  stored: Record<string, unknown> | undefined,
  channel: TemplateChannel,
): boolean {
  if (!stored) return false;
  return CONTENT_FIELDS[channel].every((field) => {
    const wanted = content[field] ?? null;
    const has = (stored[field] ?? null) as unknown;
    return wanted === has;
  });
}

/**
 * An email body as a person reads it: paragraphs and line breaks kept, tags
 * dropped, entities decoded once. Used only to SHOW a difference, never to
 * decide one (that stays `matchesStored`, field by field).
 */
export function readableEmailText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ');
  return sanitizePlainText(withBreaks)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The readable parts of one channel's copy, keyed by stored field. An old
 * format email keeps its wording in `html` (or `body`) rather than `content`;
 * either is read as the message so the comparison is of wording, not format.
 */
function readableParts(
  channel: TemplateChannel,
  doc: Record<string, unknown>,
): Array<{ field: string; label: string; text: string }> {
  if (channel === 'email') {
    const message = asText(doc['content']) || asText(doc['html']) || asText(doc['body']);
    return [
      { field: 'subject', label: 'Subject', text: asText(doc['subject']).trim() },
      { field: 'headline', label: 'Headline', text: asText(doc['headline']).trim() },
      { field: 'content', label: 'Message', text: readableEmailText(message) },
    ];
  }
  if (channel === 'sms') return [{ field: 'text', label: 'Text message', text: asText(doc['text']).trim() }];
  return [
    { field: 'title', label: 'Title', text: asText(doc['title']).trim() },
    { field: 'body', label: 'Message', text: asText(doc['body']).trim() },
  ];
}

/** PURE. What differs between a stored copy and the repo copy, as [ChannelDifference]s (#1936). */
export function channelDifferences(
  channel: TemplateChannel,
  repoContent: Record<string, string | null>,
  stored: Record<string, unknown>,
): ChannelDifference[] {
  const repo = readableParts(channel, repoContent);
  const mine = readableParts(channel, stored);
  const out: ChannelDifference[] = [];
  repo.forEach((r, i) => {
    const s = mine[i]!;
    if (s.text !== r.text) out.push({ field: r.field, label: r.label, stored: s.text, repo: r.text });
  });
  if (out.length > 0) return out;
  // The wording matches and the copy still differs: show the wording once,
  // and say what else is different.
  const oldFormat = channel === 'email' && asText(stored['format']) !== 'visual';
  const main = repo[repo.length - 1]!;
  return [
    {
      field: main.field,
      label: main.label,
      stored: main.text,
      repo: main.text,
      note: oldFormat
        ? 'The wording is the same. Your stored copy uses the older email format, and importing moves it to the current one.'
        : 'The wording is the same. Only the formatting differs, such as bold text or spacing.',
    },
  ];
}

const EMPTY_COUNTS = (): Record<ImportOutcome, number> => ({
  create: 0,
  overwrite: 0,
  skipped: 0,
  unchanged: 0,
  blocked: 0,
});

/** Works out, for every corpus entry, what the import would do and why. */
export function planImport(input: PlanInput): ImportPlan {
  const overwrite = new Set(input.overwriteIds ?? []);
  const only = input.onlyIds ? new Set(input.onlyIds) : null;
  const counts = EMPTY_COUNTS();
  const templates: TemplatePlan[] = [];

  for (const entry of input.corpus) {
    if (only && !only.has(entry.key)) continue;

    // The directory name becomes a document id in three collections, so it
    // faces the same rule the editor's key field does.
    const idIssue = templateIdIssue(entry.key);

    const channels: ChannelPlan[] = [];
    const issues: string[] = [];
    let differsFromRepo = false;

    for (const channel of ['email', 'sms', 'push'] as const) {
      const collection = CHANNEL_COLLECTIONS[channel];
      const { content, issues: contentIssues } = channelContent(entry, channel);
      const notes = [...contentIssues];
      if (idIssue) notes.unshift(idIssue);

      if (notes.length > 0) {
        channels.push({ channel, collection, outcome: 'blocked', notes });
        issues.push(...notes.map((n) => `${channel}: ${n}`));
        continue;
      }

      const stored = input.existing[`${collection}/${entry.key}`];
      if (!stored) {
        channels.push({ channel, collection, outcome: 'create', content, notes: [] });
        continue;
      }
      if (matchesStored(content, stored, channel)) {
        channels.push({ channel, collection, outcome: 'unchanged', notes: [] });
        continue;
      }

      differsFromRepo = true;
      const differs = `The stored ${channel} copy differs from the repo copy.`;
      const differences = channelDifferences(channel, content, stored);
      if (overwrite.has(entry.key)) {
        channels.push({
          channel,
          collection,
          outcome: 'overwrite',
          content,
          notes: [`${differs} Importing replaces your stored copy with the repo wording.`],
          differences,
        });
      } else {
        channels.push({
          channel,
          collection,
          outcome: 'skipped',
          notes: [
            `${differs} Your stored copy stays as it is. ` +
              `Tick this template to replace it with the repo wording.`,
          ],
          differences,
        });
      }
    }
    const blocked = channels.some((c) => c.outcome === 'blocked');
    // One bad channel holds the whole template back. A template whose email
    // imported and whose sms did not is a half-loaded notification, which is
    // harder to notice than one that plainly did not load.
    const finalChannels = blocked
      ? channels.map((c) =>
          c.outcome === 'blocked'
            ? c
            : {
                ...c,
                outcome: 'blocked' as const,
                content: undefined,
                notes: ['Held back because another channel of this template was refused.'],
              },
        )
      : channels;

    for (const c of finalChannels) counts[c.outcome] += 1;
    templates.push({ templateId: entry.key, channels: finalChannels, differsFromRepo, blocked, issues });
  }

  return { templates, counts };
}

/** Every write the plan calls for, flattened for the batch. */
export function plannedWrites(
  plan: ImportPlan,
): Array<{ path: string; content: Record<string, string | null>; isCreate: boolean }> {
  const writes: Array<{ path: string; content: Record<string, string | null>; isCreate: boolean }> = [];
  for (const template of plan.templates) {
    for (const channel of template.channels) {
      if (channel.outcome !== 'create' && channel.outcome !== 'overwrite') continue;
      if (!channel.content) continue;
      writes.push({
        path: `${channel.collection}/${template.templateId}`,
        content: channel.content,
        isCreate: channel.outcome === 'create',
      });
    }
  }
  return writes;
}
