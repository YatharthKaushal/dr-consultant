import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every Postgres ENUM type used across the schema, ported 1:1 from `docs/erd.sql`.
 *
 * One block per enum: the value tuple (also the runtime source of truth for
 * validation), the derived TS union type, and the `pgEnum` used by table columns.
 */

/* -------------------------------------------------------------------------- */

export const ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export const accountStatusEnum = pgEnum('account_status', ACCOUNT_STATUSES);

/**
 * Who an account belongs to. Distinct from `party` and `actor_type` even
 * though all three overlap — both of those carry `system`, which can never
 * request an OTP, own a specialty association, or be the audience of a
 * sign-in flow. A third enum whose *value set* genuinely differs is more
 * justified than reusing either.
 */
export const ACCOUNT_TYPES = ['patient', 'doctor', 'admin'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES);

export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];
export const genderEnum = pgEnum('gender', GENDERS);

export const DOCTOR_SENIORITY_LEVELS = ['standard', 'expert'] as const;
export type DoctorSeniority = (typeof DOCTOR_SENIORITY_LEVELS)[number];
export const doctorSeniorityEnum = pgEnum('doctor_seniority', DOCTOR_SENIORITY_LEVELS);

export const DOCTOR_VERIFICATION_STATUSES = [
  'pending',
  'under_review',
  'verified',
  'rejected',
  'suspended',
] as const;
export type DoctorVerificationStatus = (typeof DOCTOR_VERIFICATION_STATUSES)[number];
export const doctorVerificationStatusEnum = pgEnum(
  'doctor_verification_status',
  DOCTOR_VERIFICATION_STATUSES,
);

export const DOCTOR_PRESENCE_STATES = [
  'offline',
  'available_now',
  'request_pending',
  'in_consultation',
  'completing_notes',
  'paused',
  'scheduled_only',
] as const;
export type DoctorPresence = (typeof DOCTOR_PRESENCE_STATES)[number];
export const doctorPresenceEnum = pgEnum('doctor_presence', DOCTOR_PRESENCE_STATES);

export const DOCTOR_DOCUMENT_TYPES = [
  'degree_certificate',
  'registration_certificate',
  'identity_proof',
  'address_proof',
  'experience_letter',
  'profile_photo',
  'signature',
  'other',
] as const;
export type DoctorDocumentType = (typeof DOCTOR_DOCUMENT_TYPES)[number];
export const doctorDocumentTypeEnum = pgEnum('doctor_document_type', DOCTOR_DOCUMENT_TYPES);

export const DOCUMENT_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DocumentReviewStatus = (typeof DOCUMENT_REVIEW_STATUSES)[number];
export const documentReviewStatusEnum = pgEnum('document_review_status', DOCUMENT_REVIEW_STATUSES);

export const AVAILABILITY_RULE_TYPES = ['weekly', 'blocked', 'custom_hours'] as const;
export type AvailabilityRuleType = (typeof AVAILABILITY_RULE_TYPES)[number];
export const availabilityRuleTypeEnum = pgEnum('availability_rule_type', AVAILABILITY_RULE_TYPES);

export const CONSULTATION_MODES = ['scheduled', 'instant'] as const;
export type ConsultationMode = (typeof CONSULTATION_MODES)[number];
export const consultationModeEnum = pgEnum('consultation_mode', CONSULTATION_MODES);

export const CONSULTATION_STATUSES = [
  'pending_payment',
  'scheduled',
  'awaiting_doctor',
  'in_progress',
  'awaiting_documentation',
  'completed',
  'cancelled',
  'no_show',
  'expired',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];
export const consultationStatusEnum = pgEnum('consultation_status', CONSULTATION_STATUSES);

export const PARTIES = ['patient', 'doctor', 'admin', 'system'] as const;
export type Party = (typeof PARTIES)[number];
export const partyEnum = pgEnum('party', PARTIES);

export const FOLLOWUP_STATUSES = ['none', 'active', 'completed', 'cancelled'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];
export const followupStatusEnum = pgEnum('followup_status', FOLLOWUP_STATUSES);

export const INSTANT_CONSULTANCY_OUTCOMES = [
  'pending',
  'accepted',
  'declined',
  'timed_out',
  'superseded',
] as const;
export type InstantConsultancyOutcome = (typeof INSTANT_CONSULTANCY_OUTCOMES)[number];
export const instantConsultancyOutcomeEnum = pgEnum(
  'instant_consultancy_outcome',
  INSTANT_CONSULTANCY_OUTCOMES,
);

