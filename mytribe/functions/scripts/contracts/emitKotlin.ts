/**
 * `ContractModel` -> the Kotlin half of the Contracts module, for the Android
 * admin (ADR-0001 decision 2).
 *
 * This is the half that replaces real code. Android decodes callable payloads
 * by hand today (`decodeInvoiceSettlement`, `decodeInvoiceSessionLinks`,
 * `recordPaymentPayload` in `InvoiceRepository.kt`), and the generated
 * encoders and decoders below are written to the same conventions, so
 * adoption is a swap rather than a rewrite:
 *
 *   - A decoder takes the raw `Map<String, Any?>?` the Firebase callable SDK
 *     hands back, and is a pure function of it. No Firebase types, no
 *     coroutines, so a unit test needs no Firebase static init.
 *   - IT NEVER THROWS. A junk payload decodes to neutral values, exactly as
 *     the hand decoders do: a missing string is `""`, a missing number is 0, a
 *     missing list is empty, and a list entry of the wrong type is DROPPED
 *     rather than defaulted into place. A callable response arrives after the
 *     server write already committed, so a decoder that threw would report a
 *     committed money write as a failure and every client in this repo renders
 *     a failure as a retry affordance.
 *   - An encoder is `toPayload()`, a pure `Map<String, Any?>` mirroring
 *     `recordPaymentPayload` field for field.
 *
 * WHAT IT WILL NOT DO IS INVENT A SEMANTIC DEFAULT. `decodeInvoiceSettlement`
 * fail-softs an unreadable `state` to `"partial"`, not to `""`, because on
 * this surface "we could not read the answer" has to mean "money may still be
 * owed". That ruling is nowhere in the zod schema and a generator that guessed
 * it would be guessing about money. The generated decoders produce the neutral
 * value; a call site that needs a different one supplies it, in the open,
 * where a reviewer can see it.
 *
 * Enums become `String`, not a Kotlin `enum class`, matching the hand
 * decoders' `status: String` / `editScope: String`. The vocabulary travels in
 * the KDoc, which is where `InvoiceSessionLinks` already keeps it.
 */
import type { ContractField, ContractModel, ContractObject, ContractType } from './model';
import { bannerComment } from './header';

/** Where the schemas live, for the banner. */
const SOURCE_DESCRIPTION = 'mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)';

/** The Android package the file is emitted into. */
export const KOTLIN_PACKAGE = 'com.tribetails.auntieos.data.contracts';

/** Refusal, matching `readModel.ts`'s: name the path, never approximate. */
export class KotlinEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KotlinEmitError';
  }
}

/** The Kotlin type for a contract type, before nullability. */
function baseType(type: ContractType, path: string): string {
  switch (type.kind) {
    case 'string':
    case 'enum':
    case 'stringLiteral':
      return 'String';
    case 'boolean':
    case 'booleanLiteral':
      return 'Boolean';
    case 'integer':
      return 'Long';
    case 'double':
      return 'Double';
    case 'unknown':
      return 'Any?';
    case 'array':
      return `List<${baseType(type.element, `${path}[]`)}>`;
    case 'record':
      return `Map<String, ${baseType(type.value, `${path}[key]`)}>`;
    case 'objectRef':
      return type.name;
  }
}

function renderType(type: ContractType, nullable: boolean, path: string): string {
  const base = baseType(type, path);
  // `Any?` is already the widest type there is; a second `?` does not parse.
  if (base === 'Any?' || !nullable) return base;
  return `${base}?`;
}

/** True when a field's Kotlin type must be nullable. */
function isNullableInKotlin(field: ContractField): boolean {
  return field.nullable || (field.optional && field.defaultValue === null);
}

