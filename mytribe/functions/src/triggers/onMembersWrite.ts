import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapTrigger } from '../lib/wrapTrigger';

export const onMembersWrite = onDocumentWritten(
  { document: 'families/{familyId}/members/{uid}', secrets: ['SENTRY_DSN'] },
  wrapTrigger('onMembersWrite', async (event) => {
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    if (!before || !after) return;
    const beforePerms = (before.permissions ?? {}) as Record<string, boolean>;
    const afterPerms = (after.permissions ?? {}) as Record<string, boolean>;
    for (const k of Object.keys({ ...beforePerms, ...afterPerms })) {
      if (beforePerms[k] !== afterPerms[k]) {
        const auditEvent = afterPerms[k]
          ? (k === 'billing_full' ? AUDIT_EVENTS.PERM_BILLING_GRANTED : AUDIT_EVENTS.PERM_GRANTED)
          : (k === 'billing_full' ? AUDIT_EVENTS.PERM_BILLING_REVOKED : AUDIT_EVENTS.PERM_REVOKED);
        await writeAuditEntry({
          status: 'SUCCESS',
          event: auditEvent,
          severity: k === 'billing_full' ? 'warn' : 'info',
          actorRole: 'SYSTEM',
          familyId: event.params.familyId,
          targetUid: event.params.uid,
          payload: { perm: k, value: afterPerms[k], source: 'trigger' },
        });
      }
    }
  }),
);
