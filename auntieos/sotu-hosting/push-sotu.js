#!/usr/bin/env node
// Push SOTU markdown to Firestore meta/stateOfTheUnion so auntieos-ttpc.web.app reflects live state.
// Auto-discovers the most-recent STATE_OF_THE_UNION_*.md under android/_reference so the script
// never goes stale when the SOTU file is renamed for a new session.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SOTU_DIR = path.resolve(__dirname, '../android/_reference');
const SOTU_PATTERN = /^STATE_OF_THE_UNION_(\d{4}-\d{2}-\d{2})\.md$/;
function findLatestSotu() {
  if (!fs.existsSync(SOTU_DIR)) return null;
  const candidates = fs.readdirSync(SOTU_DIR)
    .map((name) => ({ name, m: name.match(SOTU_PATTERN) }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  return candidates.length ? path.join(SOTU_DIR, candidates[0].name) : null;
}
const SOTU_PATH = findLatestSotu();
const SOTU_REL = SOTU_PATH ? path.relative(path.resolve(__dirname, '..'), SOTU_PATH) : null;
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, '../android/serviceAccount.json');

if (!SOTU_PATH || !fs.existsSync(SOTU_PATH)) {
  console.error(`No STATE_OF_THE_UNION_*.md found under ${SOTU_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`Service account JSON missing: ${SERVICE_ACCOUNT_PATH}`);
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const content = fs.readFileSync(SOTU_PATH, 'utf8');
const dateMatch = content.match(/^\*\*Date:\*\*\s*(.+)$/m);
const date = dateMatch ? dateMatch[1].trim() : new Date().toISOString().slice(0, 10);
const lastUpdatedBy = process.env.SOTU_AUTHOR || 'Claude (session model unset; pass SOTU_AUTHOR)';

(async () => {
  const db = admin.firestore();
  await db.doc('meta/stateOfTheUnion').set({
    content,
    date,
    lastUpdatedBy,
    pushedAt: admin.firestore.FieldValue.serverTimestamp(),
    sourceFile: SOTU_REL,
    bytes: Buffer.byteLength(content, 'utf8'),
  });
  console.log(`Pushed SOTU (${Buffer.byteLength(content, 'utf8')} bytes) — date="${date}" by="${lastUpdatedBy}"`);
  process.exit(0);
})().catch((err) => {
  console.error('Push failed:', err);
  process.exit(1);
});
