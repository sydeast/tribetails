/**
 * zod schema -> `ContractModel` (ADR-0001 decision 2). The ONLY file in the
 * generator that touches zod internals.
 *
 * It reads `_zod.def` rather than re-parsing the TypeScript source, because
 * the schema OBJECT is the authority the ADR names. Source parsing would agree
 * with the runtime right up to the first `z.enum(INVOICE_STATES)` built from a
 * constant, and that constant is exactly how the eight-state vocabulary is
 * kept in one place.
 *
 * IT REFUSES RATHER THAN APPROXIMATES. Every unsupported construct throws a
 * `ContractGenerationError` naming the field path and the zod type, so a new
 * `z.union` on a response schema stops the build with a message a reader can
 * act on. The alternative is emitting something plausible: a union flattened to
 * `String`, a `z.date()` guessed as `Long`. A client decoder built on a guess
 * is worse than the hand-mirror it replaces, because the hand-mirror at least
 * had an author who read the schema.
 *
 * What is deliberately NOT read:
 *   - JSDoc. Comments are source, not runtime, so the generated types carry
 *     structure and vocabulary but not the prose reasoning beside each server
 *     field. Read the schema for the why.
 *   - `.min` / `.max` / `.regex` / refinement predicates. Server rules; see
 *     the `model.ts` header.
 */
import type {
  ContractCallable,
  ContractField,
  ContractModel,
  ContractObject,
  ContractType,
} from './model';
import type { CallableContract, ContractRegistry, SharedContractSchema } from './registry';

/** A refusal, always naming the path that caused it. */
export class ContractGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractGenerationError';
  }
}

/** Which direction a schema was reached from, which decides encoder vs decoder. */
type Direction = 'request' | 'response';

/**
 * zod 4's internal descriptor. Untyped on purpose: the shapes below are
 * checked one `def.type` at a time, and a wrong guess lands in the `default`
 * refusal rather than in the output.
 */
interface ZodDef {
  type: string;
  [key: string]: unknown;
}

function defOf(schema: unknown, path: string): ZodDef {
  const def = (schema as { _zod?: { def?: ZodDef } } | null)?._zod?.def;
  if (!def || typeof def.type !== 'string') {
    throw new ContractGenerationError(`${path}: not a zod schema (no _zod.def.type).`);
  }
  return def;
}

/** `invoiceId` -> `InvoiceId`. */
function pascal(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

/**
 * `lineItems` -> `lineItem`, for naming an array's ELEMENT type.
 *
 * Deliberately the dumbest rule that reads correctly on this surface: drop one
 * trailing `s` unless the word ends in `ss`. `sessions` -> `session`,
 * `findings` -> `finding`, `credits` -> `credit`, `unpriceable` -> unchanged.
 * A plural this rule mangles is a naming problem to fix in the schema or to
 * pin with a shared name in the registry, not a reason to teach the generator
 * English.
 */
function singular(name: string): string {
  return name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name;
}

/**
 * Refuses a `.default(x)` no emitter can write out, at the point the schema is
 * read rather than halfway through a file. Rendering itself is each emitter's
 * job: the same `0` is `0L` against an integer field and `0.0` against a
 * dollars one.
 */
function checkDefaultValue(value: unknown, path: string): { value: unknown } {
  const renderable =
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.length === 0);
  if (!renderable) {
    throw new ContractGenerationError(
      `${path}: cannot render the zod default ${JSON.stringify(value)} in the generated ` +
        `clients. Supported defaults are strings, finite numbers, booleans and the empty array.`,
    );
  }
  return { value };
}

interface Unwrapped {
  inner: unknown;
  nullable: boolean;
  optional: boolean;
  defaultValue: { value: unknown } | null;
}

/**
 * Peels `.optional()` / `.nullable()` / `.default()` off a field schema.
 *
 * NULLABLE AND OPTIONAL TOGETHER IS A REFUSAL. Kotlin has one `T?` and it
 * would have to stand for both "the key is absent" and "the key is present and
 * null". On a REQUEST those are different calls: omitting `patch.terms` leaves
 * the stored value alone, sending `terms: null` would try to write null. No
 * schema on this surface does it today, and a generated type that quietly
 * conflated them would be found by a household getting the wrong invoice.
 */
