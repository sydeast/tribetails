/**
 * Statically extracts, from real source, every runtime-options declaration
 * `index.ts` re-exports: the fleet default (`setGlobalOptions`), the named
 * constants it can spread (`lib/runtimeOptions.ts`), and each function's own
 * options object. Nothing here evaluates code — it walks the TypeScript AST
 * and reads literal values, which is exactly what `setGlobalOptions` and
 * every trigger factory call in this codebase are: plain object literals,
 * optionally spreading one of three named constants (see `model.ts`'s
 * `applyFragments` for why that's the only spread shape this needs to
 * handle — verified by grep before writing this, not assumed).
 *
 * FAILS LOUDLY BY DESIGN. An export this can't resolve — a module it can't
 * find, a call shape it doesn't recognize, a runtime-option value that isn't
 * a literal — is collected as an error and reported, never silently dropped.
 * A drift tool that quietly skips the function it couldn't parse is worse
 * than no tool: it launders "unknown" into "no news is good news".
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

import { applyFragments } from './model';
import {
  FunctionGeneration,
  OptionsFragment,
  RawFunctionDeclaration,
  RUNTIME_KEYS,
  RuntimeKey,
  RuntimeShape,
} from './types';

/** `<repo>/mytribe/functions/scripts/runtimeOptions` -> `<repo>`. */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export const INDEX_TS = join(REPO_ROOT, 'mytribe/functions/src/index.ts');
export const RUNTIME_OPTIONS_TS = join(REPO_ROOT, 'mytribe/functions/src/lib/runtimeOptions.ts');

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly context: string,
  ) {
    super(`${context}: ${message}`);
    this.name = 'ExtractionError';
  }
}

function parseFile(path: string): ts.SourceFile {
  const text = readFileSync(path, 'utf8');
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function propertyKeyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** A statically-literal value, or undefined if the initializer isn't one. */
function literalValue(expr: ts.Expression): string | number | undefined {
  // `'us-central1' as const` and similar: unwrap to the underlying literal.
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr))
    return literalValue(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return literalValue(expr.expression);
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  return undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Walks one options `ObjectLiteralExpression`'s properties in source order.
 * Only properties whose key is one of the six `RuntimeKey`s are kept —
 * `document`, `cors`, `secrets`, `retryConfig`, etc. are runtime-relevant to
 * the deploy but out of this tool's six-field scope and are ignored here.
 * A spread of anything other than a bare identifier, or a runtime-key
 * property whose value isn't a literal, throws: that's this codebase
 * growing a shape the extractor hasn't been taught yet, not a case to paper
 * over silently.
 */
function objectLiteralToFragments(
  obj: ts.ObjectLiteralExpression,
  context: string,
): OptionsFragment[] {
  const fragments: OptionsFragment[] = [];
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (!ts.isIdentifier(prop.expression)) {
        throw new ExtractionError(
          `spreads a non-identifier expression (${prop.getText()})`,
          context,
        );
      }
      fragments.push({ kind: 'spread', constant: prop.expression.text });
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      const key = propertyKeyText(prop.name);
      if (!key || !RUNTIME_KEYS.includes(key as RuntimeKey)) continue; // not one of our six fields
      const value = literalValue(prop.initializer);
      if (value === undefined) {
        throw new ExtractionError(
          `"${key}" is not a static literal (${prop.initializer.getText()})`,
          context,
        );
      }
      fragments.push({ kind: 'prop', key: key as RuntimeKey, value });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      if (RUNTIME_KEYS.includes(key as RuntimeKey)) {
        throw new ExtractionError(
          `"${key}" is a shorthand property, not a static literal`,
          context,
        );
      }
      continue;
    }
    // MethodDeclaration / other exotic ObjectLiteralElement kinds: not a
    // shape any options object in this codebase uses for our six fields.
  }
  return fragments;
}

/** `setGlobalOptions({...})` in `index.ts`, wherever it's called. */
export function extractGlobalFragments(sourceFile: ts.SourceFile): OptionsFragment[] {
  let found: OptionsFragment[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setGlobalOptions'
    ) {
      const [arg] = node.arguments;
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        throw new ExtractionError(
          'setGlobalOptions was not called with an object literal',
          'index.ts',
        );
      }
      found = objectLiteralToFragments(arg, 'index.ts:setGlobalOptions');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (found === null) {
    throw new ExtractionError('no setGlobalOptions(...) call found', 'index.ts');
  }
  return found;
}

