/**
 * The single code-owned source of truth for the RBAC+ABAC permission
 * catalog and the six seeded roles' bundles. `identity.seed.ts` writes
 * `permissions`/`roles`/`role_permissions` rows from exactly this file;
 * nothing else creates a permission or a role.
 *
 * Lives in `shared`, not `modules/identity`: every future module's
 * controller writes `@RequirePermission(PERMISSIONS.DOCTORS_VERIFY)`, and
 * putting the catalog inside `modules/identity` would force every module to
 * deep-import identity, which `backend/README.md` forbids.
 *
 * Granularity rule: one permission per screen/working-queue for reads, plus
 * one per state-changing action a role could plausibly be denied while
 * still keeping the read. Not one per API endpoint (unmanageable), not one
 * per SRS FR line (too coarse — FR-18.1 alone mixes account creation,
 * clinical verification and fee setting, three different roles).
 */

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

export const PERMISSIONS = {
  ADMINS_READ: 'admins.read',
  ADMINS_MANAGE: 'admins.manage',

  PATIENTS_READ: 'patients.read',
  PATIENTS_MANAGE_STATUS: 'patients.manage_status',

  DOCTORS_READ: 'doctors.read',
  DOCTORS_CREATE: 'doctors.create',
  DOCTORS_UPDATE: 'doctors.update',
  /** Clinical judgement — registration/credential sign-off, FR-18.1. Split from `doctors.update`. */
  DOCTORS_VERIFY: 'doctors.verify',
  DOCTORS_MANAGE_LISTING: 'doctors.manage_listing',
  /** Money, not profile — split from `doctors.update` so finance can set fees without editing clinical profiles. */
  DOCTORS_MANAGE_FEE: 'doctors.manage_fee',
  /** FR-1.5 — admin grants/revokes `doctors.seniority_level = 'expert'`. Clinical judgement, split from `doctors.update`. */
  DOCTORS_MANAGE_EXPERT_ROLE: 'doctors.manage_expert_role',

  SPECIALTIES_READ: 'specialties.read',
  SPECIALTIES_MANAGE: 'specialties.manage',
  SPECIALTIES_MANAGE_CLINICAL_TEMPLATES: 'specialties.manage_clinical_templates',

  CONCERNS_READ: 'concerns.read',
  CONCERNS_MANAGE: 'concerns.manage',

  APPOINTMENTS_READ: 'appointments.read',
  APPOINTMENTS_MANAGE: 'appointments.manage',

  AVAILABILITY_READ: 'availability.read',
  AVAILABILITY_MANAGE: 'availability.manage',

  PAYMENTS_READ: 'payments.read',
  PAYMENTS_REFUND: 'payments.refund',
  PAYMENTS_EXPORT: 'payments.export',
  PAYMENTS_MANAGE_CONFIG: 'payments.manage_config',

  /** The single most sensitive read in the panel (SRS 6.2 minimum-necessary) — kept alone, grantable in isolation. */
  CLINICAL_READ_RECORDS: 'clinical.read_records',

  GOVERNANCE_READ_QUEUES: 'governance.read_queues',
  GOVERNANCE_ACT_ALERTS: 'governance.act_alerts',
  GOVERNANCE_READ_CLARIFICATIONS: 'governance.read_clarifications',
  GOVERNANCE_MANAGE_CLARIFICATIONS: 'governance.manage_clarifications',
  GOVERNANCE_READ_QUALITY: 'governance.read_quality',
  GOVERNANCE_EXPORT: 'governance.export',

  CONTENT_READ: 'content.read',
  CONTENT_AUTHOR: 'content.author',
  /** Split from `content.author` — mirrors `content_review_status`'s draft -> in_clinical_review -> published state machine; publishing is by construction a different role's act. */
  CONTENT_PUBLISH: 'content.publish',
  CONTENT_MANAGE_NOTIFICATION_TEMPLATES: 'content.manage_notification_templates',
  CONTENT_MANAGE_FOLLOWUP_QUESTIONS: 'content.manage_followup_questions',

  SEARCH_MANAGE_MAPPING: 'search.manage_mapping',

  FEEDBACK_READ: 'feedback.read',
  FEEDBACK_MANAGE_COMPLAINTS: 'feedback.manage_complaints',

  COMPLIANCE_MANAGE_LEGAL_DOCUMENTS: 'compliance.manage_legal_documents',
  COMPLIANCE_MANAGE_DELETION_REQUESTS: 'compliance.manage_deletion_requests',

  AUDIT_READ: 'audit.read',
  AUDIT_EXPORT: 'audit.export',

  CONFIG_READ: 'config.read',
  CONFIG_MANAGE: 'config.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  key: PermissionKey;
  /** The grouping header on the admin access screen. */
  module: string;
  description: string;
}