/** A zod `.default(x)` as Kotlin source, or a refusal when the two disagree. */
function renderDefault(type: ContractType, value: unknown, path: string): string {
  const mismatch = (): never => {
    throw new KotlinEmitError(
      `${path}: the zod default ${JSON.stringify(value)} does not fit the generated ` +
        `Kotlin type '${baseType(type, path)}'.`,
    );
  };
  switch (type.kind) {
    case 'string':
    case 'enum':
    case 'stringLiteral':
      return typeof value === 'string' ? JSON.stringify(value) : mismatch();
    case 'boolean':
    case 'booleanLiteral':
      return typeof value === 'boolean' ? String(value) : mismatch();
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? `${value}L` : mismatch();
    case 'double':
      if (typeof value !== 'number') return mismatch();
      return Number.isInteger(value) ? `${value}.0` : String(value);
    case 'array':
      return Array.isArray(value) && value.length === 0 ? 'emptyList()' : mismatch();
    case 'record':
      return value !== null && typeof value === 'object' && Object.keys(value).length === 0
        ? 'emptyMap()'
        : mismatch();
    case 'unknown':
    case 'objectRef':
      return mismatch();
  }
}

/**
 * Reads one wire value into one Kotlin value.
 *
 * `nullable` here means "produce null when the value is missing or the wrong
 * type", which is what a `mapNotNull` element needs as well as a nullable
 * field. The non-nullable forms end in the neutral fallback the hand decoders
 * use.
 */
function decodeExpr(type: ContractType, access: string, nullable: boolean, path: string): string {
  switch (type.kind) {
    case 'string':
    case 'enum':
    case 'stringLiteral':
      return nullable ? `${access} as? String` : `(${access} as? String).orEmpty()`;
    case 'boolean':
    case 'booleanLiteral':
      return nullable ? `${access} as? Boolean` : `${access} as? Boolean ?: false`;
    case 'integer':
      return nullable
        ? `(${access} as? Number)?.toLong()`
        : `(${access} as? Number)?.toLong() ?: 0L`;
    case 'double':
      return nullable
        ? `(${access} as? Number)?.toDouble()`
        : `(${access} as? Number)?.toDouble() ?: 0.0`;
    case 'unknown':
      return access;
    case 'objectRef':
      return nullable
        ? `contractRawMap(${access})?.let { nested -> decode${type.name}(nested) }`
        : `decode${type.name}(contractRawMap(${access}))`;
    case 'array': {
      if (type.element.kind === 'array' || type.element.kind === 'record') {
        throw new KotlinEmitError(
          `${path}: an array of ${type.element.kind}s needs nested lambdas whose \`it\` would ` +
            `shadow. No schema on this surface has one; add the emitter support with the ` +
            `schema that needs it.`,
        );
      }
      const list = `(${access} as? List<*>)`;
      // An `unknown` element has nothing to check, so the list travels as-is
      // rather than through a `mapNotNull` that would drop legitimate nulls.
      const entries = type.element.kind === 'unknown' ? '' : elementMapping(type.element, path);
      if (entries === '') return nullable ? list : `${list}.orEmpty()`;
      return nullable ? `${list}?${entries}` : `${list}.orEmpty()${entries}`;
    }
    case 'record':
      // Emitted as its own named helper; see `recordHelper`.
      throw new KotlinEmitError(`${path}: records are decoded through a generated helper.`);
  }
}

/** `.mapNotNull { ... }` for an array's elements, dropping entries of the wrong type. */
function elementMapping(element: ContractType, path: string): string {
  return `.mapNotNull { ${decodeExpr(element, 'it', true, `${path}[]`)} }`;
}

/** Writes one Kotlin value back onto the wire. */
function encodeExpr(type: ContractType, access: string, nullable: boolean, path: string): string {
  const call = nullable ? '?.' : '.';
  switch (type.kind) {
    case 'objectRef':
      return `${access}${call}toPayload()`;
    case 'array':
      if (type.element.kind === 'objectRef') {
        return `${access}${call}map { it.toPayload() }`;
      }
      if (type.element.kind === 'array' || type.element.kind === 'record') {
        throw new KotlinEmitError(
          `${path}: an array of ${type.element.kind}s is not encoded. No schema on this ` +
            `surface has one.`,
        );
      }
      return access;
    case 'record':
      if (type.value.kind === 'objectRef') {
        throw new KotlinEmitError(
          `${path}: a record of objects is not encoded. No schema on this surface has one.`,
        );
      }
      return access;
    default:
      return access;
  }
}