export const PAYMENT_STATUSES = ['created', 'pending', 'paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

export const RISK_CATEGORIES = ['low', 'moderate', 'high'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export const riskCategoryEnum = pgEnum('risk_category', RISK_CATEGORIES);

export const PATIENT_FILE_CATEGORIES = [
  'medical_history',
  'report',
  'photo',
  'prescription_pdf',
  'clarification_attachment',
] as const;
export type PatientFileCategory = (typeof PATIENT_FILE_CATEGORIES)[number];
export const patientFileCategoryEnum = pgEnum('patient_file_category', PATIENT_FILE_CATEGORIES);

export const REPORT_REQUEST_STATUSES = ['open', 'fulfilled', 'cancelled'] as const;
export type ReportRequestStatus = (typeof REPORT_REQUEST_STATUSES)[number];
export const reportRequestStatusEnum = pgEnum('report_request_status', REPORT_REQUEST_STATUSES);

export const CHECKIN_STATUSES = ['green', 'amber', 'red'] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];
export const checkinStatusEnum = pgEnum('checkin_status', CHECKIN_STATUSES);

export const SAFETY_ALERT_TYPES = [
  'red_flag',
  'amber',
  'missed_checkin',
  'medication_side_effect',
  'followup_due',
] as const;
export type SafetyAlertType = (typeof SAFETY_ALERT_TYPES)[number];
export const safetyAlertTypeEnum = pgEnum('safety_alert_type', SAFETY_ALERT_TYPES);

export const CLARIFICATION_STATUSES = [
  'draft',
  'posted',
  'awaiting_response',
  'response_received',
  'clarification_asked',
  'reviewed',
  'closed',
] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];
export const clarificationStatusEnum = pgEnum('clarification_status', CLARIFICATION_STATUSES);

export const CLARIFICATION_URGENCIES = ['routine', 'soon', 'urgent'] as const;
export type ClarificationUrgency = (typeof CLARIFICATION_URGENCIES)[number];
export const clarificationUrgencyEnum = pgEnum('clarification_urgency', CLARIFICATION_URGENCIES);

export const CONTENT_ITEM_TYPES = [
  'self_help_tool',
  'education_module',
  'blog_article',
  'caregiver_guide',
  'emergency_guidance',
  'support_org',
  'clinical_reference',
] as const;
export type ContentItemType = (typeof CONTENT_ITEM_TYPES)[number];
export const contentItemTypeEnum = pgEnum('content_item_type', CONTENT_ITEM_TYPES);

export const CONTENT_REVIEW_STATUSES = ['draft', 'in_clinical_review', 'published', 'archived'] as const;
export type ContentReviewStatus = (typeof CONTENT_REVIEW_STATUSES)[number];
export const contentReviewStatusEnum = pgEnum('content_review_status', CONTENT_REVIEW_STATUSES);

export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'rejected'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const complaintStatusEnum = pgEnum('complaint_status', COMPLAINT_STATUSES);

export const COMPLAINT_CATEGORIES = [
  'consultation_quality',
  'doctor_conduct',
  'technical_issue',
  'payment_issue',
  'other',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];
export const complaintCategoryEnum = pgEnum('complaint_category', COMPLAINT_CATEGORIES);

export const LEGAL_DOCUMENT_TYPES = [
  'teleconsultation_consent',
  'privacy_policy',
  'terms_of_use',
  'refund_policy',
  'reconsult_policy',
  'doctor_agreement',
] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];
export const legalDocumentTypeEnum = pgEnum('legal_document_type', LEGAL_DOCUMENT_TYPES);

export const DELETION_STATUSES = [
  'requested',
  'in_review',
  'approved',
  'rejected',
  'executed',
  'failed',
] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];
export const deletionStatusEnum = pgEnum('deletion_status', DELETION_STATUSES);

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const notificationStatusEnum = pgEnum('notification_status', NOTIFICATION_STATUSES);

export const AUDIT_ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'export',
  'login',
  'verify',
  'webhook',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const auditActionEnum = pgEnum('audit_action', AUDIT_ACTIONS);

export const ACTOR_TYPES = ['patient', 'doctor', 'admin', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES);
