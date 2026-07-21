#!/usr/bin/env node
// One-time migration: copy Baserow `drafts` table (id 636) → Firestore `generated_drafts` collection.
// Idempotent — uses Baserow row id as Firestore doc id, overwriting existing.
//
// Usage:
//   BASEROW_HOST=http://192.168.164.2 BASEROW_TOKEN=... node migrate-baserow-drafts.js
//   (defaults to current production host + token if not set)

const path = require('path');
const admin = require('firebase-admin');
const https = require('https');
const http = require('http');

const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, '../android/serviceAccount.json');
const BASEROW_HOST = process.env.BASEROW_HOST || 'http://192.168.164.2';
const BASEROW_TOKEN = process.env.BASEROW_TOKEN || 'soBDGJj1NIVBc0hcF67lNPU8zSAXIZEB';
const TABLE_ID = process.env.BASEROW_DRAFTS_TABLE || '636';
const COLLECTION = 'generated_drafts';

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchAllDrafts() {
  const all = [];
  let url = `${BASEROW_HOST}/api/database/rows/table/${TABLE_ID}/?user_field_names=true&size=200`;
  const headers = { Authorization: `Token ${BASEROW_TOKEN}`, Host: 'localhost:51001' };
  while (url) {
    const page = await fetchJson(url, headers);
    all.push(...(page.results || []));
    url = page.next || null;
  }
  return all;
}

function normalize(row) {
  return {
    status: row.status || 'pending',
    generatedCopy: row.generated_copy || '',
    communicationType: row.communication_type || '',
    kinfolkId: row.kinfolk_id ? String(row.kinfolk_id) : '',
    kinfolkName: row.kinfolk_name || row.recipient || '',
    rawNotes: row.raw_notes || '',
    toneHint: row.tone_hint || '',
    maxLength: row.max_length || '',
    model: row.model || '',
    createdOn: row.generated_at || row.created_on || '',
    approvedAt: row.status === 'approved' ? (row.generated_at || '') : '',
    approvedBy: '',
    baserowId: row.id,
  };
}

(async () => {
  console.log(`Fetching drafts from Baserow ${BASEROW_HOST} table ${TABLE_ID}…`);
  const rows = await fetchAllDrafts();
  console.log(`Got ${rows.length} drafts.`);

  let written = 0;
  for (const row of rows) {
    const docId = `baserow_${row.id}`;
    const data = normalize(row);
    await db.collection(COLLECTION).doc(docId).set(data, { merge: true });
    written++;
    if (written % 25 === 0) console.log(`  …${written}/${rows.length}`);
  }
  console.log(`Done. Wrote ${written} docs to Firestore ${COLLECTION}/.`);
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