const moduleOf = (key: PermissionKey): string => key.split('.')[0] ?? key;

const DESCRIPTIONS: Record<PermissionKey, string> = {
  [PERMISSIONS.ADMINS_READ]: 'View admin accounts and their roles/permissions.',
  [PERMISSIONS.ADMINS_MANAGE]: 'Create admin accounts and change their status, roles and permission grants.',
  [PERMISSIONS.PATIENTS_READ]: "View patients' account records.",
  [PERMISSIONS.PATIENTS_MANAGE_STATUS]: "Suspend or reinstate a patient's account.",
  [PERMISSIONS.DOCTORS_READ]: "View doctors' profiles and credentials.",
  [PERMISSIONS.DOCTORS_CREATE]: 'Create a doctor account.',
  [PERMISSIONS.DOCTORS_UPDATE]: "Edit a doctor's profile fields.",
  [PERMISSIONS.DOCTORS_VERIFY]: "Approve or reject a doctor's registration and credential documents.",
  [PERMISSIONS.DOCTORS_MANAGE_LISTING]: 'Toggle whether a doctor is listed/bookable and allows instant consult.',
  [PERMISSIONS.DOCTORS_MANAGE_FEE]: "Set a doctor's consultation fee.",
  [PERMISSIONS.DOCTORS_MANAGE_EXPERT_ROLE]: "Grant or revoke a doctor's expert (case-clarification) role.",
  [PERMISSIONS.SPECIALTIES_READ]: 'View specialties and their intake forms.',
  [PERMISSIONS.SPECIALTIES_MANAGE]: 'Add or edit specialties and their intake forms.',
  [PERMISSIONS.SPECIALTIES_MANAGE_CLINICAL_TEMPLATES]:
    'Edit a specialty’s default prescription/advice templates.',
  [PERMISSIONS.CONCERNS_READ]: 'View the concern taxonomy under each specialty.',
  [PERMISSIONS.CONCERNS_MANAGE]: 'Add or edit concerns in the taxonomy.',
  [PERMISSIONS.APPOINTMENTS_READ]: 'View scheduled and instant consultations.',
  [PERMISSIONS.APPOINTMENTS_MANAGE]: 'Cancel, reschedule or mark a consultation no-show.',
  [PERMISSIONS.AVAILABILITY_READ]: "View a doctor's schedule, blocked dates and bookable slots.",
  [PERMISSIONS.AVAILABILITY_MANAGE]: "Edit a doctor's scheduling settings (min notice, booking horizon).",
  [PERMISSIONS.PAYMENTS_READ]: 'View transactions and payout status.',
  [PERMISSIONS.PAYMENTS_REFUND]: 'Initiate a refund.',
  [PERMISSIONS.PAYMENTS_EXPORT]: 'Export transactions/refunds as CSV.',
  [PERMISSIONS.PAYMENTS_MANAGE_CONFIG]: 'Set the convenience fee percentage and GST rate.',
  [PERMISSIONS.CLINICAL_READ_RECORDS]: 'Read a consultation’s clinical notes and prescription.',
  [PERMISSIONS.GOVERNANCE_READ_QUEUES]:
    'View the pending case-summary, high-risk-alert and follow-up-alert worklists.',
  [PERMISSIONS.GOVERNANCE_ACT_ALERTS]: 'Acknowledge or close a safety alert.',
  [PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS]: 'View the case-clarification tracker.',
  [PERMISSIONS.GOVERNANCE_MANAGE_CLARIFICATIONS]: 'Assign an expert to a clarification case.',
  [PERMISSIONS.GOVERNANCE_READ_QUALITY]: 'View the quality dashboard and doctor reliability metrics.',
  [PERMISSIONS.GOVERNANCE_EXPORT]: 'Export governance/quality data as CSV.',
  [PERMISSIONS.CONTENT_READ]: 'View Care Hub content items.',
  [PERMISSIONS.CONTENT_AUTHOR]: 'Create or edit a Care Hub content item.',
  [PERMISSIONS.CONTENT_PUBLISH]: 'Move a content item through clinical review to published.',
  [PERMISSIONS.CONTENT_MANAGE_NOTIFICATION_TEMPLATES]: 'Edit notification copy.',
  [PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS]: 'Edit follow-up pathway question sets and red-flag rules.',
  [PERMISSIONS.SEARCH_MANAGE_MAPPING]: 'Edit the symptom-to-specialty mapping, synonyms and crisis keywords.',
  [PERMISSIONS.FEEDBACK_READ]: 'View patient feedback and complaints.',
  [PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS]: 'Work a complaint through to resolution.',
  [PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS]: 'Publish a new version of a legal document.',
  [PERMISSIONS.COMPLIANCE_MANAGE_DELETION_REQUESTS]: 'Review and execute a data-deletion request.',
  [PERMISSIONS.AUDIT_READ]: 'Search the audit log.',
  [PERMISSIONS.AUDIT_EXPORT]: 'Export audit log entries.',
  [PERMISSIONS.CONFIG_READ]: 'View app configuration values.',
  [PERMISSIONS.CONFIG_MANAGE]: 'Edit app configuration values.',
};

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = Object.values(PERMISSIONS).map((key) => ({
  key,
  module: moduleOf(key),
  description: DESCRIPTIONS[key],
}));

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

