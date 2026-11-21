import Handlebars from 'handlebars';

/**
 * #2487: every `{{token}}` a template PRINTS for one render context, with the
 * value it prints.
 *
 * A raw `{{token}}` never reaches a reader (the senders blank whatever
 * Handlebars could not fill), so "no leftover braces" proves nothing: a blank
 * reads as "Hi , your invoice  is ready". This walks the parsed template the
 * way Handlebars renders it, so only the branch that is live for this context
 * counts: `{{note}}` inside `{{#if note}}` is not printed when there is no note,
 * and `{{addedKinName}}` inside `{{#if kinAdded}}` is printed only when a Kin
 * was added. Inside `{{#each visits}}` names resolve against the visit, the
 * way Handlebars resolves them.
 *
 * An `{{#each}}` over nothing is reported as a printed list with no entries
 * (`token` is the list's name, `value` an empty array): a confirmation whose
 * list of days is empty reads as broken as a blank name.
 */
export interface PrintedToken {
  token: string;
  value: unknown;
}

type Node = hbs.AST.Statement | hbs.AST.Program;

function lookup(path: hbs.AST.PathExpression, scope: unknown, root: Record<string, unknown>): unknown {
  // `this.x` and `x` both resolve against the current scope; `@root.x` against the root.
  let parts = [...path.parts];
  let base: unknown = path.data && parts[0] === 'root' ? root : scope;
  if (path.data && parts[0] === 'root') parts = parts.slice(1);
  for (const p of parts) {
    if (base === null || typeof base !== 'object') return undefined;
    base = (base as Record<string, unknown>)[p];
  }
  return base;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function printedTokens(template: string, data: Record<string, unknown>): PrintedToken[] {
  const out: PrintedToken[] = [];
  const ast = Handlebars.parse(template);

  function walk(node: Node | null | undefined, scope: unknown): void {
    if (!node) return;
    switch (node.type) {
      case 'Program':
        for (const s of (node as hbs.AST.Program).body) walk(s, scope);
        return;
      case 'MustacheStatement': {
        const m = node as hbs.AST.MustacheStatement;
        if (m.path.type !== 'PathExpression') return;
        const path = m.path as hbs.AST.PathExpression;
        out.push({ token: path.original.replace(/^this\./, ''), value: lookup(path, scope, data) });
        return;
      }
      case 'BlockStatement': {
        const b = node as hbs.AST.BlockStatement;
        const helper = (b.path as hbs.AST.PathExpression).original;
        const param = b.params[0] as hbs.AST.PathExpression | undefined;
        const value = param && param.type === 'PathExpression' ? lookup(param, scope, data) : undefined;
        if (helper === 'if' || helper === 'unless') {
          const live = helper === 'if' ? truthy(value) : !truthy(value);
          walk(live ? b.program : b.inverse, scope);
          return;
        }
        if (helper === 'each') {
          const items = Array.isArray(value) ? value : [];
          if (items.length === 0) {
            out.push({ token: param?.original ?? 'each', value: [] });
            walk(b.inverse, scope);
            return;
          }
          for (const item of items) walk(b.program, item);
          return;
        }
        // An unknown block helper: walk its body against the same scope.
        walk(b.program, scope);
        return;
      }
      default:
        return;
    }
  }

  walk(ast, data);
  return out;
}

/** A printed value a reader would see as missing. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.length === 0;
  // An object or boolean printed as text reads "[object Object]" or "true".
  return typeof value !== 'string' && typeof value !== 'number';
}
