// Hermetic functions source for the AuntieOS visual-test harness ONLY.
//
// Re-exports ONLY the four read-only callables the web admin screens invoke,
// taken straight from MyTribe's COMPILED functions lib (the genuine handler
// wire — same code that runs in prod). We deliberately do NOT load MyTribe's
// full index: that would also register its firestore triggers (onInvoicesWrite,
// onNotificationCreate, ...) and pubsub crons, which would fire on the harness
// seed writes to overlapping collection names (invoices, notifications) and
// non-deterministically mutate screens the harness is not even testing. The
// visual gate must be hermetic — only the 4 callables, nothing else.
//
// The require path is the cross-repo MyTribe build; this file is local-only and
// is never deployed (firebase.dev.json is the only config that references it).
const lib = require('../../../../../../../Projects/testai/CascadeProjects/MyTribe/functions/lib/index.js');

exports.getFormSchema = lib.getFormSchema;
exports.listFormSchemas = lib.listFormSchemas;
exports.listTemplates = lib.listTemplates;
exports.listTemplateBindings = lib.listTemplateBindings;
