import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { emitKotlin, KotlinEmitError } from '../scripts/contracts/emitKotlin';
import { emitTypeScript } from '../scripts/contracts/emitTypeScript';
import { generateArtifacts } from '../scripts/contracts/artifacts';
import { ContractGenerationError, readModel } from '../scripts/contracts/readModel';
import { INVOICE_CONTRACT_REGISTRY, type ContractRegistry } from '../scripts/contracts/registry';

/**
 * The Contracts module codegen (ADR-0001 decisions 2 and 3).
 *
 * Two kinds of test, and the split is deliberate.
 *
 * GIVEN SCHEMA X, EMITS Y. Small hand-built schemas through the whole
 * pipeline, asserting the exact emitted line. Exact rather than "contains a
 * String somewhere", because the thing being pinned is the FAIL-SOFT FORM: the
 * generated Kotlin decoders replace `decodeInvoiceSettlement` and
 * `decodeInvoiceSessionLinks`, whose `.orEmpty()` / `?: 0L` / `mapNotNull`
 * behaviour on a junk payload is a money decision, not a style. A test that
 * accepted any decoder would let a regeneration quietly start throwing on a
 * response that arrives AFTER the write committed.
 *
 * AND IT REFUSES. Every unsupported construct gets a test proving the
 * generator stops with the field path in the message. A generator that
 * degrades quietly is worse than the hand-mirrors it replaces, so the refusals
 * are as much the product as the output is.
 *
 * The Kotlin decoders' RUNTIME behaviour is proven where Kotlin runs:
 * `auntieos-admin/android/app/src/test/.../InvoiceContractsGeneratedTest.kt`
 * feeds the generated decoders real junk maps.
 */

/** The repo root, from `mytribe/functions/test`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** A one-callable registry, for pinning one construct at a time. */
function registryOf(result: z.ZodType, args: z.ZodType | null = null): ContractRegistry {
  return { shared: [], callables: [{ name: 'sampleCallable', args, result }] };
}

function kotlinFor(result: z.ZodType, args: z.ZodType | null = null): string {
  return emitKotlin(readModel(registryOf(result, args)));
}

function typescriptFor(result: z.ZodType, args: z.ZodType | null = null): string {
  return emitTypeScript(readModel(registryOf(result, args)));
}

describe('contracts codegen: TypeScript', () => {
  it('emits a response interface with output semantics', () => {
    const ts = typescriptFor(z.object({ ok: z.literal(true), invoiceId: z.string() }).strict());
    expect(ts).toContain('export interface SampleCallableResult {\n  ok: true;\n  invoiceId: string;\n}');
  });

  it('marks a defaulted REQUEST field optional and a nullable one nullable', () => {
    const ts = typescriptFor(
      z.object({ kinfolkName: z.string().nullable() }).strict(),
      z.object({ kinfolkName: z.string().default(''), note: z.string().optional() }).strict(),
    );
    expect(ts).toContain("/** Optional in the request; the server defaults it to ''. */\n  kinfolkName?: string;");
    expect(ts).toContain('note?: string;');
    // Same field name, response side: the server always sends it.
    expect(ts).toContain('kinfolkName: string | null;');
  });

  it('renders enums, literals and records as unions', () => {
    const ts = typescriptFor(
      z
        .object({
          state: z.enum(['unpaid', 'partial']),
          target: z.literal('accountBalance'),
          skipped: z.record(z.enum(['no_total', 'no_payments']), z.number().int()),
          payload: z.record(z.string(), z.unknown()),
        })
        .strict(),
    );
    expect(ts).toContain("state: 'unpaid' | 'partial';");
    expect(ts).toContain("target: 'accountBalance';");
    expect(ts).toContain("skipped: Record<'no_total' | 'no_payments', number>;");
    expect(ts).toContain('payload: Record<string, unknown>;');
  });

  it('parenthesises an array of a union so the [] binds to the whole union', () => {
    const ts = typescriptFor(z.object({ states: z.array(z.enum(['a', 'b'])) }).strict());
    expect(ts).toContain("states: ('a' | 'b')[];");
  });

  it('says out loud when a callable has no request schema', () => {
    const ts = typescriptFor(z.object({ ok: z.literal(true) }).strict());
    expect(ts).toContain('No request type: `sampleCallable` has no zod request schema');
  });

  it('reports a cross-field refinement it cannot express', () => {
    const ts = typescriptFor(
      z.object({ ok: z.literal(true) }).strict(),
      z
        .object({ from: z.string(), to: z.string() })
        .strict()
        .refine((a) => a.from <= a.to),
    );
    expect(ts).toContain('The server also enforces a cross-field rule this type cannot express');
  });
});

