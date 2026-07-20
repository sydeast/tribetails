// One-off QA helper: set a fresh known password on the sandbox test account.
// Run: GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/gcloud/application_default_credentials.json \
//        node scripts/qa_set_sandbox_password.js
const admin = require('../functions/node_modules/firebase-admin');

const UID = 'V8Z4YsabpNfrHTTOLJw0YY3Wx5G3';
const PW = 'Sandbox-Tribe-2026';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'auntieos-ttpc',
});

(async () => {
  await admin.auth().updateUser(UID, { password: PW });
  console.log('password set for test-admin+sandbox@tribetails.test');
  console.log('new password:', PW);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