/**
 * `lib/runtimeOptions.ts`'s exported constants (`FULL_CPU`, `FULL_CPU_SERIAL`,
 * `SERIAL` as of #395), read from source rather than hand-mirrored, so a
 * future edit to that file changes what this tool expects without a second
 * place to update.
 */
export function extractNamedConstants(
  sourceFile: ts.SourceFile,
): Record<string, Partial<RuntimeShape>> {
  const constants: Record<string, OptionsFragment[]> = {};
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      // `export const FULL_CPU = { cpu: 1, maxInstances: 10 } as const;`
      let init = decl.initializer;
      if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (!ts.isObjectLiteralExpression(init)) continue;
      constants[decl.name.text] = objectLiteralToFragments(
        init,
        `lib/runtimeOptions.ts:${decl.name.text}`,
      );
    }
  }
  // Coerce each constant's fragments through the same `applyFragments` merge
  // `model.ts` uses everywhere else, rather than re-implementing string ->
  // MiB / cpu-number coercion here. Fragments here are always `prop` (no
  // constant spreads another constant in this codebase, verified by grep);
  // `applyFragments` throws on a `spread` fragment with an unknown name if
  // that ever stops being true, which is the fail-loud behavior this file
  // wants anyway.
  const flat: Record<string, Partial<RuntimeShape>> = {};
  for (const [name, fragments] of Object.entries(constants)) {
    flat[name] = applyFragments({}, fragments, {});
  }
  return flat;
}

/** `export { a, b } from './module'` entries in `index.ts`, in source order. */
export function extractIndexExports(
  sourceFile: ts.SourceFile,
): { name: string; modulePath: string; line: number }[] {
  const exports: { name: string; modulePath: string; line: number }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue; // no module: skip
    if (statement.isTypeOnly) continue; // `export type { Foo } from './types'`: not a runtime value
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue; // `export { type Foo, health } from './x'`
      // `export { a as b }` isn't used anywhere in this codebase (verified by
      // grep before writing this), so the deployed name is always the local
      // name. If that ever changes, `element.name` (not `propertyName`) is
      // still correct: it's the identifier the deploy actually registers.
      exports.push({
        name: element.name.text,
        modulePath: moduleSpecifier.text,
        line: lineOf(sourceFile, element),
      });
    }
  }
  return exports;
}

const V2_ARG_STYLE: Record<string, 'optsOrHandler' | 'optsHandler' | 'scheduleOptsHandler'> = {
  onCall: 'optsOrHandler',
  onRequest: 'optsOrHandler',
  beforeUserSignedIn: 'optsOrHandler',
  beforeUserCreated: 'optsOrHandler',
  onDocumentCreated: 'optsHandler',
  onDocumentUpdated: 'optsHandler',
  onDocumentWritten: 'optsHandler',
  onDocumentDeleted: 'optsHandler',
  onSchedule: 'scheduleOptsHandler',
};

function calleeName(expr: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/**
 * Resolves an identifier used as an options argument back to its own
 * top-level `const` in the same module, e.g. a file that builds its options
 * object once and passes it by name. Only reached when the call's argument
 * isn't already an inline object literal.
 */
function resolveLocalConst(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === name &&
        decl.initializer &&
        ts.isObjectLiteralExpression(decl.initializer)
      ) {
        return decl.initializer;
      }
    }
  }
  return undefined;
}

function optionsExpressionToFragments(
  expr: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  context: string,
): OptionsFragment[] {
  if (!expr) return [];
  if (ts.isObjectLiteralExpression(expr)) return objectLiteralToFragments(expr, context);
  if (ts.isIdentifier(expr)) {
    const local = resolveLocalConst(sourceFile, expr.text);
    if (local) return objectLiteralToFragments(local, context);
  }
  throw new ExtractionError(
    `options argument is not an object literal or a resolvable local const (${expr.getText()})`,
    context,
  );
}

/**
 * The one v1 export in this fleet: `auth.user().onCreate(handler)` in
 * `onAuthUserCreate.ts`. v1 blocking/background triggers don't take the v2
 * options shape this tool resolves, and this codebase's only v1 trigger
 * carries no `runWith` call at all (confirmed by the comment at its
 * definition), so it always resolves to zero fragments — a v1 function's
 * ACTUAL deployed memory/timeout come from the gcf_gen1 SDK defaults, which
 * are out of scope for a fleet default this tool only computes for v2.
 */