function unwrap(schema: unknown, path: string): Unwrapped {
  let inner = schema;
  let nullable = false;
  let optional = false;
  let defaultValue: { value: unknown } | null = null;

  for (;;) {
    const def = defOf(inner, path);
    if (def.type === 'optional') {
      optional = true;
      inner = def.innerType;
    } else if (def.type === 'nullable') {
      nullable = true;
      inner = def.innerType;
    } else if (def.type === 'default') {
      optional = true;
      if (defaultValue === null) defaultValue = { value: def.defaultValue };
      inner = def.innerType;
    } else {
      break;
    }
  }

  if (nullable && optional) {
    throw new ContractGenerationError(
      `${path}: is both .nullable() and .optional(). Kotlin's one nullable type cannot ` +
        `distinguish an absent key from a present null, and on a request those mean ` +
        `different writes. Pick one in the server schema.`,
    );
  }
  return { inner, nullable, optional, defaultValue };
}

/** True for `z.number().int()` and its siblings; false for a plain `z.number()`. */
function isIntegerNumber(def: ZodDef): boolean {
  const checks = Array.isArray(def.checks) ? def.checks : [];
  return checks.some((check) => {
    const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    return checkDef?.check === 'number_format' && String(checkDef?.format ?? '').includes('int');
  });
}

/** True when an object carries a `.refine` / `.superRefine`. */
function isRefined(def: ZodDef): boolean {
  return Array.isArray(def.checks) && def.checks.length > 0;
}

class ModelReader {
  private readonly objectsByRef = new Map<unknown, ContractObject>();
  private readonly namesInUse = new Map<string, unknown>();
  private readonly shared: ContractObject[] = [];
  private sink: ContractObject[] = this.shared;

  read(registry: ContractRegistry): ContractModel {
    for (const entry of registry.shared) this.readShared(entry);

    const callables: ContractCallable[] = [];
    for (const contract of registry.callables) {
      callables.push(this.readCallable(contract));
    }
    return { shared: this.shared, callables };
  }

  private readShared(entry: SharedContractSchema): void {
    this.sink = this.shared;
    this.objectType(entry.schema, entry.name, entry.direction, entry.name);
  }

  private readCallable(contract: CallableContract): ContractCallable {
    const objects: ContractObject[] = [];
    this.sink = objects;
    const root = pascal(contract.name);
    const argsObject = contract.args
      ? this.objectType(contract.args, `${root}Args`, 'request', `${contract.name}.Args`)
      : null;
    const resultObject = this.objectType(
      contract.result,
      `${root}Result`,
      'response',
      `${contract.name}.Result`,
    );
    return { name: contract.name, objects, argsObject, resultObject };
  }

  /** Names an object schema (or reuses the existing name) and returns that name. */
  private objectType(
    schema: unknown,
    proposedName: string,
    direction: Direction,
    path: string,
  ): string {
    const def = defOf(schema, path);
    if (def.type !== 'object') {
      throw new ContractGenerationError(
        `${path}: expected a zod object at the root, found '${def.type}'.`,
      );
    }

    const existing = this.objectsByRef.get(schema);
    if (existing) {
      this.mark(existing, direction);
      return existing.name;
    }

    const claimedBy = this.namesInUse.get(proposedName);
    if (claimedBy !== undefined && claimedBy !== schema) {
      throw new ContractGenerationError(
        `${path}: two different schemas both want the generated name '${proposedName}'. ` +
          `Give one of them an explicit name in the registry's shared list.`,
      );
    }
    this.namesInUse.set(proposedName, schema);

    const object: ContractObject = {
      name: proposedName,
      fields: [],
      refined: isRefined(def),
      encoded: false,
      decoded: false,
    };
    this.objectsByRef.set(schema, object);
    this.mark(object, direction);

    const shape = def.shape as Record<string, unknown>;
    const sink = this.sink;
    object.fields = Object.entries(shape).map(([fieldName, fieldSchema]) =>
      this.field(fieldName, fieldSchema, proposedName, direction, `${path}.${fieldName}`),
    );
    // Appended AFTER its fields, so nested types are declared before the type
    // that uses them and the generated file reads top-down.
    sink.push(object);
    return proposedName;
  }

