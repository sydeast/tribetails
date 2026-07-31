import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

interface Template {
  key: string;
  subject: string;
  body: string;
  html?: string | null;
}

async function main(): Promise<void> {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = getFirestore();
  const dir = resolve(__dirname, '..', 'seeds', 'emailTemplates');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const tpl: Template = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    if (basename(f, '.json') !== tpl.key) {
      throw new Error(`filename ${f} does not match key ${tpl.key}`);
    }
    await db.doc(`emailTemplates/${tpl.key}`).set({
      subject: tpl.subject,
      body: tpl.body,
      html: tpl.html ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`seeded emailTemplates/${tpl.key}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
