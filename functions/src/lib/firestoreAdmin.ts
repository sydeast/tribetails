import * as admin from 'firebase-admin';

let initialized = false;

export function getAdmin(): typeof admin {
  if (!initialized) {
    admin.initializeApp();
    initialized = true;
  }
  return admin;
}

export function db(): FirebaseFirestore.Firestore {
  return getAdmin().firestore();
}

export function auth(): admin.auth.Auth {
  return getAdmin().auth();
}
