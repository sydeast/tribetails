// The three Admin SDK services this codebase uses, through the MODULAR API.
//
// #1247. Until this file, index.js called the namespaced API: `admin.auth()`,
// `admin.firestore()` and `admin.firestore.FieldValue`. firebase-admin 14
// (dependabot, cbeaf21, 2026-07-31) no longer exports it: `require('firebase-admin')`
// carries `initializeApp` and friends only, so `admin.auth` is `undefined` and
// every `/api/*` request that got past the missing-bearer check died in
// `verifyIdToken` with "admin.auth is not a function" and came back as a 401
// `invalid_bearer_token`, whatever the token was. The handler tests shadowed
// `admin.auth` with a double, so the suite never saw it.
//
// ONE OBJECT, CALLED THROUGH ITS PROPERTIES, so the handler tests can swap a
// double in for each service (test/handlers.test.js, installAdmin) without
// shadowing anything the real SDK owns. `test/firebaseServices.test.js` checks the
// real accessors, unshadowed, so an SDK release that moves them fails
// `npm test` and not production.
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

module.exports = {
  /** The default app's Auth service. */
  auth: () => getAuth(),
  /** The default app's Firestore. */
  firestore: () => getFirestore(),
  /** `FieldValue.serverTimestamp()`, the sentinel Firestore replaces with its own time. */
  serverTimestamp: () => FieldValue.serverTimestamp(),
};
