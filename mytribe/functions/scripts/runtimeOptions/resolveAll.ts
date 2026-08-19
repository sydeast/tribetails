/**
 * Bridges `extractSource.ts` (real files -> raw fragments) and `model.ts`
 * (fragments -> a concrete shape). Kept separate from both so `model.ts` stays
 * file-system-free and `extractSource.ts` stays resolution-free — each is
 * independently testable, and this is the one place they meet.
 */
import { extractAll } from './extractSource';
import { resolveFleetDefault, resolveFunctionShape } from './model';
import { ResolvedFunctionDeclaration, RuntimeShape } from './types';

export interface ResolveAllResult {
  fleetDefault: RuntimeShape;
  declarations: ResolvedFunctionDeclaration[];
  /** Exports `index.ts` declares that this tool could not resolve. Always
   * check this — a nonzero length means the diff below is incomplete, not
   * that those functions have no drift. */
  errors: { name: string; message: string }[];
}

export function resolveAll(): ResolveAllResult {
  const { globalFragments, namedConstants, declarations: raw, errors } = extractAll();
  const fleetDefault = resolveFleetDefault(globalFragments);

  const declarations: ResolvedFunctionDeclaration[] = raw.map((decl) => {
    const shape =
      decl.generation === 'gen1'
        ? // v1 has no `setGlobalOptions` inheritance at all; this codebase's one
          // v1 trigger sets nothing, so what's "expected" is the gcf_gen1 SDK
          // default (256MiB, 60s, us-central1) rather than anything from
          // index.ts. cpu/minInstances/maxInstances are meaningless for gen1
          // and never compared (see GEN1_COMPARABLE_FIELDS) — the placeholder
          // values here (fleetDefault's) are never read.
          { ...fleetDefault, memory: 256, timeoutSeconds: 60, region: 'us-central1' }
        : resolveFunctionShape(fleetDefault, decl.fragments, namedConstants);
    return {
      name: decl.name,
      file: decl.file,
      line: decl.line,
      trigger: decl.trigger,
      generation: decl.generation,
      shape,
    };
  });

  return { fleetDefault, declarations, errors };
}