describe('contracts codegen: Kotlin decoders', () => {
  it('fail-softs a string to "" and a nullable string to null, as the hand decoders do', () => {
    const kotlin = kotlinFor(z.object({ status: z.string(), note: z.string().nullable() }).strict());
    expect(kotlin).toContain('status = (raw?.get("status") as? String).orEmpty(),');
    expect(kotlin).toContain('note = raw?.get("note") as? String,');
  });

  it('reads an int as Long and a plain number as Double, each with its own zero', () => {
    const kotlin = kotlinFor(
      z.object({ totalCents: z.number().int(), amountDue: z.number() }).strict(),
    );
    expect(kotlin).toContain('val totalCents: Long,');
    expect(kotlin).toContain('val amountDue: Double,');
    expect(kotlin).toContain('totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,');
    expect(kotlin).toContain('amountDue = (raw?.get("amountDue") as? Number)?.toDouble() ?: 0.0,');
  });

  it('drops list entries of the wrong type instead of defaulting them into place', () => {
    const kotlin = kotlinFor(z.object({ added: z.array(z.string()) }).strict());
    expect(kotlin).toContain(
      'added = (raw?.get("added") as? List<*>).orEmpty().mapNotNull { it as? String },',
    );
  });

  it('decodes a list of objects through the nested decoder, dropping non-maps', () => {
    const kotlin = kotlinFor(
      z.object({ sessions: z.array(z.object({ sessionId: z.string() }).strict()) }).strict(),
    );
    expect(kotlin).toContain('data class SampleCallableResultSession(');
    expect(kotlin).toContain(
      'sessions = (raw?.get("sessions") as? List<*>).orEmpty()' +
        '.mapNotNull { contractRawMap(it)?.let { nested -> decodeSampleCallableResultSession(nested) } },',
    );
  });

  it('keeps an enum a String and puts the vocabulary in the KDoc', () => {
    const kotlin = kotlinFor(z.object({ state: z.enum(['unpaid', 'partial']) }).strict());
    expect(kotlin).toContain('/** One of `unpaid`, `partial`. `""` when the payload omits it. */');
    expect(kotlin).toContain('val state: String,');
  });

  it('decodes a record through a named helper that drops bad keys and values', () => {
    const kotlin = kotlinFor(
      z.object({ skipped: z.record(z.enum(['no_total']), z.number().int()) }).strict(),
    );
    expect(kotlin).toContain(
      'private fun decodeSampleCallableResultSkipped(value: Any?): Map<String, Long> =',
    );
    expect(kotlin).toContain('if (entryKey !is String) return@forEach');
    expect(kotlin).toContain('val decoded = (entryValue as? Number)?.toLong() ?: return@forEach');
    expect(kotlin).toContain('skipped = decodeSampleCallableResultSkipped(raw?.get("skipped")),');
  });

  it('never emits a decoder that can throw', () => {
    const kotlin = emitKotlin(readModel(INVOICE_CONTRACT_REGISTRY));
    expect(kotlin).not.toMatch(/\bthrow\b/);
    expect(kotlin).not.toMatch(/\berror\(/);
    // `as?`, never a hard `as` outside the one documented helper cast.
    const hardCasts = kotlin.match(/ as [A-Z]/g) ?? [];
    expect(hardCasts).toEqual([]);
  });
});

describe('contracts codegen: Kotlin encoders', () => {
  it('always sends a defaulted field and omits an optional one, matching recordPaymentPayload', () => {
    const kotlin = kotlinFor(
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ notes: z.string().default(''), method: z.string().optional() }).strict(),
    );
    expect(kotlin).toContain('val notes: String = "",');
    expect(kotlin).toContain('val method: String? = null,');
    expect(kotlin).toContain('put("notes", notes)');
    expect(kotlin).toContain('if (method != null) put("method", method)');
  });

  it('renders a default in the target type, not the schema literal', () => {
    // `.default(0)` is one JavaScript number and two different Kotlin literals.
    const kotlin = kotlinFor(
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ tip: z.number().default(0), limit: z.number().int().default(200) }).strict(),
    );
    expect(kotlin).toContain('val tip: Double = 0.0,');
    expect(kotlin).toContain('val limit: Long = 200L,');
  });

  it('encodes a nested object through its own toPayload', () => {
    const kotlin = kotlinFor(
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ patch: z.object({ terms: z.string().optional() }).strict() }).strict(),
    );
    expect(kotlin).toContain('put("patch", patch.toPayload())');
  });
});

