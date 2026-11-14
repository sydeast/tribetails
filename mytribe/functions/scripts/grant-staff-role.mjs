/**
 * Mints or revokes the `staffRole` custom claim on a staff account. Today the
 * only value is `auntie`: a caretaker, a contractor or employee.
 *
 * Usage, from mytribe/functions, against the live project:
 *   GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-staff-role.mjs \
 *     --email auntie@example.com --role auntie
 *
 * To revoke, which returns the account to holding no staff role at all, takes
 * it off the business admin list and unregisters its work devices from
 * business notices (#2228):
 *   ... --email auntie@example.com --role none
 *
 * The work is in `grantStaffRole.ts`, which this starts through ts-node (#2228:
 * revoking shares `src/lib/staffAccessEnd.ts` with `onClientsWrite`, and a
 * plain `.mjs` cannot import TypeScript). The rules it keeps, and the order
 * `--role none` runs in, are written down there.
 *
 * Exits with the tool's own code: 0 done, 1 refused or a step failed (the
 * message names which), 2 a usage problem or nothing to do.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const functionsDir = join(here, '..');
const tsNode = join(functionsDir, 'node_modules', '.bin', 'ts-node');

if (!existsSync(tsNode)) {
  console.error('ts-node is not installed. Run `npm ci` in mytribe/functions first.');
  process.exit(1);
}

const result = spawnSync(
  tsNode,
  ['--project', join(here, 'tsconfig.json'), join(here, 'grantStaffRoleCli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: functionsDir },
);

if (result.error) {
  console.error(`Could not start the staff role tool: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
