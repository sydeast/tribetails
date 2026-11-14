/**
 * Entry point `grant-staff-role.mjs` starts through ts-node. Everything it does
 * is in `grantStaffRole.ts`; this file only reads the command line, runs it
 * against the project in GOOGLE_CLOUD_PROJECT with application default
 * credentials, and exits with its code.
 */
import { USAGE, parseGrantStaffRoleArgs, runGrantStaffRole } from './grantStaffRole';

const args = parseGrantStaffRoleArgs(process.argv.slice(2));
if (!args) {
  console.error(USAGE);
  process.exit(2);
}

runGrantStaffRole(args, { log: (line) => console.log(line), error: (line) => console.error(line) }).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
