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
  emailTemplateIssues,
  pushTemplateIssues,
  smsTemplateIssues,
  templateIdIssue,
} from '../lib/templateValidation';
import { parsePushTxt } from './templateParsers';
import { contentToText, frameHtml } from '../lib/emailFrame';
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
  email: ['subject', 'body', 'html'],
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
      // #953 bridge (Task 3): the corpus carries the visual fields now
      // (emailHeadline/emailContent), not a pre-built old-format body/html.
      // This derives both the same way `sendPartsFor` does for a real visual
      // document, so the imported doc still renders as it always did. Task 4
      // replaces this with a proper visual-format write.
      const subject = entry.emailSubject;
      const body = contentToText(entry.emailHeadline, entry.emailContent);
      const html = frameHtml(entry.emailHeadline, entry.emailContent);
      const content = { subject, body, html };
      return { content, issues: emailTemplateIssues(content) };
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
      const note =
        `The stored ${channel} copy differs from the repo copy. ` +
        `Importing replaces it with the repo wording.`;
      if (overwrite.has(entry.key)) {
        channels.push({ channel, collection, outcome: 'overwrite', content, notes: [note] });
      } else {
        channels.push({
          channel,
          collection,
          outcome: 'skipped',
          notes: [`${note} Tick this template to overwrite it.`],
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
