#!/usr/bin/env node
// Read back meta/stateOfTheUnion and report what the live page will render.
// Verification only: never writes. Companion to push-sotu.js.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, '../android/serviceAccount.json');
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`Service account JSON missing: ${SERVICE_ACCOUNT_PATH}`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
});

admin
  .firestore()
  .doc('meta/stateOfTheUnion')
  .get()
  .then((snap) => {
    if (!snap.exists) {
      console.error('meta/stateOfTheUnion does NOT exist');
      process.exit(1);
    }
    const d = snap.data() || {};
    // push-sotu.js writes the document under `content` (see its .set at line 43).
    const body = typeof d.content === 'string' ? d.content : '';
    const headings = body
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .slice(0, 4);
    console.log('date field :', JSON.stringify(d.date));
    console.log('bytes      :', Buffer.byteLength(body, 'utf8'));
    console.log('updatedAt  :', d.updatedAt ? String(d.updatedAt.toDate ? d.updatedAt.toDate().toISOString() : d.updatedAt) : '(unset)');
    console.log('mentions night session:', body.includes('subtree pull') ? 'YES' : 'NO');
    console.log('first headings:');
    headings.forEach((h) => console.log('  ' + h));
    process.exit(0);
  })
  .catch((e) => {
    console.error('read failed:', e.message);
    process.exit(1);
  });
