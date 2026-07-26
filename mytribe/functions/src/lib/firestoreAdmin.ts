// firebase-admin 14 removed the namespaced `admin.firestore()` API surface;
// everything is modular getX(app) calls now. getAdmin() keeps the old facade
// shape (an object with .firestore()/.auth()/.messaging()/.storage()) so call
// sites and test mocks stay unchanged.
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { getStorage, type Storage } from 'firebase-admin/storage';

let app: App | null = null;

function ensureApp(): App {
  if (!app) {
    app = getApps()[0] ?? initializeApp();
  }
  return app;
}

export interface AdminFacade {
  firestore(): Firestore;
  auth(): Auth;
  messaging(): Messaging;
  storage(): Storage;
}

export function getAdmin(): AdminFacade {
  const a = ensureApp();
  return {
    firestore: () => getFirestore(a),
    auth: () => getAuth(a),
    messaging: () => getMessaging(a),
    storage: () => getStorage(a),
  };
}

export function db(): Firestore {
  return getFirestore(ensureApp());
}

export function auth(): Auth {
  return getAuth(ensureApp());
}