function isV1AuthOnCreate(call: ts.CallExpression): boolean {
  // Structural match for `<anything>.user().onCreate(handler)`, e.g.
  // `auth.user().onCreate(...)` from `firebase-functions/v1`.
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'onCreate')
    return false;
  const target = call.expression.expression; // should be `auth.user()`
  if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression))
    return false;
  return target.expression.name.text === 'user';
}

/**
 * Finds `export const <exportedName> = <triggerFactoryCall>(...)` DIRECTLY in
 * this file. Returns undefined (not a throw) when this file doesn't define
 * that name itself — that's not an error, it's the signal to the caller to
 * follow a re-export chain (`notifications/index.ts` barrels
 * `onNotificationCreate` from `./triggers/onNotificationCreate`, which
 * `index.ts` never sees directly). Any OTHER problem — an unrecognized call
 * shape, a non-literal value — is a real finding and still throws.
 */
function findDirectDeclaration(
  sourceFile: ts.SourceFile,
  exportedName: string,
  moduleRelativePath: string,
): RawFunctionDeclaration | undefined {
  const context = `${moduleRelativePath}:${exportedName}`;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportedName || !decl.initializer)
        continue;
      const init = decl.initializer;
      if (!ts.isCallExpression(init)) {
        throw new ExtractionError(
          `export's initializer is not a call expression (${init.getText().slice(0, 60)})`,
          context,
        );
      }

      if (isV1AuthOnCreate(init)) {
        return {
          name: exportedName,
          file: moduleRelativePath,
          line: lineOf(sourceFile, init),
          trigger: 'auth.user().onCreate',
          generation: 'gen1' as FunctionGeneration,
          fragments: [],
        };
      }

      const name = calleeName(init.expression);
      const style = name ? V2_ARG_STYLE[name] : undefined;
      if (!name || !style) {
        throw new ExtractionError(
          `unrecognized trigger factory "${init.expression.getText()}" — teach V2_ARG_STYLE about it or confirm it's not a Cloud Function`,
          context,
        );
      }

      let optionsArg: ts.Expression | undefined;
      if (style === 'optsOrHandler') {
        optionsArg = init.arguments.length >= 2 ? init.arguments[0] : undefined;
      } else if (style === 'optsHandler') {
        optionsArg = init.arguments[0];
        if (!optionsArg) {
          throw new ExtractionError(
            `${name} requires an options object (for "document") but none was found`,
            context,
          );
        }
      } else {
        // scheduleOptsHandler covers three real onSchedule call shapes:
        //   (schedule: string, handler)                — no options object
        //   (schedule: string, opts, handler)           — opts is the 2nd arg
        //   (optsWithScheduleKey, handler)               — opts is the 1st arg;
        //     this is the shape every real onSchedule call site in this
        //     repo actually uses (schedule folded into the options object).
        // Anything else is a shape this tool hasn't been taught — fail
        // loudly rather than silently returning zero fragments (see file
        // header): a launder here blinds the tool to all six runtime
        // fields for that function.
        const first = init.arguments[0];
        if (init.arguments.length === 3) {
          optionsArg = init.arguments[1];
        } else if (
          init.arguments.length === 2 &&
          first &&
          (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ) {
          optionsArg = undefined;
        } else if (
          init.arguments.length === 2 &&
          first &&
          (ts.isObjectLiteralExpression(first) || ts.isIdentifier(first))
        ) {
          optionsArg = first;
        } else {
          throw new ExtractionError(
            `onSchedule called with an unrecognized argument shape (${init.arguments.length} args` +
              `${first ? `, first: ${first.getText().slice(0, 60)}` : ''})`,
            context,
          );
        }
      }

      const fragments = optionsExpressionToFragments(optionsArg, sourceFile, context);
      return {
        name: exportedName,
        file: moduleRelativePath,
        line: lineOf(sourceFile, init),
        trigger: name,
        generation: 'gen2' as FunctionGeneration,
        fragments,
      };
    }
  }
  return undefined;
}