describe('contracts codegen: refusals', () => {
  it('refuses a zod type with no faithful generated form, naming the path', () => {
    expect(() => kotlinFor(z.object({ paidAt: z.date() }).strict())).toThrowError(
      /sampleCallable\.Result\.paidAt: zod type 'date' has no faithful generated form/,
    );
    expect(() => kotlinFor(z.object({ who: z.union([z.string(), z.number()]) }).strict())).toThrow(
      ContractGenerationError,
    );
  });

  it('refuses nullable AND optional together, because Kotlin has one T?', () => {
    expect(() => kotlinFor(z.object({ note: z.string().nullable().optional() }).strict())).toThrowError(
      /sampleCallable\.Result\.note: is both \.nullable\(\) and \.optional\(\)/,
    );
  });

  it('refuses a numeric enum', () => {
    expect(() => kotlinFor(z.object({ tier: z.enum({ Low: 1, High: 2 }) }).strict())).toThrowError(
      /is not a string/,
    );
  });

  it('refuses a multi-value literal and points at z.enum', () => {
    expect(() => kotlinFor(z.object({ mode: z.literal(['a', 'b']) }).strict())).toThrowError(
      /multi-value z\.literal/,
    );
  });

  it('refuses a record keyed by anything but a string', () => {
    expect(() =>
      kotlinFor(z.object({ counts: z.record(z.number(), z.number()) }).strict()),
    ).toThrowError(/record keys of zod type 'number' are not generated/);
  });

  it('refuses a default no client can write out', () => {
    // A NON-EMPTY array default. `[]` is `emptyList()` in Kotlin and `[]` in
    // TypeScript; anything with contents would have to be reconstructed
    // element by element in two languages, so it stops here instead.
    expect(() =>
      kotlinFor(
        z.object({ ok: z.literal(true) }).strict(),
        z.object({ tags: z.array(z.string()).default(['billing']) }).strict(),
      ),
    ).toThrowError(/cannot render the zod default \["billing"\]/);
  });

  it('refuses a default whose value does not fit the generated Kotlin type', () => {
    // Reaches the KOTLIN emitter rather than the reader: the value is
    // renderable in the abstract, just not as a Long.
    expect(() =>
      kotlinFor(
        z.object({ ok: z.literal(true) }).strict(),
        z.object({ limit: z.number().int().default(1.5) }).strict(),
      ),
    ).toThrowError(KotlinEmitError);
  });

  it('refuses an array of arrays rather than emitting shadowed lambdas', () => {
    expect(() => kotlinFor(z.object({ rows: z.array(z.array(z.string())) }).strict())).toThrowError(
      KotlinEmitError,
    );
  });

  it('refuses two different schemas competing for one generated name', () => {
    const clash: ContractRegistry = {
      shared: [],
      callables: [
        { name: 'sampleCallable', args: null, result: z.object({ a: z.string() }).strict() },
        { name: 'sampleCallable', args: null, result: z.object({ b: z.string() }).strict() },
      ],
    };
    expect(() => readModel(clash)).toThrowError(/both want the generated name 'SampleCallableResult'/);
  });
});

describe('the committed Contracts module', () => {
  const artifacts = generateArtifacts(INVOICE_CONTRACT_REGISTRY);

  it('covers every callable in the registry, both directions where a schema exists', () => {
    const model = readModel(INVOICE_CONTRACT_REGISTRY);
    expect(model.callables).toHaveLength(20);
    // getMyInvoices is the only one with no zod request schema; see the
    // registry header.
    const withoutArgs = model.callables.filter((c) => c.argsObject === null).map((c) => c.name);
    expect(withoutArgs).toEqual(['getMyInvoices']);
  });

  it('ships one TypeScript text to both web clients and one Kotlin file to Android', () => {
    expect(artifacts).toHaveLength(3);
    const [portal, admin, android] = artifacts;
    expect(portal!.contents).toBe(admin!.contents);
    expect(android!.path.endsWith('.kt')).toBe(true);
    for (const artifact of artifacts) {
      expect(artifact.contents.startsWith('// GENERATED FILE. DO NOT EDIT.')).toBe(true);
      expect(artifact.contents).toContain(
        'npm --prefix mytribe/functions run contracts:generate',
      );
    }
  });

  it('matches what is on disk, so `npm test` catches an unregenerated schema change', () => {
    for (const artifact of artifacts) {
      const onDisk = readFileSync(join(REPO_ROOT, artifact.path), 'utf8');
      expect(onDisk, `${artifact.path} is stale; run npm run contracts:generate`).toBe(
        artifact.contents,
      );
    }
  });
});
