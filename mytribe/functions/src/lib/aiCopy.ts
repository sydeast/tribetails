import type Anthropic from '@anthropic-ai/sdk';

/**
 * O-8: shared Anthropic client + brand-voice system prompt for the `generate`
 * callable and the AI batch jobs (tale-title backfill).
 *
 * Decisions (docs/DEVELOPMENT_PLAN_2026-07-10.md "AI integration decisions"):
 *  - model claude-opus-4-8 via the official TS SDK
 *  - adaptive thinking; effort low for interactive copy (latency-sensitive)
 *  - stable system prompt first with cache_control ephemeral (prompt caching)
 *  - Batch API (50% price) for bulk jobs, never for interactive requests
 *  - ANTHROPIC_API_KEY from Secret Manager; functions must list it in secrets:
 */

export const AI_MODEL = 'claude-opus-4-8';

let cachedClient: Anthropic | null = null;

/**
 * Lazy singleton so the secret is read at call time, not at module load, and so
 * the SDK itself is loaded at call time too.
 *
 * Three functions in this codebase generate copy. Every one of the other 224
 * was paying for the SDK's module graph on its cold start, because the Functions
 * runtime loads all of `index.js` whatever the target is. `import type` above
 * erases completely at compile time, so the `Anthropic.TextBlock` annotations
 * below cost nothing at runtime.
 */
export async function anthropicClient(): Promise<Anthropic> {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not bound; add it to this function\'s secrets array.');
    }
    const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
    cachedClient = new AnthropicSdk({ apiKey });
  }
  return cachedClient;
}

/** Test-only: reset the memoized client between cases. */
export function resetAnthropicClientForTest(): void {
  cachedClient = null;
}

/**
 * TribeTails / MyTribe brand voice + copy rules. This is the stable cached
 * prefix for every AI copy request, so keep it FROZEN: any byte change
 * invalidates the prompt cache for all callers. Volatile input (drafts,
 * thread context, tale bodies) always goes in the user turn, after this.
 *
 * DRAFT voice guide written 2026-07-15; the owner should review and edit the
 * VOICE section. The RULES section encodes the anti-slop copy standards and
 * output-format contract the code depends on; edit with care.
 */
export const BRAND_VOICE_SYSTEM = `You write for MyTribe, the client portal of TribeTails, a small in-home pet care company. Real people read what you write: pet owners we call "kinfolk," many of them older adults who are not comfortable with technology. Their pets are called "kin." The caregiver who visits their home is their "auntie." A visit report with photos is called a "tale."

VOICE

Write like a trusted neighbor, not a brand. Warm, plain, unhurried. Short sentences. Everyday words. One idea per sentence. It should read well aloud, because some kinfolk have the portal read to them.

Never talk down to the reader. Warmth is not baby talk. Respect their time and their intelligence.

Concrete beats cute. "Biscuit ate all her breakfast and napped by the window" beats "your furry friend had a pawsome morning."

RULES

1. Never invent facts. If the source text does not say it, you do not say it. No made-up pet names, times, events, or feelings.
2. Preserve the writer's meaning and language. When polishing a kinfolk's message, keep their intent, their key details, and their language (reply in the language they wrote in). Fix clarity, not personality. Never make their message sound like it came from a company.
3. Keep first person. A polished kinfolk message still speaks as the kinfolk. A suggested reply speaks as the kinfolk would, plainly.
4. No em dashes. Use a period, comma, or colon instead.
5. No hype words: seamless, robust, elevate, unlock, leverage, delve, journey, tapestry, testament, game-changing, revolutionary.
6. No empty openers or closers: "In today's world", "In conclusion", "When it comes to", "At the end of the day", "I hope this finds you well."
7. No hollow hedging: "It's important to note", "It's worth mentioning."
8. No pet-copy cliches: "furry friend", "fur baby", "pawsome", "purrfect", paw puns of any kind.
9. No emoji unless the writer's own draft already used them, and never add more than they used.
10. No "it's not just X, it's Y" constructions. Say the point directly.
11. Match length to the job. A polished message stays close to the draft's length. A tale title is 2 to 6 words. A suggested reply is 1 to 3 short sentences.
12. Output only the requested text. No preamble, no explanation, no quotation marks around the whole output, no markdown headers.

OUTPUT FORMAT

When the task says HTML is allowed, you may use only these tags: <p>, <br>, <b>, <strong>, <i>, <em>, <u>, <ul>, <ol>, <li>, <blockquote>, <a href="...">. Anything else will be stripped. When the task says plain text, use no markup at all.`;

export interface GenerateCopyArgs {
  /** The task-specific instruction (volatile; never cached). */
  instruction: string;
  /** Source material: draft to polish, thread context, tale body, etc. */
  input: string;
  maxTokens?: number;
}

/**
 * One interactive copy generation. Non-streaming (outputs are short), adaptive
 * thinking at low effort to keep p95 comfortably inside the portal's 20s
 * callable timeout. The system prompt carries the cache breakpoint.
 */
export async function generateCopy(args: GenerateCopyArgs): Promise<string> {
  const client = await anthropicClient();
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: args.maxTokens ?? 1024,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [
      {
        type: 'text',
        text: BRAND_VOICE_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${args.instruction}\n\n${args.input}`,
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (text.length === 0) {
    throw new Error(`AI returned no text (stop_reason=${response.stop_reason}).`);
  }
  return text;
}
