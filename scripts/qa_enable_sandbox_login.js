// One-off QA helper: make the TEST SANDBOX account a usable kinfolk login.
//   1. clients/<uid>.kinfolkIds -> ["test-kinfolk-001"]  (so getMyAccess routes to Home)
//   2. set a fresh random temp password on the auth user, printed at the end
// Safe: test-kinfolk-001 is isolated isTestData. Reversible (clear kinfolkIds after).
// Run from repo root:  ! node scripts/qa_enable_sandbox_login.js
const admin = require('../functions/node_modules/firebase-admin');
const crypto = require('crypto');

const UID = 'V8Z4YsabpNfrHTTOLJw0YY3Wx5G3';
const TRIBE = 'test-kinfolk-001';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'auntieos-ttpc',
});

(async () => {
  const pw = 'QA-' + crypto.randomBytes(9).toString('base64url') + '!7';
  await admin.firestore().collection('clients').doc(UID).set(
    { kinfolkIds: [TRIBE] },
    { merge: true },
  );
  console.log('[1/2] linked kinfolkIds =', [TRIBE]);
  await admin.auth().updateUser(UID, { password: pw });
  console.log('[2/2] temp password set.');
  console.log('\n=== SANDBOX LOGIN ===');
  console.log('email:    test-admin+sandbox@tribetails.test');
  console.log('password:', pw);
  console.log('=====================\n');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
