import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  RulesTestContext,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let env: RulesTestEnvironment | null = null;

export async function getEnv(): Promise<RulesTestEnvironment> {
  if (env) return env;
  env = await initializeTestEnvironment({
    projectId: 'mytribe-rules-test',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  return env;
}

export async function cleanup(): Promise<void> {
  if (env) {
    await env.clearFirestore();
  }
}

export async function shutdown(): Promise<void> {
  if (env) await env.cleanup();
  env = null;
}

export async function seedFamily(opts: {
  fid: string;
  primaryUid: string;
  secondaries?: Array<{ uid: string; perms: Partial<Record<string, boolean>>; status?: string; role?: string }>;
}): Promise<void> {
  const e = await getEnv();
  await e.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`families/${opts.fid}`).set({
      displayName: 'Test Tribe',
      primaryUid: opts.primaryUid,
      themeConfigRef: `families/${opts.fid}/themeConfig/active`,
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.doc(`families/${opts.fid}/members/${opts.primaryUid}`).set({
      uid: opts.primaryUid,
      displayName: 'Primary',
      role: 'PRIMARY',
      status: 'ACTIVE',
      permissions: {
        billing_full: true, messaging_direct: true, messaging_group: true,
        kin_edit: true, kintales_only: true, home_access: true,
      },
      updatedAt: new Date(),
    });
    for (const s of opts.secondaries ?? []) {
      await db.doc(`families/${opts.fid}/members/${s.uid}`).set({
        uid: s.uid,
        displayName: 'Secondary',
        role: s.role ?? 'SECONDARY',
        secondaryLabel: 'Co-Parent',
        status: s.status ?? 'ACTIVE',
        permissions: {
          billing_full: false, messaging_direct: false, messaging_group: false,
          kin_edit: false, kintales_only: true, home_access: false,
          ...s.perms,
        },
        updatedAt: new Date(),
      });
    }
  });
}

export function asUser(
  env: RulesTestEnvironment,
  uid: string,
  claims?: Record<string, unknown>,
): RulesTestContext {
  return env.authenticatedContext(uid, claims);
}

export function asUnauth(env: RulesTestEnvironment): RulesTestContext {
  return env.unauthenticatedContext();
}
