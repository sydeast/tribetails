import { resolveBusinessAdminUids } from '../lib/businessAdmins';
import type { EnqueueArgs, NotificationDef, RecipientResolver } from './types';

export interface ResolvedRecipient {
  uid: string;
  collection: 'clients' | 'staff';
}

/**
 * Resolves a notification dispatch to one or more concrete recipients,
 * each tagged with the collection their notificationPrefs live in.
 *
 * - 'specificUid' / 'kinfolkAcct' → caller-supplied uid, treated as kinfolk (clients/).
 * - 'businessAdmins'              → reads businessSettings/admins.uids, treated as staff.
 * - 'auntieAssignedToKincare'     → reads args.data.assignedAuntieUid, treated as staff.
 *
 * Throws on misuse, callers must pass the right resolver hints in `args.data`.
 */
export async function resolveRecipients(
  def: NotificationDef,
  args: EnqueueArgs,
  resolverOverride?: RecipientResolver,
): Promise<ResolvedRecipient[]> {
  const resolver = resolverOverride ?? def.recipientResolver;
  switch (resolver) {
    case 'kinfolkAcct':
    case 'specificUid': {
      if (!args.recipientUid) {
        throw new Error(`recipientResolver(${def.key}): recipientUid required for ${resolver}`);
      }
      return [{ uid: args.recipientUid, collection: 'clients' }];
    }

    case 'businessAdmins': {
      // See lib/businessAdmins.ts: the roster document had no writer anywhere
      // and did not exist in prod, so all 16 businessAdmins keys threw here and
      // the operator was never notified of a booking, message or bad rating.
      const uids = await resolveBusinessAdminUids(`recipientResolver(${def.key})`);
      return uids.map((uid) => ({ uid, collection: 'staff' as const }));
    }

    case 'auntieAssignedToKincare': {
      const auntieUid = args.data['assignedAuntieUid'];
      if (typeof auntieUid !== 'string' || !auntieUid) {
        throw new Error(
          `recipientResolver(${def.key}): args.data.assignedAuntieUid required for auntieAssignedToKincare`,
        );
      }
      return [{ uid: auntieUid, collection: 'staff' }];
    }

    default: {
      const exhaustive: never = resolver;
      throw new Error(`recipientResolver(${def.key}): unknown resolver '${String(exhaustive)}'`);
    }
  }
}
