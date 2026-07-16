// Seeds the LOCAL Firebase emulators for web visual capture (no prod data touched).
// Creates a sandboxed admin user (admin claim is safe here — emulator is ephemeral) and
// writes demo kinfolk/kin/sessions/invoices into the Firestore emulator. Owner bearer
// bypasses security rules on the emulator. Fail loud: any non-OK response aborts.
const PROJECT = "auntieos-ttpc";
const AUTH = "http://localhost:9099";
const FS = "http://localhost:8085";
const ADMIN_EMAIL = "visual-tester@local.test";
const ADMIN_PASSWORD = "visual-emulator-pw-123";

async function must(res, what) {
  if (!res.ok) {
    console.error(`FATAL seeding ${what}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json().catch(() => ({}));
}

// --- Auth: create admin + set claim ---
const signUp = await must(
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true }),
  }),
  "admin signUp"
);
const localId = signUp.localId;
await must(
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ admin: true }) }),
  }),
  "admin claim"
);
console.log(`Seeded admin ${ADMIN_EMAIL} (uid ${localId}) with admin claim`);

// --- Firestore: encode JS -> Firestore REST value ---
function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  throw new Error("unsupported " + typeof v);
}
async function put(coll, id, obj) {
  const url = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${coll}?documentId=${id}`;
  await must(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) }),
    }),
    `${coll}/${id}`
  );
}

const kinfolk = [
  ["demo-kf-1", "Wanda", "Thorne", "The Thornes, Riverside", ["Biscuit", "Gravy"]],
  ["demo-kf-2", "Nora", "Halbrook", "The Halbrooks, Oak Hill", ["Marigold"]],
  ["demo-kf-3", "Tessa", "Brooks", "The Brooks, Maple Grove", ["Pepper"]],
  ["demo-kf-4", "Priya", "Ashford", "The Ashfords, Cedar Park", ["Clover", "Sage"]],
  ["demo-kf-5", "Iris", "Ellery", "The Ellerys, Riverside", ["Cocoa", "Olive"]],
  ["demo-kf-6", "Fern", "Calloway", "Meet & Greet Thu", ["Pip"]],
];
for (const [id, fn, ln, addr, tags] of kinfolk) {
  await put("kinfolk", id, {
    firstName: fn, lastName: ln, status: "active", serviceAddress: addr,
    phoneNumber: "555-0100", email: `${fn.toLowerCase()}@example.com`, tags, _demo: true,
  });
}

const kin = [
  ["k1", "Biscuit", "demo-kf-1", "Dog", "Beagle"], ["k2", "Gravy", "demo-kf-1", "Dog", "Lab"],
  ["k3", "Marigold", "demo-kf-2", "Cat", "Tabby"], ["k4", "Pepper", "demo-kf-3", "Dog", "Corgi"],
  ["k5", "Clover", "demo-kf-4", "Cat", "Calico"], ["k6", "Sage", "demo-kf-4", "Cat", "Siamese"],
  ["k7", "Cocoa", "demo-kf-5", "Dog", "Poodle"], ["k8", "Olive", "demo-kf-5", "Dog", "Terrier"],
  ["k9", "Pip", "demo-kf-6", "Dog", "Pug"],
];
for (const [id, name, kfId, species, breed] of kin) {
  await put("kin", id, { name, kinfolkId: kfId, species, breed, status: "active", _demo: true });
}

await put("kin_care_sessions", "demo-s1", {
  kinfolkId: "demo-kf-1", kinfolkName: "Wanda Thorne", serviceType: "Dog Walk",
  startTime: "2026-05-31T09:00", status: "COMPLETED", _demo: true,
});
await put("kin_care_sessions", "demo-s2", {
  kinfolkId: "demo-kf-5", kinfolkName: "Iris Ellery", serviceType: "Drop-In Visit",
  startTime: "2026-05-31T14:00", status: "SCHEDULED", _demo: true,
});

await put("invoices", "demo-inv-1", {
  kinfolkId: "demo-kf-1", kinfolkName: "Wanda Thorne", invoiceNumber: "INV-1001",
  client: "Wanda Thorne", address: "The Thornes, Riverside", date: "2026-05-20",
  terms: "Net 15", dueDate: "2026-06-04", _demo: true,
});

// --- kin_care_reports (KinTale logs + report screen). KinTaleReportScreen matches
//     report.sessionId == route param, so demo-r1.sessionId = demo-s1 (set VISUAL_DEMO_REPORT_ID=demo-s1). ---
await put("kin_care_reports", "demo-r1", {
  sessionId: "demo-s1", kinfolkId: "demo-kf-1", kinfolkName: "Wanda Thorne", serviceType: "Dog Walk",
  visitDate: "2026-05-31", status: "SENT", sentVia: "demo_seed", authorDisplayName: "Auntie Demo",
  arrivedAt: "2026-05-31T09:00:00Z", departedAt: "2026-05-31T09:45:00Z", kinIds: ["k1", "k2"],
  bodyCopy: "Biscuit and Gravy had a great walk around Riverside. Both ate well; fresh water topped off.",
  createdAt: "2026-05-31T09:45:00Z", _demo: true,
});
await put("kin_care_reports", "demo-r2", {
  sessionId: "demo-s2", kinfolkId: "demo-kf-5", kinfolkName: "Iris Ellery", serviceType: "Drop-In Visit",
  visitDate: "2026-05-30", status: "DRAFT", sentVia: "", authorDisplayName: "Auntie Demo", kinIds: ["k7", "k8"],
  bodyCopy: "Cocoa and Olive were napping in the sun. Quick cuddle and a refill of kibble.",
  createdAt: "2026-05-30T14:00:00Z", _demo: true,
});

