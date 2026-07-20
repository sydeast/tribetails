#!/usr/bin/env node
// One-shot bootstrap: mint admin custom claim + write admins/{uid} doc.
// Bypasses firebase functions:shell auth gymnastics.
// Usage: node bootstrap-admin.js <uid> [--revoke]

const path = require('path');
const admin = require('firebase-admin');
const sa = require(path.resolve(__dirname, '../android/serviceAccount.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });

const uid = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!uid) {
  console.error('Usage: node bootstrap-admin.js <uid> [--revoke]');
  process.exit(1);
}

(async () => {
  const isAdmin = !revoke;
  // Read-modify-write. setCustomUserClaims REPLACES the whole claim object, and
  // AuntieOS shares project auntieos-ttpc with the MyTribe portal, so a uid can
  // hold role/kinfolkId (portal) or testTribeId (Stage 0I sandbox) alongside
  // admin. Writing { admin } wholesale silently destroyed those, signing the
  // person out of the portal. Same fix as web/functions/index.js mergeAdminClaim
  // and MyTribe functions/src/lib/kinfolkClaim.ts.
  const target = await admin.auth().getUser(uid);
  const nextClaims = { ...(target.customClaims ?? {}), admin: isAdmin };
  await admin.auth().setCustomUserClaims(uid, nextClaims);
  const preserved = Object.keys(nextClaims).filter((k) => k !== 'admin');
  if (preserved.length) console.log(`Preserved existing claims: ${preserved.join(', ')}`);
  if (isAdmin) {
    await admin.firestore().collection('admins').doc(uid).set({
      uid,
      grantedBy: 'bootstrap-admin.js',
      grantedAt: admin.firestore.FieldValue.serverTimestamp(),
      bootstrap: true,
    });
    console.log(`Granted admin to ${uid}.`);
  } else {
    await admin.firestore().collection('admins').doc(uid).delete();
    console.log(`Revoked admin from ${uid}.`);
  }
  console.log('Note: app must call getIdToken(true) to pick up claim. Force-quit + reopen, or wait ~1h.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
