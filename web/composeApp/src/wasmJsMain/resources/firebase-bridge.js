    import { initializeApp }
      from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
    import {
      getFirestore, collection, collectionGroup, doc, onSnapshot, query, where, getDoc, getDocs,
      setDoc, addDoc, deleteDoc, updateDoc, writeBatch, arrayUnion, increment, serverTimestamp,
      connectFirestoreEmulator,
    } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';
    import {
      getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
      sendPasswordResetEmail, initializeRecaptchaConfig, connectAuthEmulator,
      EmailAuthProvider, reauthenticateWithCredential, updatePassword, verifyBeforeUpdateEmail,
    } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
    import {
      getFunctions, httpsCallable, connectFunctionsEmulator,
    } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-functions.js';

    // AuntieOS Firebase project config.
    //
    // Today these are the Android-app credentials - they work for Firestore + Auth
    // governed by your Security Rules, but the appId is technically an Android one.
    // To register a proper "AuntieOS Web" app:
    //   Firebase Console → ⚙ Project settings → Your apps → Add app (</> icon)
    //   → "AuntieOS Web" → register → COPY the firebaseConfig block
    //   → paste over the values below.
    // Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo",
  authDomain: "auntieos-ttpc.firebaseapp.com",
  projectId: "auntieos-ttpc",
  storageBucket: "auntieos-ttpc.firebasestorage.app",
  messagingSenderId: "153396971788",
  appId: "1:153396971788:web:c2631409219d44727f2129",
  measurementId: "G-NNCB4GT3M6"
};

    const app  = initializeApp(firebaseConfig);
    const db   = getFirestore(app);
    const auth = getAuth(app);
    const functions = getFunctions(app, 'us-central1');

    // Local emulator wiring for the visual-test harness ONLY. Gated on a localhost
    // host AND an explicit ?emulator flag (or window.__USE_EMULATOR), so production
    // (auntie.tribetails.com) is never affected. Ports match web/firebase.dev.json.
    // Functions are routed to the emulator too so callable-backed screens
    // (template-bank/template-assignment/form-schemas) render deterministic seeded
    // data instead of live prod data - the harness must be hermetic.
    const __useEmulator =
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
      (location.search.includes('emulator') || window.__USE_EMULATOR === true);
    if (__useEmulator) {
      try {
        connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
        connectFirestoreEmulator(db, 'localhost', 8085);
        connectFunctionsEmulator(functions, 'localhost', 5001);
        console.log('[emulator] auth:9099 + firestore:8085 + functions:5001 connected (visual-test mode)');
      } catch (e) {
        console.error('[emulator] connect failed:', e);
      }
    }

    // reCAPTCHA Enterprise auto-attach for Identity Platform Auth requests.
    // Required to satisfy the Web platform site key configured in Firebase Auth
    // Settings. Without this, signInWithPassword returns 503 "Error code: 47"
    // because Identity Toolkit tries to validate against an unverified key.
    // Failing fire-and-forget is acceptable here - the SDK falls back to no
    // token, which Identity Platform handles via AUDIT mode logging.
    initializeRecaptchaConfig(auth).catch(err => {
      console.warn('[auth] initializeRecaptchaConfig failed:', err);
    });

    // Expose a tiny stable surface to the Wasm side. Keep this minimal - Kotlin
    // glues onto these helpers via @JsFun externals, so any rename is a contract change.
    // Defense-in-depth: defined as non-enumerable / non-writable / non-configurable
    // so an XSS payload (if CSP fails) can't monkey-patch the methods to siphon
    // payloads on each call. Frozen so the object itself is immutable.
    // Wasm interop still reads via `window.__fb.foo(...)` - the lookup works on
    // non-enumerable properties.
    const __fb = {
      // ---------- Firestore ----------
      listenCollection: (path, cb) => {
        return onSnapshot(
          collection(db, path),
          (snap) => {
            const docs = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
            cb(JSON.stringify(docs));
          },
          (err) => {
            console.error('[firestore] listen', path, err);
            cb(JSON.stringify({ __error: String(err && err.message || err) }));
          },
        );
      },
      listenWhereEq: (path, field, value, cb) => {
        const q = query(collection(db, path), where(field, '==', value));
        return onSnapshot(
          q,
          (snap) => {
            const docs = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
            cb(JSON.stringify(docs));
          },
          (err) => {
            console.error('[firestore] listenWhereEq', path, field, err);
            cb(JSON.stringify({ __error: String(err && err.message || err) }));
          },
        );
      },
      // Collection-group listener (matches every subcollection named `groupId`
      // anywhere in the tree) filtered by an equality predicate. Used by the
      // booking-envelope ingestion path: `kinCares` where status == 'requested'.
      // Each doc is surfaced with its full Firestore path as `_path` so the
      // Wasm side can derive families/{fid}/bookings/{batchId}/kinCares/{visitId}
      // for the staff write-back without an extra lookup.
      listenCollectionGroupWhereEq: (groupId, field, value, cb) => {
        const q = query(collectionGroup(db, groupId), where(field, '==', value));
        return onSnapshot(
          q,
          (snap) => {
            const docs = snap.docs.map(d => Object.assign({ _id: d.id, _path: d.ref.path }, d.data()));
            cb(JSON.stringify(docs));
          },
          (err) => {
            console.error('[firestore] listenCollectionGroupWhereEq', groupId, field, err);
            cb(JSON.stringify({ __error: String(err && err.message || err) }));
          },
        );
      },
      // Single-document live listener. Emits a one-element array on each snapshot:
      // `[{ _id, ...data }]` when the doc exists, or `[]` when it does not, so the
      // Wasm side can reuse the same array parser as listenCollection. Used for the
      // canonical settings doc business_settings/business_settings.
      listenDoc: (path, id, cb) => {
        return onSnapshot(
          doc(db, path, id),
          (snap) => {
            const docs = snap.exists()
              ? [Object.assign({ _id: snap.id }, snap.data())]
              : [];
            cb(JSON.stringify(docs));
          },
          (err) => {
            console.error('[firestore] listenDoc', path, id, err);
            cb(JSON.stringify({ __error: String(err && err.message || err) }));
          },
        );
      },
      unsubscribe: (unsub) => { try { unsub && unsub(); } catch (_) {} },

      // ---------- Firebase Functions (HTTPS callables) ----------
      // Invokes a v2 onCall function in us-central1. Auth context is attached
      // automatically by the Firebase SDK (current signed-in user). Reports back via:
      //   success → { ok: true, data: <stringified-result> }
      //   error   → { ok: false, error: string, code?: string }
      callFunction: (name, payloadJson, cb) => {
        try {
          const data = payloadJson ? JSON.parse(payloadJson) : {};
          httpsCallable(functions, name)(data)
            .then(res => cb(JSON.stringify({ ok: true, data: JSON.stringify(res.data ?? null) })))
            .catch(e => cb(JSON.stringify({
              ok: false,
              error: String(e && (e.message || e.code) || e),
              code: e && e.code ? String(e.code) : undefined,
            })));
        } catch (e) {
          cb(JSON.stringify({ ok: false, error: String(e && (e.message || e) || e) }));
        }
      },

      // ---------- Firestore one-shot writes ----------
      // Each write strips `_id` from the payload (it's a Kotlin-side document-id
      // alias, not a real Firestore field) and reports back via JSON callback:
      //   success → { ok: true, id?: string }
      //   error   → { ok: false, error: string }

      getDocOnce: (path, id, cb) => {
        getDoc(doc(db, path, id))
          .then(snap => cb(JSON.stringify({
            ok: true,
            exists: snap.exists(),
            data: snap.exists() ? Object.assign({ _id: snap.id }, snap.data()) : null,
          })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      // One-shot collection read. No live listener - callers use this only when
      // the cost of opening + tearing down a snapshot listener isn't worth it
      // (e.g. baking a final GPS summary at DEPARTED time).
      getCollectionOnce: (path, cb) => {
        getDocs(collection(db, path))
          .then(snap => {
            const arr = [];
            snap.forEach(d => arr.push(Object.assign({ _id: d.id }, d.data())));
            cb(JSON.stringify({ ok: true, data: arr }));
          })
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      addDocOnce: (path, json, cb) => {
        let data;
        try { data = JSON.parse(json); } catch (e) {
          return cb(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        }
        delete data._id;
        addDoc(collection(db, path), data)
          .then(ref => cb(JSON.stringify({ ok: true, id: ref.id })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      setDocOnce: (path, id, json, cb) => {
        let data;
        try { data = JSON.parse(json); } catch (e) {
          return cb(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        }
        delete data._id;
        setDoc(doc(db, path, id), data, { merge: true })
          .then(() => cb(JSON.stringify({ ok: true, id })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      updateDocOnce: (path, id, json, cb) => {
        let data;
        try { data = JSON.parse(json); } catch (e) {
          return cb(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        }
        delete data._id;
        updateDoc(doc(db, path, id), data)
          .then(() => cb(JSON.stringify({ ok: true, id })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      deleteDocOnce: (path, id, cb) => {
        deleteDoc(doc(db, path, id))
          .then(() => cb(JSON.stringify({ ok: true, id })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },
      // ---------- Orphan-triage (M5 server-bound) ----------
      // All three triage operations now route through the `triageOrphanReport`
      // Cloud Function. Audit entries are written server-side bound to the
      // actual mutation, eliminating the previous gap where a client could
      // batch a misleading audit with a different doc state (CWE-345).
      // The callable derives the canonical kinfolk display name from the
      // kinfolk/{id} doc - never trust client-supplied name.
      //
      // Auth context (admin claim) is attached automatically by the Firebase
      // SDK; wrapAdminCallable on the server gates by `admin` custom claim.

      assignKinfolkToOrphanReport: (reportId, kinfolkId, kinfolkName, _triagedBy, _triagedAt, cb) => {
        if (!reportId || !kinfolkId) {
          cb(JSON.stringify({ ok: false, error: 'reportId and kinfolkId are required' }));
          return;
        }
        httpsCallable(functions, 'triageOrphanReport')({
          action: 'ASSIGN',
          reportId,
          kinfolkId,
          suppliedName: kinfolkName || undefined,
        })
          .then(() => cb(JSON.stringify({ ok: true, id: reportId })))
          .catch(e => cb(JSON.stringify({
            ok: false,
            error: String(e && (e.message || e.code) || e),
            code: e && e.code ? String(e.code) : undefined,
          })));
      },
      markOrphanReportAsDuplicate: (reportId, duplicateOfReportId, _triagedBy, _triagedAt, cb) => {
        if (!reportId || !duplicateOfReportId) {
          cb(JSON.stringify({ ok: false, error: 'reportId and duplicateOfReportId are required' }));
          return;
        }
        httpsCallable(functions, 'triageOrphanReport')({
          action: 'DUPLICATE',
          reportId,
          duplicateOfReportId,
        })
          .then(() => cb(JSON.stringify({ ok: true, id: reportId })))
          .catch(e => cb(JSON.stringify({
            ok: false,
            error: String(e && (e.message || e.code) || e),
            code: e && e.code ? String(e.code) : undefined,
          })));
      },
      archiveOrphanReportAsBadData: (reportId, reason, _triagedBy, _triagedAt, cb) => {
        if (!reportId || !reason) {
          cb(JSON.stringify({ ok: false, error: 'reportId and reason are required' }));
          return;
        }
        httpsCallable(functions, 'triageOrphanReport')({
          action: 'ARCHIVE',
          reportId,
          reason,
        })
          .then(() => cb(JSON.stringify({ ok: true, id: reportId })))
          .catch(e => cb(JSON.stringify({
            ok: false,
            error: String(e && (e.message || e.code) || e),
            code: e && e.code ? String(e.code) : undefined,
          })));
      },

      markKinTaleReportSent: (reportId, sessionId, sentVia, deliveryReceiptId, sentAtIso, cb) => {
        if (!reportId || !sessionId) {
          cb(JSON.stringify({ ok: false, error: 'reportId and sessionId are required' }));
          return;
        }
        const batch = writeBatch(db);
        batch.update(doc(db, 'kin_care_reports', reportId), {
          status: 'SENT',
          sentAt: sentAtIso,
          sentVia: sentVia,
          deliveryReceiptId: deliveryReceiptId,
          updatedAt: new Date().toISOString(),
        });
        batch.update(doc(db, 'kin_care_sessions', sessionId), {
          reportIds: arrayUnion(reportId),
          sentReportCount: increment(1),
          autoCompleteEligible: true,
          updatedAt: new Date().toISOString(),
        });
        batch.commit()
          .then(() => cb(JSON.stringify({ ok: true, id: reportId })))
          .catch(e => cb(JSON.stringify({ ok: false, error: String(e.code || e.message || e) })));
      },

      // ---------- Auth ----------
      signIn: (email, password, cb) => {
        signInWithEmailAndPassword(auth, email, password)
          .then(cred => cb(JSON.stringify({
            ok: true,
            uid: cred.user.uid,
            email: cred.user.email,
          })))
          .catch(e => cb(JSON.stringify({
            ok: false,
            error: e.code || e.message || String(e),
          })));
      },
      signOut: (cb) => {
        signOut(auth)
          .then(() => cb('ok'))
          .catch(e => cb(String(e.code || e.message || e)));
      },
      onAuthChange: (cb) => {
        return onAuthStateChanged(auth, (user) => {
          cb(user ? JSON.stringify({ uid: user.uid, email: user.email }) : 'null');
        });
      },
      currentUser: () => {
        const u = auth.currentUser;
        return u ? JSON.stringify({ uid: u.uid, email: u.email, displayName: u.displayName ?? '' }) : 'null';
      },
      getIdToken: (forceRefresh, cb) => {
        const u = auth.currentUser;
        if (!u) {
          cb('');
          return;
        }
        u.getIdToken(!!forceRefresh)
          .then(token => cb(token || ''))
          .catch(err => {
            console.error('[auth] getIdToken', err);
            cb('');
          });
      },
      isCurrentUserAdmin: (forceRefresh, cb) => {
        const u = auth.currentUser;
        if (!u) {
          cb(false);
          return;
        }
        u.getIdTokenResult(!!forceRefresh)
          .then(result => cb(result && result.claims && result.claims.admin === true))
          .catch(err => {
            console.error('[auth] isCurrentUserAdmin', err);
            cb(false);
          });
      },
      // Stage 0I: read the `testTribeId` custom claim off the ID token. Returns the
      // string claim or '' (never null, so the wasm bridge sees a plain String).
      testTribeId: (forceRefresh, cb) => {
        const u = auth.currentUser;
        if (!u) {
          cb('');
          return;
        }
        u.getIdTokenResult(!!forceRefresh)
          .then(result => {
            const claim = result && result.claims && result.claims.testTribeId;
            cb(typeof claim === 'string' ? claim : '');
          })
          .catch(err => {
            console.error('[auth] testTribeId', err);
            cb('');
          });
      },
      sendPasswordReset: (email, cb) => {
        sendPasswordResetEmail(auth, email)
          .then(() => cb('ok'))
          .catch(e => cb(String(e.code || e.message || e)));
      },

      // Reauthenticate with the current password, then send a verify-before-update
      // link to the new address. The email flips only after the user confirms, so
      // we never report a fake "changed" state. Returns { ok } or { ok:false, error }.
      updateLoginEmail: (currentPassword, newEmail, cb) => {
        const u = auth.currentUser;
        if (!u) { cb(JSON.stringify({ ok: false, error: 'auth/no-current-user' })); return; }
        reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, currentPassword))
          .then(() => verifyBeforeUpdateEmail(u, newEmail))
          .then(() => cb(JSON.stringify({ ok: true })))
          .catch(e => cb(JSON.stringify({ ok: false, error: e.code || String(e) })));
      },
      // Reauthenticate with the current password, then set the new password.
      updateLoginPassword: (currentPassword, newPassword, cb) => {
        const u = auth.currentUser;
        if (!u) { cb(JSON.stringify({ ok: false, error: 'auth/no-current-user' })); return; }
        reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, currentPassword))
          .then(() => updatePassword(u, newPassword))
          .then(() => cb(JSON.stringify({ ok: true })))
          .catch(e => cb(JSON.stringify({ ok: false, error: e.code || String(e) })));
      },

      // ---------- Cloudinary signed upload (KinTale media) ----------
      // Uploads use short-lived signed parameters from Firebase Functions.
      // The API secret never ships to the browser. Returns:
      //   success → { ok: true, files: [<MediaFile-shape>...] }
      //   error   → { ok: false, error: string }
      // The user is shown a native file picker (multiple, image+video).
      // Per-file response objects mirror Cloudinary's body so the Kotlin side can
      // build a MediaFile without further REST calls.
      pickAndUploadKinTaleMedia: (paramsJson, maxFiles, cb) => {
        const params = JSON.parse(paramsJson);
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'image/*,video/*';
        picker.multiple = true;
        picker.style.display = 'none';
        document.body.appendChild(picker);

        const cleanup = () => {
          try { document.body.removeChild(picker); } catch (_) {}
        };

        // Detect cancel: the picker dispatches no `change` if the user closes
        // the dialog without picking, so we listen for window focus as a proxy.
        let resolved = false;
        const onCancel = () => {
          setTimeout(() => {
            if (resolved) return;
            if (!picker.files || picker.files.length === 0) {
              resolved = true;
              cleanup();
              cb(JSON.stringify({ ok: true, files: [] }));
            }
          }, 300);
        };
        window.addEventListener('focus', onCancel, { once: true });

        picker.addEventListener('change', async () => {
          resolved = true;
          const files = Array.from(picker.files || []);
          if (files.length === 0) {
            cleanup();
            return cb(JSON.stringify({ ok: true, files: [] }));
          }
          const capped = files.slice(0, maxFiles);
          const out = [];
          try {
            for (const file of capped) {
              const fd = new FormData();
              fd.append('file', file);
              fd.append('api_key', params.apiKey);
              fd.append('timestamp', String(params.timestamp));
              fd.append('signature', params.signature);
              if (params.folder) fd.append('folder', params.folder);
              // `auto` accepts both image & video. Cloudinary picks the right
              // resource_type and we read it from the response.
              const url = `https://api.cloudinary.com/v1_1/${params.cloudName}/auto/upload`;
              const resp = await fetch(url, { method: 'POST', body: fd });
              const body = await resp.json();
              if (!resp.ok) {
                cleanup();
                return cb(JSON.stringify({
                  ok: false,
                  error: (body && body.error && body.error.message) || `HTTP ${resp.status}`,
                  filesUploaded: out,
                }));
              }
              out.push({
                originalFileName: file.name,
                fileSizeBytes:    file.size,
                mimeType:         file.type,
                publicId:         body.public_id,
                secureUrl:        body.secure_url,
                resourceType:     body.resource_type,   // "image" | "video" | "raw"
                format:           body.format || '',
                width:            body.width || 0,
                height:           body.height || 0,
                durationSeconds:  body.duration || 0,
                createdAtIso:     body.created_at || new Date().toISOString(),
              });
            }
            cleanup();
            cb(JSON.stringify({ ok: true, files: out }));
          } catch (e) {
            cleanup();
            cb(JSON.stringify({ ok: false, error: String(e && e.message || e), filesUploaded: out }));
          }
        });

        picker.click();
      },
    };

    Object.freeze(__fb);
    Object.defineProperty(window, '__fb', {
      value: __fb,
      writable: false,
      configurable: false,
      enumerable: false,
    });

    // Signal ready (also locked-down so attacker can't fake a fresh "ready"
    // event after replacing __fb with a malicious proxy).
    Object.defineProperty(window, '__fbReady', {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false,
    });
    document.dispatchEvent(new Event('fb-ready'));
  