// --- payments ---
await put("payments", "demo-pay-1", {
  kinfolkId: "demo-kf-1", kinfolkName: "Wanda Thorne", client: "Wanda Thorne", date: "2026-05-21",
  amount: 45, tip: 5, paymentMethod: "Card", referenceNumber: "PMT-2001", _demo: true,
});
await put("payments", "demo-pay-2", {
  kinfolkId: "demo-kf-5", kinfolkName: "Iris Ellery", client: "Iris Ellery", date: "2026-05-19",
  amount: 30, tip: 0, paymentMethod: "Cash", referenceNumber: "PMT-2002", _demo: true,
});

// --- activity_log ---
for (const [id, actionType, description, status] of [
  ["demo-a1", "SESSION_COMPLETED", "Auntie completed a Dog Walk for Wanda Thorne", "SUCCESS"],
  ["demo-a2", "CONTENT_KINTALE_SENT", "Auntie sent a KinTale to Iris Ellery", "SUCCESS"],
  ["demo-a3", "INVOICE_CREATED", "Invoice INV-1001 created for Wanda Thorne", "SUCCESS"],
  ["demo-a4", "AUTH_ADMIN_SIGN_IN", "Admin signed in", "INFO"],
]) {
  await put("activity_log", id, {
    timestamp: "2026-05-31T10:00:00Z", actionType, description, status, actorId: "demo-seed-author",
    actorRole: "AUNTIE", severity: "info", targetId: "demo-family-001", createdAt: "2026-05-31T10:00:00Z", _demo: true,
  });
}

// --- training_documents ---
await put("training_documents", "demo-td-1", {
  title: "Dog Walking SOP", communicationType: "Procedure", uploadedAt: "2026-05-10",
  content: "Always check the leash and harness before departure. Log start and end GPS.", _demo: true,
});
await put("training_documents", "demo-td-2", {
  title: "Medication Handling", communicationType: "Policy", uploadedAt: "2026-05-12",
  content: "Record dosage and time for every administered medication. Confirm with kinfolk.", _demo: true,
});

// --- business_settings (SettingsScreen listens the collection, uses first doc) ---
await put("business_settings", "demo-bs-1", {
  businessName: "Tribe Tails Care", businessEmail: "hello@tribetails.com", businessPhone: "555-0100",
  businessAddress: "Riverside, Demo City", _demo: true,
});

// --- notifications (rule firestore.rules:369 requires recipientUid == signed-in admin uid) ---
for (const [id, category, status, body] of [
  ["demo-n1", "booking.created", "UNREAD", "New booking request from Wanda Thorne"],
  ["demo-n2", "kintale.sent", "READ", "KinTale delivered to Iris Ellery"],
  ["demo-n3", "payment.received", "UNREAD", "Payment received from Wanda Thorne"],
]) {
  await put("notifications", id, {
    recipientUid: localId, key: category, category, status, mode: "in_app", channels: ["in_app"],
    body, createdAt: "2026-05-31T08:00:00Z", _demo: true,
  });
}

// --- inbox: voicemails / calls_log / sms_messages / emails (InboxScreen merges all four) ---
await put("voicemails", "demo-vm-1", { kinfolkName: "Wanda Thorne", callerNumber: "555-0100", timestamp: "2026-05-31T07:30:00Z", transcript: "Hi, just confirming today's walk. Thanks!", direction: "inbound", status: "new", _demo: true });
await put("calls_log", "demo-cl-1", { kinfolkName: "Iris Ellery", counterpartNumber: "555-0105", timestamp: "2026-05-30T16:00:00Z", direction: "outbound", status: "completed", durationSeconds: 120, _demo: true });
await put("sms_messages", "demo-sms-1", { kinfolkName: "Tessa Brooks", counterpartNumber: "555-0102", timestamp: "2026-05-31T06:45:00Z", body: "Pepper is doing great today!", direction: "outbound", status: "sent", _demo: true });
await put("emails", "demo-em-1", { kinfolkName: "Priya Ashford", counterpartNumber: "priya@example.com", timestamp: "2026-05-29T12:00:00Z", subject: "Weekly summary", body: "Here is the weekly care summary for Clover and Sage.", direction: "outbound", status: "sent", _demo: true });