/** The KDoc sentences a field earns, or an empty list. */
function fieldDoc(field: ContractField, direction: 'request' | 'response', path: string): string[] {
  const doc: string[] = [];
  if (field.type.kind === 'enum') {
    const vocabulary = field.type.values.map((value) => `\`${value}\``).join(', ');
    // The "when the payload omits it" half is a DECODE fact and belongs only on
    // a response field; a request field is written by the caller, not read.
    if (direction === 'request') doc.push(`One of ${vocabulary}.`);
    else if (isNullableInKotlin(field)) {
      doc.push(`One of ${vocabulary}, or null when the payload omits it.`);
    } else doc.push(`One of ${vocabulary}. \`""\` when the payload omits it.`);
  }
  if (field.type.kind === 'stringLiteral') {
    doc.push(`Always \`${field.type.value}\` on the wire.`);
  }
  if (field.type.kind === 'record' && field.type.keys !== null) {
    // The key vocabulary is a zod enum the Kotlin `Map<String, _>` cannot hold.
    doc.push(`Keys: ${field.type.keys.map((key) => `\`${key}\``).join(', ')}.`);
  }
  if (field.defaultValue !== null) {
    doc.push(
      `The server defaults this to \`${renderDefault(field.type, field.defaultValue.value, path)}\`.`,
    );
  } else if (field.optional) {
    doc.push(
      direction === 'request'
        ? 'Optional: omitted from the payload when null.'
        : 'Null when the payload omits the key.',
    );
  }
  return doc;
}

function kdoc(lines: string[], indent: string): string[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`];
}

/** The private helper a record-valued field is decoded through. */
interface RecordHelper {
  name: string;
  source: string;
}

function recordHelper(
  object: ContractObject,
  field: ContractField,
  path: string,
): RecordHelper | null {
  if (field.type.kind !== 'record') return null;
  if (isNullableInKotlin(field)) {
    throw new KotlinEmitError(
      `${path}: a nullable or optional record is not decoded. No schema on this surface has one.`,
    );
  }
  const valueType = field.type.value;
  if (valueType.kind === 'array' || valueType.kind === 'record') {
    throw new KotlinEmitError(
      `${path}: a record of ${valueType.kind}s is not decoded. No schema on this surface has one.`,
    );
  }
  const name = `decode${object.name}${field.name[0]!.toUpperCase()}${field.name.slice(1)}`;
  const kotlinValue = baseType(valueType, path);
  const body =
    valueType.kind === 'unknown'
      ? ['            put(entryKey, entryValue)']
      : [
          `            val decoded = ${decodeExpr(valueType, 'entryValue', true, path)} ?: return@forEach`,
          '            put(entryKey, decoded)',
        ];
  const source = [
    ...kdoc(
      [
        `The \`${field.name}\` map of [${object.name}].`,
        'Entries whose key or value is the wrong type are dropped, never defaulted.',
      ],
      '',
    ),
    `private fun ${name}(value: Any?): Map<String, ${kotlinValue}> =`,
    `    buildMap<String, ${kotlinValue}> {`,
    '        (value as? Map<*, *>)?.forEach { (entryKey, entryValue) ->',
    '            if (entryKey !is String) return@forEach',
    ...body,
    '        }',
    '    }',
  ].join('\n');
  return { name, source };
}

function renderDataClass(object: ContractObject, doc: string[]): string {
  const direction: 'request' | 'response' = object.encoded && !object.decoded ? 'request' : 'response';
  const docLines = [...doc];
  if (object.refined) {
    docLines.push(
      'The server also enforces a cross-field rule this class cannot express (zod .refine);',
      'a payload that satisfies these types can still be refused.',
    );
  }

  const params = object.fields.flatMap((field) => {
    const path = `${object.name}.${field.name}`;
    const nullable = isNullableInKotlin(field);
    const type = renderType(field.type, nullable, path);
    const suffix =
      field.defaultValue !== null
        ? ` = ${renderDefault(field.type, field.defaultValue.value, path)}`
        : nullable && field.optional
          ? ' = null'
          : '';
    return [
      ...kdoc(fieldDoc(field, direction, path), '    '),
      `    val ${field.name}: ${type}${suffix},`,
    ];
  });

  const body = [...kdoc(docLines, ''), `data class ${object.name}(`, ...params];

  if (!object.encoded) return [...body, ')'].join('\n');

  const puts = object.fields.map((field) => {
    const path = `${object.name}.${field.name}`;
    const key = JSON.stringify(field.name);
    // A field that is optional AND has no server default is genuinely absent
    // when null; one WITH a default always ships, so the client sends the same
    // value the server would have filled in.
    if (field.optional && field.defaultValue === null) {
      // Inside the guard the property smart-casts to non-null, so the encode
      // expression drops the safe call rather than emitting a redundant one.
      return `        if (${field.name} != null) put(${key}, ${encodeExpr(field.type, field.name, false, path)})`;
    }
    return `        put(${key}, ${encodeExpr(field.type, field.name, isNullableInKotlin(field), path)})`;
  });

  return [
    ...body,
    ') {',
    ...kdoc(
      [
        'The wire payload for this request, in the `recordPaymentPayload` convention:',
        'a pure map, no Firebase types, so a test can assert it without static init.',
      ],
      '    ',
    ),
    '    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {',
    ...puts,
    '    }',
    '}',
  ].join('\n');
}

