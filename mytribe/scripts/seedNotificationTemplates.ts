import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  listNotificationKeys,
  NOTIFICATION_KEY_ALIASES,
} from '../functions/src/notifications/catalog';
import { parseEmailTxt, parsePushTxt } from '../functions/src/notifications/templateParsers';

interface Args {
  dryRun: boolean;
  onlyKey: string | null;
  allowProd: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, onlyKey: null, allowProd: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--key') {
      const v = argv[i + 1];
      if (!v) throw new Error('--key requires a value');
      args.onlyKey = v;
      i += 1;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

interface PlannedWrite {
  key: string;
  emailDoc: { subject: string; body: string; html: string };
  smsDoc: { text: string };
  pushDoc: { title: string; body: string };
}

function loadDir(dir: string, key: string): PlannedWrite {
  const need = ['email.html', 'email.txt', 'sms.txt', 'push.txt'];
  for (const f of need) {
    if (!existsSync(join(dir, f))) {
      throw new Error(`seedNotificationTemplates: ${key}: missing required file ${f} in ${dir}`);
    }
  }
  const emailHtml = readFileSync(join(dir, 'email.html'), 'utf8');
  const emailTxt = readFileSync(join(dir, 'email.txt'), 'utf8');
  const smsTxt = readFileSync(join(dir, 'sms.txt'), 'utf8');
  const pushTxt = readFileSync(join(dir, 'push.txt'), 'utf8');

  const { subject, body } = parseEmailTxt(emailTxt);
  const { title, body: pushBody } = parsePushTxt(pushTxt);
  const smsText = smsTxt.trim();
  if (smsText.length === 0) {
    throw new Error(`seedNotificationTemplates: ${key}: sms.txt is empty`);
  }

  return {
    key,
    emailDoc: { subject, body, html: emailHtml },
    smsDoc: { text: smsText },
    pushDoc: { title, body: pushBody },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seedsRoot = resolve(__dirname, '..', 'seeds', 'notificationTemplates');
  const catalogKeys = new Set(listNotificationKeys());
  // A retired key (NOTIFICATION_KEY_ALIASES) keeps its on-disk template dir and
  // its seeded Firestore docs. Live sends resolve through the canonical row's
  // template ids, so these copies are not what renders any more, but nothing is
  // deleted out from under an operator-authored binding that still points at
  // the old id.
  const aliasKeys = new Set(Object.keys(NOTIFICATION_KEY_ALIASES));

  const dirNames = readdirSync(seedsRoot).filter((n) =>
    statSync(join(seedsRoot, n)).isDirectory(),
  );

  let processed = 0;
  let skipped = 0;
  const skippedKeys: string[] = [];

  for (const dirName of dirNames) {
    if (!catalogKeys.has(dirName) && !aliasKeys.has(dirName)) {
      throw new Error(`seedNotificationTemplates: dir ${dirName} is not a catalog key`);
    }
    if (args.onlyKey && dirName !== args.onlyKey) continue;
    const planned = loadDir(join(seedsRoot, dirName), dirName);
    const tag = aliasKeys.has(dirName)
      ? `[alias -> ${NOTIFICATION_KEY_ALIASES[dirName].canonical}]`
      : '[plan]';
    console.log(`${tag} ${dirName}: email(subject=${JSON.stringify(planned.emailDoc.subject)}), sms(${planned.smsDoc.text.length}ch), push(title=${JSON.stringify(planned.pushDoc.title)})`);
    processed += 1;
  }

  if (args.onlyKey === null) {
    for (const k of catalogKeys) {
      const hasDir = dirNames.includes(k);
      if (!hasDir) {
        console.warn(`[skip] catalog key '${k}' has no on-disk template dir`);
        skippedKeys.push(k);
        skipped += 1;
      }
    }
  }

  console.log(`\nsummary: processed=${processed} skipped=${skipped} dryRun=${args.dryRun}`);
  if (skippedKeys.length > 0) {
    console.log(`skipped catalog keys: ${skippedKeys.join(', ')}`);
  }

  if (args.dryRun) {
    console.log('dry-run complete — no Firestore writes');
    return;
  }

  const usingEmulator = typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  if (!usingEmulator && !args.allowProd) {
    throw new Error('seedNotificationTemplates: refusing to write — pass --allow-prod or set FIRESTORE_EMULATOR_HOST');
  }
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error('seedNotificationTemplates: GCLOUD_PROJECT env var is required (refusing to fall back to gcloud active project)');
  }
  console.log(`[init] projectId=${projectId} emulator=${usingEmulator} allowProd=${args.allowProd}`);

  initializeApp({ projectId });
  const db = getFirestore();
  const stamp = (): FieldValue => FieldValue.serverTimestamp();

  let seeded = 0;
  let errors = 0;
  const errorKeys: string[] = [];

  for (const dirName of dirNames) {
    if (args.onlyKey && dirName !== args.onlyKey) continue;
    try {
      const planned = loadDir(join(seedsRoot, dirName), dirName);
      await db.doc(`emailTemplates/${dirName}`).set({
        subject: planned.emailDoc.subject,
        body: planned.emailDoc.body,
        html: planned.emailDoc.html,
        updatedAt: stamp(),
      });
      await db.doc(`smsTemplates/${dirName}`).set({
        text: planned.smsDoc.text,
        updatedAt: stamp(),
      });
      await db.doc(`pushTemplates/${dirName}`).set({
        title: planned.pushDoc.title,
        body: planned.pushDoc.body,
        updatedAt: stamp(),
      });
      seeded += 1;
      console.log(`[seeded] ${dirName} (email + sms + push)`);
    } catch (err) {
      errors += 1;
      errorKeys.push(dirName);
      console.error(`[error] ${dirName}: ${(err as Error).message}`);
      throw err;
    }
  }

  console.log(`\nfinal: seeded=${seeded} skipped=${skipped} errors=${errors}`);
  if (errors > 0) {
    console.log(`error keys: ${errorKeys.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