export const ROLE_CODES = [
  'super_admin',
  'operations',
  'clinical_governance',
  'care_coordinator',
  'finance',
  'content',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  description: string;
}

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  { code: 'super_admin', name: 'Super Admin', description: 'Unrestricted access to every panel section.' },
  {
    code: 'operations',
    name: 'Operations',
    description: 'Day-to-day running of doctors, appointments and support — no clinical reads, no money movement.',
  },
  {
    code: 'clinical_governance',
    name: 'Clinical Governance',
    description: 'Clinical sign-off, safety alerts, case clarification and content approval.',
  },
  {
    code: 'care_coordinator',
    name: 'Care Coordinator',
    description: 'Receives and acts on safety and follow-up alerts (SRS 2.2).',
  },
  { code: 'finance', name: 'Finance', description: 'Payments, refunds, doctor fees and financial exports.' },
  { code: 'content', name: 'Content', description: 'Authors Care Hub content and notification copy.' },
];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionKey[]> = {
  // All 43 — seeded explicitly (so `GET /admin/roles` shows the truth) AND
  // short-circuited in the resolution query (identity-access.repository.ts),
  // so a permission added between deploys can never lock the owner out
  // before the seed re-runs.
  super_admin: ALL_PERMISSIONS,

  operations: [
    PERMISSIONS.ADMINS_READ,
    PERMISSIONS.PATIENTS_READ,
    PERMISSIONS.PATIENTS_MANAGE_STATUS,
    PERMISSIONS.DOCTORS_READ,
    PERMISSIONS.DOCTORS_CREATE,
    PERMISSIONS.DOCTORS_UPDATE,
    PERMISSIONS.DOCTORS_MANAGE_LISTING,
    PERMISSIONS.SPECIALTIES_READ,
    PERMISSIONS.CONCERNS_READ,
    PERMISSIONS.APPOINTMENTS_READ,
    PERMISSIONS.APPOINTMENTS_MANAGE,
    PERMISSIONS.AVAILABILITY_READ,
    PERMISSIONS.AVAILABILITY_MANAGE,
    PERMISSIONS.PAYMENTS_READ,
    PERMISSIONS.GOVERNANCE_READ_QUEUES,
    PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS,
    PERMISSIONS.GOVERNANCE_READ_QUALITY,
    PERMISSIONS.GOVERNANCE_EXPORT,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.FEEDBACK_READ,
    PERMISSIONS.FEEDBACK_MANAGE_COMPLAINTS,
    PERMISSIONS.CONFIG_READ,
    PERMISSIONS.CONFIG_MANAGE,
    PERMISSIONS.AUDIT_READ,
  ],

  clinical_governance: [
    PERMISSIONS.PATIENTS_READ,
    PERMISSIONS.DOCTORS_READ,
    PERMISSIONS.DOCTORS_VERIFY,
    PERMISSIONS.DOCTORS_MANAGE_EXPERT_ROLE,
    PERMISSIONS.SPECIALTIES_READ,
    PERMISSIONS.SPECIALTIES_MANAGE,
    PERMISSIONS.SPECIALTIES_MANAGE_CLINICAL_TEMPLATES,
    PERMISSIONS.CONCERNS_READ,
    PERMISSIONS.CONCERNS_MANAGE,
    PERMISSIONS.APPOINTMENTS_READ,
    PERMISSIONS.CLINICAL_READ_RECORDS,
    PERMISSIONS.GOVERNANCE_READ_QUEUES,
    PERMISSIONS.GOVERNANCE_ACT_ALERTS,
    PERMISSIONS.GOVERNANCE_READ_CLARIFICATIONS,
    PERMISSIONS.GOVERNANCE_MANAGE_CLARIFICATIONS,
    PERMISSIONS.GOVERNANCE_READ_QUALITY,
    PERMISSIONS.GOVERNANCE_EXPORT,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.CONTENT_PUBLISH,
    PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS,
    PERMISSIONS.SEARCH_MANAGE_MAPPING,
    PERMISSIONS.FEEDBACK_READ,
    PERMISSIONS.AUDIT_READ,
  ],

  // Deliberately NO clinical.read_records: a coordinator acts on the alert,
  // they do not read the consultation note (SRS 6.2 minimum-necessary).
  // Flagged in the implementation plan as the one bundle decision most
  // likely to need client confirmation.
  care_coordinator: [
    PERMISSIONS.PATIENTS_READ,
    PERMISSIONS.DOCTORS_READ,
    PERMISSIONS.APPOINTMENTS_READ,
    PERMISSIONS.APPOINTMENTS_MANAGE,
    PERMISSIONS.AVAILABILITY_READ,
    PERMISSIONS.GOVERNANCE_READ_QUEUES,
    PERMISSIONS.GOVERNANCE_ACT_ALERTS,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.FEEDBACK_READ,
  ],

  finance: [
    PERMISSIONS.PATIENTS_READ,
    PERMISSIONS.DOCTORS_READ,
    PERMISSIONS.DOCTORS_MANAGE_FEE,
    PERMISSIONS.APPOINTMENTS_READ,
    PERMISSIONS.PAYMENTS_READ,
    PERMISSIONS.PAYMENTS_REFUND,
    PERMISSIONS.PAYMENTS_EXPORT,
    PERMISSIONS.PAYMENTS_MANAGE_CONFIG,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.AUDIT_EXPORT,
  ],

  content: [
    PERMISSIONS.SPECIALTIES_READ,
    PERMISSIONS.CONCERNS_READ,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.CONTENT_AUTHOR,
    PERMISSIONS.CONTENT_MANAGE_NOTIFICATION_TEMPLATES,
    PERMISSIONS.FEEDBACK_READ,
  ],
};
