/**
 * The intermediate representation the Contracts module is emitted from
 * (CONTEXT.md, ADR-0001 decision 2).
 *
 * One shape, two emitters. The zod reader (`readModel.ts`) is the only file
 * that touches zod internals, and the emitters (`emitTypeScript.ts`,
 * `emitKotlin.ts`) are the only files that know a target language. Nothing
 * reads a zod schema and writes source in the same function, so a bug is
 * either "the model is wrong" or "the emitter is wrong" and a stack trace
 * says which.
 *
 * The IR is deliberately narrow. It carries what a client type needs and
 * nothing else: no `min`/`max`, no regex, no refinement predicate. Those are
 * SERVER rules. A client that mirrored them would own a second copy of a rule
 * it cannot enforce, which is the drift ADR-0001 exists to end.
 */

/** A leaf or container type, with nullability carried on the field instead. */
export type ContractType =
  | { kind: 'string' }
  /** `z.enum([...])` over string members. The vocabulary travels for the docs. */
  | { kind: 'enum'; values: string[] }
  /** `z.literal('x')`. One permitted string. */
  | { kind: 'stringLiteral'; value: string }
  /** `z.literal(true)`. The `ok` field of half this surface. */
  | { kind: 'booleanLiteral'; value: boolean }
  /** `z.number().int()`. Kotlin `Long`. */
  | { kind: 'integer' }
  /** `z.number()` without an int check: legacy dollars, epoch millis, quantities. */
  | { kind: 'double' }
  | { kind: 'boolean' }
  /** `z.unknown()` / `z.any()`: the schema asserts nothing, so neither does the type. */
  | { kind: 'unknown' }
  | { kind: 'array'; element: ContractType }
  /** `z.record(k, v)`. `keys` is the enum vocabulary, or null for open string keys. */
  | { kind: 'record'; keys: string[] | null; value: ContractType }
  /** A named object declared elsewhere in the model. */
  | { kind: 'objectRef'; name: string };

/** One field of one generated type. */
export interface ContractField {
  name: string;
  type: ContractType;
  /** `.nullable()`: the key is present and its value may be `null`. */
  nullable: boolean;
  /** `.optional()` or `.default()`: the key may be absent from the payload. */
  optional: boolean;
  /**
   * The server's `.default(...)` value, or null when the field has no default.
   * Held raw and rendered by each emitter, because the same JavaScript `0` is
   * `0L` against an integer field and `0.0` against a dollars one.
   *
   * An optional field WITH a default is never absent from a generated Kotlin
   * payload: the client sends the same value the server would have filled in,
   * which is the `recordPaymentPayload` convention.
   */
  defaultValue: { value: unknown } | null;
}

/** One generated data class / interface. */
export interface ContractObject {
  name: string;
  fields: ContractField[];
  /**
   * The zod object carries a cross-field `.refine` / `.superRefine`. The
   * predicate is NOT generated (see the module header); the flag exists so the
   * emitted doc comment says the server enforces a rule this type cannot.
   */
  refined: boolean;
  /** Reached from a request schema, so it needs an encoder. */
  encoded: boolean;
  /** Reached from a response schema, so it needs a decoder. */
  decoded: boolean;
}

/** One callable's two directions. */
export interface ContractCallable {
  name: string;
  /**
   * Objects introduced by this callable, nested-first. Null `argsObject` means
   * the callable has no zod request schema at all, which the emitters say out
   * loud rather than passing over.
   */
  objects: ContractObject[];
  argsObject: string | null;
  resultObject: string;
}

/** Everything the emitters need, and nothing about zod. */
export interface ContractModel {
  /** Objects named once and referenced from several callables. */
  shared: ContractObject[];
  callables: ContractCallable[];
}

/** Every object in the model, shared first, then per callable in order. */
export function allObjects(model: ContractModel): ContractObject[] {
  return [...model.shared, ...model.callables.flatMap((c) => c.objects)];
}