  private mark(object: ContractObject, direction: Direction): void {
    if (direction === 'request') object.encoded = true;
    else object.decoded = true;
  }

  private field(
    name: string,
    schema: unknown,
    ownerName: string,
    direction: Direction,
    path: string,
  ): ContractField {
    const { inner, nullable, optional, defaultValue } = unwrap(schema, path);
    return {
      name,
      type: this.type(inner, `${ownerName}${pascal(name)}`, direction, path),
      nullable,
      optional,
      defaultValue: defaultValue ? checkDefaultValue(defaultValue.value, path) : null,
    };
  }

  private type(
    schema: unknown,
    proposedName: string,
    direction: Direction,
    path: string,
  ): ContractType {
    const def = defOf(schema, path);
    switch (def.type) {
      case 'string':
        return { kind: 'string' };
      case 'boolean':
        return { kind: 'boolean' };
      case 'number':
        return isIntegerNumber(def) ? { kind: 'integer' } : { kind: 'double' };
      case 'unknown':
      case 'any':
        return { kind: 'unknown' };
      case 'enum':
        return { kind: 'enum', values: this.enumValues(def, path) };
      case 'literal':
        return this.literalType(def, path);
      case 'array':
        return {
          kind: 'array',
          element: this.type(def.element, singular(proposedName), direction, `${path}[]`),
        };
      case 'record':
        return this.recordType(def, proposedName, direction, path);
      case 'object':
        return {
          kind: 'objectRef',
          name: this.objectType(schema, proposedName, direction, path),
        };
      default:
        throw new ContractGenerationError(
          `${path}: zod type '${def.type}' has no faithful generated form. ` +
            `Express the field with a supported construct, or teach readModel.ts what ` +
            `'${def.type}' should become in BOTH TypeScript and Kotlin.`,
        );
    }
  }

  private enumValues(def: ZodDef, path: string): string[] {
    const values = Object.values((def.entries ?? {}) as Record<string, unknown>);
    if (values.length === 0) {
      throw new ContractGenerationError(`${path}: enum has no members.`);
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new ContractGenerationError(
          `${path}: enum member ${JSON.stringify(value)} is not a string. Only string ` +
            `enums are generated; a numeric enum would decode differently in each client.`,
        );
      }
    }
    return values as string[];
  }

  private literalType(def: ZodDef, path: string): ContractType {
    const values = (def.values ?? []) as unknown[];
    if (values.length !== 1) {
      throw new ContractGenerationError(
        `${path}: multi-value z.literal([...]) is not generated. Use z.enum for a ` +
          `vocabulary so the members are named in one place.`,
      );
    }
    const [value] = values;
    if (typeof value === 'string') return { kind: 'stringLiteral', value };
    if (typeof value === 'boolean') return { kind: 'booleanLiteral', value };
    throw new ContractGenerationError(
      `${path}: z.literal(${JSON.stringify(value)}) is neither a string nor a boolean.`,
    );
  }

  private recordType(
    def: ZodDef,
    proposedName: string,
    direction: Direction,
    path: string,
  ): ContractType {
    const keyDef = defOf(def.keyType, `${path} (record key)`);
    let keys: string[] | null;
    if (keyDef.type === 'string') keys = null;
    else if (keyDef.type === 'enum') keys = this.enumValues(keyDef, `${path} (record key)`);
    else {
      throw new ContractGenerationError(
        `${path}: record keys of zod type '${keyDef.type}' are not generated. ` +
          `Callable payloads travel as JSON, so a key is a string or a string enum.`,
      );
    }
    return {
      kind: 'record',
      keys,
      value: this.type(def.valueType, `${proposedName}Value`, direction, `${path}[key]`),
    };
  }
}

/** Reads the whole registry into the IR, or throws naming the first refusal. */
export function readModel(registry: ContractRegistry): ContractModel {
  return new ModelReader().read(registry);
}
