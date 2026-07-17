export type MemberRole = 'PRIMARY' | 'SECONDARY';
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export type InviteStatus = 'PENDING' | 'EMAIL_SENT' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
export type ActorRole = 'PRIMARY' | 'SECONDARY' | 'AUNTIE' | 'SYSTEM';
export type Severity = 'info' | 'warn' | 'critical';

export interface MemberPermissions {
  billing_full: boolean;
  messaging_direct: boolean;
  messaging_group: boolean;
  kin_edit: boolean;
  kintales_only: boolean;
  home_access: boolean;
}

export const FULL_PERMISSIONS: MemberPermissions = {
  billing_full: true,
  messaging_direct: true,
  messaging_group: true,
  kin_edit: true,
  kintales_only: true,
  home_access: true,
};

export const KINTALES_ONLY_PERMISSIONS: MemberPermissions = {
  billing_full: false,
  messaging_direct: false,
  messaging_group: false,
  kin_edit: false,
  kintales_only: true,
  home_access: false,
};

export interface MemberDoc {
  uid: string;
  displayName: string;
  avatarUrl?: string;
  email?: string;
  phone?: string;
  role: MemberRole;
  secondaryLabel?: string | null;
  permissions: MemberPermissions;
  status: MemberStatus;
  invitedAt?: FirebaseFirestore.Timestamp;
  joinedAt?: FirebaseFirestore.Timestamp;
  lastSeenAt?: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface FamilyDoc {
  displayName: string;
  primaryUid: string;
  themeConfigRef: string;
  flags: {
    tribePinSet: boolean;
    tribePinChangePending: boolean;
    unverified: boolean;
    foundationV1MigratedAt?: FirebaseFirestore.Timestamp;
  };
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface InviteRequestDoc {
  tribeId: string;
  primaryUid: string;
  invitedEmail: string;
  invitedPhone?: string;
  secondaryLabel?: string | null;
  proposedPermissions: MemberPermissions;
  proposedRole: MemberRole;
  requiresAuntieAck: boolean;
  status: InviteStatus;
  auntieNotifiedAt?: FirebaseFirestore.Timestamp;
  sentToInviteeAt?: FirebaseFirestore.Timestamp;
  acceptedUid?: string;
  expiresAt: FirebaseFirestore.Timestamp;
  createdAt: FirebaseFirestore.Timestamp;
}

export interface SharedKinTaleDoc {
  tribeId: string;
  sourceKinTaleId: string;
  scrubbedPayload: {
    authorDisplayName: string;
    body: string;
    photos: string[];
  };
  includePhotos: boolean;
  expiresAt: FirebaseFirestore.Timestamp;
  passcodeHash?: string;
  revoked: boolean;
  createdBy: string;
  createdAt: FirebaseFirestore.Timestamp;
}

export interface AuditLogDoc {
  event: string;
  severity: Severity;
  actorUid?: string;
  actorRole: ActorRole;
  targetUid?: string;
  familyId?: string;
  payload: Record<string, unknown>;
  requestId?: string;
  clientRequestId?: string;
  ip?: string;
  userAgent?: string;
  createdAt: FirebaseFirestore.Timestamp;
}

export interface ClientDoc {
  email?: string;
  displayName: string;
  phone?: string;
  preferredContact?: 'email' | 'phone';
  avatarUrl?: string;
  homeAddress?: string;
  kinfolkIds: string[];
  recoveryContacts?: { backupEmail?: string; backupPhone?: string };
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export const SECONDARY_LABEL_MAX = 24;
export const INVITE_TTL_DAYS = 14;
export const SHARE_DEFAULT_TTL_DAYS = 30;