// --- emailTemplates (listTemplates -> template-bank screen). Doc id = templateId.
//     Titles/categories mirror ui-ideas/auntieos-template-bank-2026-05-27.html so the
//     rebaselined golden resembles the intended design. Body/subject are obvious
//     harness fixtures (never customer-facing — emulator is ephemeral). ---
for (const [id, title, category, tags, subject] of [
  ["welcome.kinfolk", "Welcome to TribeTails", "Onboarding", ["welcome", "signup"], "Welcome to TribeTails"],
  ["booking.confirmed", "Booking confirmed", "Bookings", ["booking", "confirm"], "Your booking is confirmed"],
  ["booking.reminder", "Visit reminder", "Bookings", ["booking", "reminder"], "Reminder: upcoming visit"],
  ["invoice.sent", "Invoice sent", "Invoicing", ["invoice"], "Your invoice is ready"],
  ["reengage.lapsed", "We miss you", "Re-engagement", ["reengage"], "It has been a while"],
]) {
  await put("emailTemplates", id, {
    title, category, tags, subject,
    body: "[harness fixture body — visual test only]",
    html: null, description: `${category} template`, updatedAtMs: 1748736000000, _demo: true,
  });
}

// --- notificationTemplateBindings (listTemplateBindings -> template-assignment screen).
//     Doc id = catalogKey. Mirrors ui-ideas/auntieos-template-assignment-2026-05-27.html. ---
for (const [id, templateId, audience, triggerKey, active] of [
  ["kincare.booking.confirm", "booking.confirmed", "kinfolk", "booking.confirmed", true],
  ["kincare.booking.reminder", "booking.reminder", "kinfolk", "booking.reminder", true],
  ["invoice.sent", "invoice.sent", "kinfolk", "invoice.sent", true],
  ["invoice.sent.admin", "invoice.sent", "admin", "invoice.sent", true],
  ["reengage.lapsed", "reengage.lapsed", "kinfolk", "reengage.lapsed", false],
]) {
  await put("notificationTemplateBindings", id, { templateId, audience, triggerKey, active, _demo: true });
}

// --- formSchemas (listFormSchemas -> formschema-list; getFormSchema -> formschema-editor).
//     The five admin-authored profile forms named in getFormSchema's doc comment. Only the
//     editor target (tribeProfile, set VISUAL_DEMO_SCHEMA_ID=tribeProfile) needs full
//     sections; the rest just need summary fields for the list. Mirrors
//     ui-ideas/auntieos-formschema-editor-2026-05-27.html. ---
await put("formSchemas", "tribeProfile", {
  name: "Tribe Profile", description: "Household-level profile fields shown in MyTribe.",
  version: 3, updatedAt: "2026-05-27T18:00:00Z", updatedBy: "visual-tester@local.test",
  sections: [
    {
      title: "Household basics", description: "Core details about the household.",
      fields: [
        { key: "householdName", label: "Household name", type: "text", required: true, helperText: null, placeholder: "The Thornes", options: null, defaultValue: null, group: "left-column" },
        { key: "homeType", label: "Home type", type: "select", required: false, helperText: null, placeholder: null, options: ["House", "Apartment", "Condo"], defaultValue: "House", group: "left-column" },
        { key: "householdSize", label: "Household size", type: "select", required: false, helperText: "Number of residents", placeholder: null, options: ["Small", "Medium", "Large"], defaultValue: null, group: "right-column" },
      ],
    },
    {
      title: "Care notes", description: "Anything the auntie should know.",
      fields: [
        { key: "allergies", label: "Allergies", type: "textarea", required: false, helperText: "Pet or household allergies", placeholder: "List any allergies", options: null, defaultValue: null, group: null },
        { key: "preferredContact", label: "Preferred contact", type: "select", required: false, helperText: null, placeholder: null, options: ["Phone", "Email", "Text"], defaultValue: "Text", group: null },
        { key: "consentPhotos", label: "Photos OK in KinTales", type: "checkbox", required: false, helperText: null, placeholder: null, options: null, defaultValue: "true", group: null },
      ],
    },
  ],
  _demo: true,
});
for (const [id, name, version, updatedAt] of [
  ["accountSettings", "Account Settings", 2, "2026-05-24T12:00:00Z"],
  ["notificationSettings", "Notification Settings", 1, "2026-05-20T09:30:00Z"],
  ["kinProfile", "Kin Profile", 4, "2026-05-26T15:45:00Z"],
  ["homeInformation", "Home Information", 2, "2026-05-22T11:15:00Z"],
]) {
  await put("formSchemas", id, {
    name, version, updatedAt, updatedBy: "visual-tester@local.test",
    description: `${name} form`, sections: [], _demo: true,
  });
}

console.log("Seeded 5 emailTemplates, 5 templateBindings, 5 formSchemas (callable-backed screens)");
console.log("Seeded 6 kinfolk, 9 kin, 2 sessions, 1 invoice into Firestore emulator");
console.log(`EMU_ADMIN_EMAIL=${ADMIN_EMAIL}`);
console.log(`EMU_ADMIN_PASSWORD=${ADMIN_PASSWORD}`);