/** `export { origName as exportedName } from './y'` entries in one file, resolved to that name's re-export module. */
function findReExportModule(
  sourceFile: ts.SourceFile,
  exportedName: string,
): { originalName: string; modulePath: string } | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      if (element.name.text === exportedName) {
        return {
          originalName: (element.propertyName ?? element.name).text,
          modulePath: moduleSpecifier.text,
        };
      }
    }
  }
  return undefined;
}

const MAX_REEXPORT_DEPTH = 5;

/**
 * Finds `exportedName`'s trigger-factory declaration, following barrel
 * re-export chains (`export { x } from './y'` with no `export const x`
 * directly in this file) up to `MAX_REEXPORT_DEPTH` hops. `absFilePath` is
 * needed alongside `sourceFile` because a re-export target is resolved
 * relative to the CURRENT file's directory, not `index.ts`'s.
 */
export function extractFunctionDeclaration(
  sourceFile: ts.SourceFile,
  exportedName: string,
  moduleRelativePath: string,
  absFilePath: string = sourceFile.fileName,
  depth = 0,
): RawFunctionDeclaration {
  const direct = findDirectDeclaration(sourceFile, exportedName, moduleRelativePath);
  if (direct) return direct;

  if (depth < MAX_REEXPORT_DEPTH) {
    const reExport = findReExportModule(sourceFile, exportedName);
    if (reExport) {
      const targetAbsPath = resolveModuleFile(reExport.modulePath, dirname(absFilePath));
      const targetRelPath = toRepoRelativePath(targetAbsPath);
      const targetSource = parseFile(targetAbsPath);
      return extractFunctionDeclaration(
        targetSource,
        reExport.originalName,
        targetRelPath,
        targetAbsPath,
        depth + 1,
      );
    }
  }

  throw new ExtractionError(
    `no "export const ${exportedName} = ..." found in ${moduleRelativePath}, and no further re-export to follow`,
    `${moduleRelativePath}:${exportedName}`,
  );
}

export interface ExtractAllResult {
  globalFragments: OptionsFragment[];
  namedConstants: Record<string, Partial<RuntimeShape>>;
  declarations: RawFunctionDeclaration[];
  errors: { name: string; message: string }[];
}

/**
 * Resolves `./relative/path` (no extension) against `fromDir` to a real .ts
 * file: either `<path>.ts` directly, or `<path>/index.ts` for a barrel
 * import (`from './notifications'` -> `notifications/index.ts`).
 */
function resolveModuleFile(modulePath: string, fromDir: string): string {
  const direct = resolve(fromDir, `${modulePath}.ts`);
  if (existsSync(direct)) return direct;
  const barrel = resolve(fromDir, modulePath, 'index.ts');
  if (existsSync(barrel)) return barrel;
  throw new Error(
    `Cannot resolve module "${modulePath}" from ${fromDir}: neither ${direct} nor ${barrel} exists`,
  );
}

function toRepoRelativePath(absPath: string): string {
  return absPath.slice(REPO_ROOT.length + 1);
}

/**
 * Extracts every function `index.ts` re-exports. Parses each distinct module
 * file exactly once (several exports commonly share a file, e.g.
 * `notificationPrefs.ts` exports both `getMyNotificationPrefs` and
 * `saveMyNotificationPrefs`).
 */
export function extractAll(): ExtractAllResult {
  const indexSource = parseFile(INDEX_TS);
  const globalFragments = extractGlobalFragments(indexSource);

  const runtimeOptionsSource = parseFile(RUNTIME_OPTIONS_TS);
  const namedConstants = extractNamedConstants(runtimeOptionsSource);

  const exportEntries = extractIndexExports(indexSource);
  const moduleCache = new Map<string, ts.SourceFile>();
  const declarations: RawFunctionDeclaration[] = [];
  const errors: { name: string; message: string }[] = [];

  for (const entry of exportEntries) {
    try {
      const absPath = resolveModuleFile(entry.modulePath, dirname(INDEX_TS));
      let moduleSource = moduleCache.get(absPath);
      if (!moduleSource) {
        moduleSource = parseFile(absPath);
        moduleCache.set(absPath, moduleSource);
      }
      const relPath = toRepoRelativePath(absPath);
      declarations.push(extractFunctionDeclaration(moduleSource, entry.name, relPath, absPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ name: entry.name, message });
    }
  }

  return { globalFragments, namedConstants, declarations, errors };
}
