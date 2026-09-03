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

/**
 * `partially_refunded` was added with the `refunds` table (M-12): once one
 * payment can carry MANY refunds, "some but not all of it came back" became a
 * representable state that `refunded` alone could not express.
 *
 * Ordering note: new values are appended, never inserted mid-list. Postgres
 * enum values have an ordinal, and `ALTER TYPE ... ADD VALUE BEFORE` would
 * renumber — appending keeps every existing row's stored ordinal stable.
 */
export const PAYMENT_STATUSES = [
  'created',
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

/**
 * One refund's own lifecycle, distinct from the PAYMENT's status.
 *
 * `pending` = recorded by us, not yet sent to the gateway (an auto-refund
 * awaiting its worker, or an admin-queued one awaiting approval).
 * `processing` = the gateway accepted it and is settling.
 * `processed` = the gateway confirmed it by webhook — the only state that
 * means money actually moved.
 * `failed` = the gateway rejected or reversed it; `failure_reason` says why.
 */
export const REFUND_STATUSES = ['pending', 'processing', 'processed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const refundStatusEnum = pgEnum('refund_status', REFUND_STATUSES);

export const RISK_CATEGORIES = ['low', 'moderate', 'high'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export const riskCategoryEnum = pgEnum('risk_category', RISK_CATEGORIES);

/**
 * Where a symptom search entered the system (M-09). `app` is the patient app
 * or admin panel acting for a signed-in patient; `mcp` and `whatsapp` are
 * discovery surfaces with NO authenticated patient, which is why
 * `search_queries.patient_id` is nullable. Kept as its own enum rather than
 * reusing `party`/`actor_type`: those name WHO acted, this names WHICH
 * SURFACE the query arrived through, and the two value sets do not overlap.
 */
export const SEARCH_SOURCES = ['app', 'mcp', 'whatsapp'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];
export const searchSourceEnum = pgEnum('search_source', SEARCH_SOURCES);

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

/* -------------------------------------------------------------------------- */
/* PRICING (M-12.5). The bill stops being three columns and becomes a priced   */
/* list of components, each with its own tax treatment.                        */
/* -------------------------------------------------------------------------- */

/**
 * A quote's lifecycle. `draft` is priced but not committed to; `pinned` means a
 * payment has been created against it and the amount is now frozen (Razorpay
 * fixes an order's amount at creation, so it CANNOT change afterwards);
 * `consumed` means the payment was captured against it.
 *
 * `expired` and `superseded` are both terminal and deliberately distinct:
 * `expired` is "nobody paid in time", `superseded` is "re-priced, use the newer
 * one". Collapsing them would lose the difference between an abandoned
 * checkout and a repriced one, which is exactly what a finance query asks.
 */
export const PRICE_QUOTE_STATUSES = ['draft', 'pinned', 'consumed', 'expired', 'superseded'] as const;
export type PriceQuoteStatus = (typeof PRICE_QUOTE_STATUSES)[number];
export const priceQuoteStatusEnum = pgEnum('price_quote_status', PRICE_QUOTE_STATUSES);

/**
 * Whether a component is taxed at all.
 *
 * *** THIS IS THE ENUM THAT LETS FR-7.3 BE RECONSIDERED WITHOUT A MIGRATION. ***
 * Under Notification 12/2017 entry 74 a doctor's consultation fee is normally
 * GST-EXEMPT and only the platform's convenience fee is taxable. FR-7.3 as
 * written taxes both. Making the treatment per-component and stored means the
 * client's CA can rule either way and the change is configuration, not code.
 */
export const TAX_TREATMENTS = ['exempt', 'taxable'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
export const taxTreatmentEnum = pgEnum('tax_treatment', TAX_TREATMENTS);

/**
 * Whether a component's quoted amount ALREADY contains its tax.
 *
 * Per component rather than one global switch: a global flag is undefined for
 * an exempt component, and it would break FR-7.4 if applied to the doctor's fee
 * (an inclusive fee would shrink the doctor's payout by the tax, while FR-7.4
 * commits to them receiving it in full). The convenience fee is a platform
 * charge the client may legitimately want advertised all-in.
 */
export const TAX_MODES = ['exclusive', 'inclusive'] as const;
export type TaxMode = (typeof TAX_MODES)[number];
export const taxModeEnum = pgEnum('tax_mode', TAX_MODES);

/**
 * Intra-state supply splits into CGST + SGST; inter-state is a single IGST.
 * Decided by the recipient's state against the supplier's registered state.
 *
 * Recorded on the quote because CBIC Circular 242/36/2024 requires the
 * recipient's state on the invoice for online services to unregistered
 * recipients, irrespective of value — so this is a compliance field, not a
 * derived convenience.
 */
export const PLACE_OF_SUPPLY_KINDS = ['intra_state', 'inter_state'] as const;
export type PlaceOfSupplyKind = (typeof PLACE_OF_SUPPLY_KINDS)[number];
export const placeOfSupplyKindEnum = pgEnum('place_of_supply_kind', PLACE_OF_SUPPLY_KINDS);

/* -------------------------------------------------------------------------- */
/* PROMOTIONS. Coupons, vouchers, refer-and-earn and doctor affiliates.        */
/* Entirely net-new: nothing discount-shaped existed anywhere before this.     */
/* -------------------------------------------------------------------------- */

/**
 * What an instrument IS. All five share one table and one `code` namespace,
 * because the product requirement is a SINGLE input box that resolves any code
 * — and a single `UNIQUE(code)` is the only way to make "no collisions across
 * kinds" a database guarantee rather than a service convention.
 *
 * The kinds differ only in which ownership column is set, enforced by a CHECK:
 * a voucher is a coupon with an assigned patient, a referral code is one owned
 * by a patient, an affiliate code is one with a partner attached. This is a
 * discriminated union, not five different code paths.
 */
export const DISCOUNT_INSTRUMENT_KINDS = [
  'coupon',
  'voucher',
  'referral',
  'referral_reward',
  'affiliate',
] as const;
export type DiscountInstrumentKind = (typeof DISCOUNT_INSTRUMENT_KINDS)[number];
export const discountInstrumentKindEnum = pgEnum(
  'discount_instrument_kind',
  DISCOUNT_INSTRUMENT_KINDS,
);

/** Flat rupee amount off, or a percentage of the discountable base. Also names an affiliate's commission shape. */
export const DISCOUNT_VALUE_KINDS = ['flat', 'percent'] as const;
export type DiscountValueKind = (typeof DISCOUNT_VALUE_KINDS)[number];
export const discountValueKindEnum = pgEnum('discount_value_kind', DISCOUNT_VALUE_KINDS);

/**
 * `draft` is editable and unusable; `active` is live; `paused` is a reversible
 * stop; `archived` is terminal. Deliberately NOT a boolean: "turn it off for an
 * hour" and "retire it" are different intentions and an admin should not have
 * to encode one as the other.
 */
export const DISCOUNT_INSTRUMENT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type DiscountInstrumentStatus = (typeof DISCOUNT_INSTRUMENT_STATUSES)[number];
export const discountInstrumentStatusEnum = pgEnum(
  'discount_instrument_status',
  DISCOUNT_INSTRUMENT_STATUSES,
);

/**
 * A redemption's lifecycle, and the reason a usage-capped coupon cannot be
 * over-spent by concurrent checkouts.
 *
 * `reserved` is taken at quote-pin time and COUNTS against every cap;
 * `consumed` is burned once the payment is captured; `released` is returned to
 * the pool when a checkout is abandoned or fails. This is the slot-hold design
 * applied to coupons — the reservation IS the lock.
 */
export const DISCOUNT_REDEMPTION_STATUSES = ['reserved', 'consumed', 'released'] as const;
export type DiscountRedemptionStatus = (typeof DISCOUNT_REDEMPTION_STATUSES)[number];
export const discountRedemptionStatusEnum = pgEnum(
  'discount_redemption_status',
  DISCOUNT_REDEMPTION_STATUSES,
);

/** Which side of a referral a minted reward belongs to. Admin configures the two amounts independently. */
export const REFERRAL_REWARD_ROLES = ['referrer', 'referee'] as const;
export type ReferralRewardRole = (typeof REFERRAL_REWARD_ROLES)[number];
export const referralRewardRoleEnum = pgEnum('referral_reward_role', REFERRAL_REWARD_ROLES);

/**
 * `qualifying` = the referee booked and paid, but the reward is NOT yet earned.
 * `qualified` = the consultation reached a qualifying status, so the referrer's
 * reward may be minted. `void` = it will never qualify.
 *
 * *** THE GAP BETWEEN `qualifying` AND `qualified` IS THE ANTI-FARMING DESIGN. ***
 * Minting at payment capture is trivially farmable: refer a burner account,
 * book, pay, take the referee discount, then cancel inside the free-cancellation
 * window that already auto-refunds — and the referrer keeps a reward the
 * platform funded out of nothing.
 */
export const REFERRAL_EVENT_STATUSES = ['qualifying', 'qualified', 'void'] as const;
export type ReferralEventStatus = (typeof REFERRAL_EVENT_STATUSES)[number];
export const referralEventStatusEnum = pgEnum('referral_event_status', REFERRAL_EVENT_STATUSES);

/**
 * A doctor's affiliate arrangement.
 *
 * *** SHIPS `paused` BY DEFAULT, AND THE WHOLE FEATURE IS GATED OFF. *** India's
 * NMC Registered Medical Practitioner (Professional Conduct) Regulations, 2023
 * prohibit a registered practitioner from receiving any commission in return for
 * referring or procuring a patient, with suspension as the stated penalty. The
 * mechanism is built; enabling it is the client's legal advisor's call, not a
 * developer's. See `promotion.affiliate_enabled`.
 */
export const AFFILIATE_PARTNER_STATUSES = ['active', 'paused', 'terminated'] as const;
export type AffiliatePartnerStatus = (typeof AFFILIATE_PARTNER_STATUSES)[number];
export const affiliatePartnerStatusEnum = pgEnum(
  'affiliate_partner_status',
  AFFILIATE_PARTNER_STATUSES,
);

/**
 * What a commission is a percentage OF.
 *
 * `net_platform_margin` (the default) is the convenience fee minus any discount
 * the platform absorbed, EXCLUDING tax. It is the only base that structurally
 * cannot pay out more than the booking earned, and the only one that leaves
 * FR-7.4 literally true — the doctor's consultation fee is never read into it,
 * so it is a platform expense rather than a deduction from the doctor.
 *
 * The other two exist for deals struck differently and both REQUIRE a ceiling
 * (see the CHECK on `affiliate_partners`), because either can exceed margin.
 * GST is never a base: paying commission out of collected tax is not ours to do.
 */
export const AFFILIATE_COMMISSION_BASES = [
  'net_platform_margin',
  'convenience_fee',
  'consultation_fee',
] as const;
export type AffiliateCommissionBase = (typeof AFFILIATE_COMMISSION_BASES)[number];
export const affiliateCommissionBaseEnum = pgEnum(
  'affiliate_commission_base',
  AFFILIATE_COMMISSION_BASES,
);

/**
 * `pending` = the payment was captured but the consultation has not yet reached
 * a qualifying status, so nothing is owed. `accrued` = owed. `settled` = an
 * admin recorded that it was paid. `void` = it will never be owed. `reversed` =
 * an admin clawed back an accrual.
 *
 * `pending` is what removes the need for a clawback on the common path: a
 * booking cancelled and refunded before completion never becomes payable in the
 * first place.
 */
export const AFFILIATE_COMMISSION_STATUSES = [
  'pending',
  'accrued',
  'settled',
  'void',
  'reversed',
] as const;
export type AffiliateCommissionStatus = (typeof AFFILIATE_COMMISSION_STATUSES)[number];
export const affiliateCommissionStatusEnum = pgEnum(
  'affiliate_commission_status',
  AFFILIATE_COMMISSION_STATUSES,
);

/**
 * How a settlement was paid. `off_system` is a first-class value, not a note:
 * automated payouts are out of scope for this release (SRS 11) and the client
 * pays by bank transfer outside the platform, so the record must be able to say
 * so unambiguously rather than implying the system moved money.
 */
export const AFFILIATE_SETTLEMENT_METHODS = ['in_system', 'off_system'] as const;
export type AffiliateSettlementMethod = (typeof AFFILIATE_SETTLEMENT_METHODS)[number];
export const affiliateSettlementMethodEnum = pgEnum(
  'affiliate_settlement_method',
  AFFILIATE_SETTLEMENT_METHODS,
);
