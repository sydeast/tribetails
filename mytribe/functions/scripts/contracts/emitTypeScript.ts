/**
 * `ContractModel` -> the TypeScript half of the Contracts module, for the
 * kinfolk portal and the AuntieOS admin (ADR-0001 decision 2).
 *
 * TYPES ONLY, no runtime values. The file compiles to nothing, adds nothing to
 * either bundle, and cannot itself misbehave in a browser. The web clients
 * already validate nothing on the wire and would not start doing so because a
 * generator emitted a validator; what they lack is a type that cannot drift
 * from the server, and that is what this is.
 *
 * REQUEST types are the INPUT side of the schema: a field with `.default('')`
 * is optional here, because the caller may omit it and the server fills it in.
 * RESPONSE types are the output side, where the same field is always present.
 * Emitting one type for both would make every defaulted request field look
 * mandatory to the composer that builds the payload.
 */
import type { ContractField, ContractModel, ContractObject, ContractType } from './model';
import { bannerComment } from './header';

/** Where the schemas live, for the banner. */
const SOURCE_DESCRIPTION = 'mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)';

/** A single-quoted TS string literal, matching the repo's prettier settings. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Renders a type, parenthesised where an array suffix would bind wrong. */
function renderType(type: ContractType): string {
  switch (type.kind) {
    case 'string':
      return 'string';
    case 'enum':
      return type.values.map(quote).join(' | ');
    case 'stringLiteral':
      return quote(type.value);
    case 'booleanLiteral':
      return String(type.value);
    case 'integer':
    case 'double':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'unknown':
      return 'unknown';
    case 'array': {
      const element = renderType(type.element);
      return element.includes('|') ? `(${element})[]` : `${element}[]`;
    }
    case 'record': {
      const key = type.keys === null ? 'string' : type.keys.map(quote).join(' | ');
      return `Record<${key}, ${renderType(type.value)}>`;
    }
    case 'objectRef':
      return type.name;
  }
}

/**
 * The one line of prose a field earns.
 *
 * Deliberately thin. The schema carries paragraphs of reasoning per field and
 * none of it survives to runtime, so a generated comment that tried to explain
 * WHY would be inventing. This says only what the emitted syntax cannot: that
 * the server fills a default in, and that a cross-field rule exists.
 */
function fieldDoc(field: ContractField): string | null {
  if (field.defaultValue === null) return null;
  const rendered =
    typeof field.defaultValue.value === 'string'
      ? quote(field.defaultValue.value)
      : JSON.stringify(field.defaultValue.value);
  return `Optional in the request; the server defaults it to ${rendered}.`;
}

function renderField(field: ContractField, direction: 'request' | 'response'): string[] {
  // `.default()` makes a field optional to the CALLER only. On the way back it
  // is always present, so a response type must not mark it `?`.
  const optional = field.optional && (direction === 'request' || field.defaultValue === null);
  const type = field.nullable ? `${renderType(field.type)} | null` : renderType(field.type);
  const doc = direction === 'request' ? fieldDoc(field) : null;
  const lines = doc ? [`  /** ${doc} */`] : [];
  lines.push(`  ${field.name}${optional ? '?' : ''}: ${type};`);
  return lines;
}

function renderObject(object: ContractObject, doc: string[]): string {
  // An object reached from both directions would need two shapes; none on this
  // surface is, and the emitter says which side it took rather than guessing.
  const direction = object.encoded && !object.decoded ? 'request' : 'response';
  const docLines = [...doc];
  if (object.refined) {
    docLines.push(
      'The server also enforces a cross-field rule this type cannot express (zod .refine);',
      'a payload that satisfies the type can still be refused.',
    );
  }
  const comment = ['/**', ...docLines.map((line) => ` * ${line}`), ' */'].join('\n');
  const fields = object.fields.flatMap((field) => renderField(field, direction));
  return `${comment}\nexport interface ${object.name} {\n${fields.join('\n')}\n}`;
}

/** Renders the whole model as one TypeScript module. */
export function emitTypeScript(model: ContractModel): string {
  const blocks: string[] = [bannerComment(SOURCE_DESCRIPTION)];

  if (model.shared.length > 0) {
    blocks.push('// ---------- Types shared by more than one callable ----------');
    for (const object of model.shared) {
      blocks.push(renderObject(object, [`\`${object.name}\`, shared across callables.`]));
    }
  }

  for (const callable of model.callables) {
    blocks.push(`// ---------- ${callable.name} ----------`);
    if (callable.argsObject === null) {
      blocks.push(
        `// No request type: \`${callable.name}\` has no zod request schema on the server,\n` +
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
      blocks.push(renderObject(object, [role]));
    }
  }

  return `${blocks.join('\n\n')}\n`;
}