function renderDecoder(object: ContractObject, helpers: Map<string, string>): string {
  const assignments = object.fields.map((field) => {
    const path = `${object.name}.${field.name}`;
    const access = `raw?.get(${JSON.stringify(field.name)})`;
    const helper = helpers.get(field.name);
    const expr = helper
      ? `${helper}(${access})`
      : decodeExpr(field.type, access, isNullableInKotlin(field), path);
    return `        ${field.name} = ${expr},`;
  });
  return [
    ...kdoc(
      [
        `Fail-soft decode of \`${object.name}\` from a callable payload.`,
        'Pure, and it never throws: a missing or wrong-typed value falls back to the',
        'neutral one for its type, and a list entry of the wrong type is dropped.',
      ],
      '',
    ),
    `internal fun decode${object.name}(raw: Map<String, Any?>?): ${object.name} =`,
    `    ${object.name}(`,
    ...assignments,
    '    )',
  ].join('\n');
}

function renderObject(object: ContractObject, doc: string[]): string[] {
  const blocks: string[] = [];
  const helpers = new Map<string, string>();
  if (object.decoded) {
    for (const field of object.fields) {
      const helper = recordHelper(object, field, `${object.name}.${field.name}`);
      if (helper) {
        helpers.set(field.name, helper.name);
        blocks.push(helper.source);
      }
    }
  }
  blocks.push(renderDataClass(object, doc));
  if (object.decoded) blocks.push(renderDecoder(object, helpers));
  return blocks;
}

/** Renders the whole model as one Kotlin file. */
export function emitKotlin(model: ContractModel): string {
  const blocks: string[] = [
    bannerComment(SOURCE_DESCRIPTION),
    // The Firebase callable SDK hands back `Any?`; every cast below is the one
    // the hand-written repositories already make on `HttpsCallableResult.data`.
    '@file:Suppress("UNCHECKED_CAST")',
    `package ${KOTLIN_PACKAGE}`,
    [
      '/**',
      ' * A nested payload object, or null when the wire value is not a map.',
      ' *',
      ' * The cast is unchecked because a JSON map arrives as `Map<*, *>` with no element',
      ' * types; every value read out of it is re-checked one field at a time below.',
      ' */',
      'private fun contractRawMap(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>',
    ].join('\n'),
  ];

  if (model.shared.length > 0) {
    blocks.push('// ---------- Types shared by more than one callable ----------');
    for (const object of model.shared) {
      blocks.push(...renderObject(object, [`\`${object.name}\`, shared across callables.`]));
    }
  }

  for (const callable of model.callables) {
    blocks.push(`// ---------- ${callable.name} ----------`);
    if (callable.argsObject === null) {
      blocks.push(
        `// No request class: \`${callable.name}\` has no zod request schema on the server,\n` +
          '// so there is no authority to generate one from.',
      );
    }
    for (const object of callable.objects) {
      const role =
        object.name === callable.argsObject
          ? `Request payload for the \`${callable.name}\` callable.`
          : object.name === callable.resultObject
            ? `Response from the \`${callable.name}\` callable.`
            : `Nested in the \`${callable.name}\` contract.`;
      blocks.push(...renderObject(object, [role]));
    }
  }

  return `${blocks.join('\n\n')}\n`;
}
