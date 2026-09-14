'use strict';

/**
 * #829: an Emergency Contact is never messaged and never written about. The
 * kinfolk doc the copy generator loads carries `emergencyContacts` and, until
 * the migration is verified, the old flat triple. None of it may reach a
 * prompt, a draft or a log, so it is dropped the moment the doc is read.
 *
 * This is the ONE file under auntieos-admin/web/functions allowed to name the
 * fields; mytribe/functions/test/emergencyContactsNeverMessaged.test.ts scans
 * the rest of the tree and fails on any other mention.
 */
const EMERGENCY_CONTACT_KEYS = Object.freeze([
  'emergencyContacts',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
]);

/** A shallow copy of `doc` without any Emergency Contact key. `null`/`undefined` pass through. */
function withoutEmergencyContacts(doc) {
  if (doc === null || doc === undefined || typeof doc !== 'object') return doc;
  const copy = { ...doc };
  for (const key of EMERGENCY_CONTACT_KEYS) delete copy[key];
  return copy;
}

module.exports = { EMERGENCY_CONTACT_KEYS, withoutEmergencyContacts };
