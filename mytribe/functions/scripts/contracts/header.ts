/**
 * The do-not-edit banner every generated file opens with.
 *
 * It names the command, not the concept. "Regenerate this file" is useless to
 * someone who has just hand-fixed a field name and wants the build green
 * again; `npm --prefix mytribe/functions run contracts:generate` is not.
 */

/** Rewrites every generated artifact from the server schemas. */
export const GENERATE_COMMAND = 'npm --prefix mytribe/functions run contracts:generate';

/** Regenerates into memory and fails on any difference. Runs in CI. */
export const CHECK_COMMAND = 'npm --prefix mytribe/functions run contracts:check';

/**
 * The banner body, one entry per line, comment markers not included.
 *
 * @param sources where the schemas this file was built from live, relative to
 *   the repository root.
 */
export function bannerLines(sources: string): string[] {
  return [
    'GENERATED FILE. DO NOT EDIT.',
    '',
    'The Contracts module (CONTEXT.md), generated from the server zod schemas',
    'under ADR-0001 decision 2. The schema is the authority for both directions;',
    'this file is a projection of it and any hand edit is lost on the next run.',
    '',
    `Source:      ${sources}`,
    `Regenerate:  ${GENERATE_COMMAND}`,
    `Verify:      ${CHECK_COMMAND}`,
    '',
    'CI runs the verify command and fails on any difference, so a schema change',
    'and its generated fallout land in one reviewable commit.',
  ];
}

/** Wraps the banner in line comments. Both target languages use `//`. */
export function bannerComment(sources: string): string {
  return bannerLines(sources)
    .map((line) => (line === '' ? '//' : `// ${line}`))
    .join('\n');
}
