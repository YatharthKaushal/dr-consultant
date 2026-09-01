CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('pending', 'active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('patient', 'doctor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('patient', 'doctor', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'read', 'update', 'delete', 'export', 'login', 'verify', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."availability_rule_type" AS ENUM('weekly', 'blocked', 'custom_hours');--> statement-breakpoint
CREATE TYPE "public"."checkin_status" AS ENUM('green', 'amber', 'red');--> statement-breakpoint
CREATE TYPE "public"."clarification_status" AS ENUM('draft', 'posted', 'awaiting_response', 'response_received', 'clarification_asked', 'reviewed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."clarification_urgency" AS ENUM('routine', 'soon', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."complaint_category" AS ENUM('consultation_quality', 'doctor_conduct', 'technical_issue', 'payment_issue', 'other');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('open', 'in_progress', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."consultation_mode" AS ENUM('scheduled', 'instant');--> statement-breakpoint
CREATE TYPE "public"."consultation_status" AS ENUM('pending_payment', 'scheduled', 'awaiting_doctor', 'in_progress', 'awaiting_documentation', 'completed', 'cancelled', 'no_show', 'expired');--> statement-breakpoint
CREATE TYPE "public"."content_item_type" AS ENUM('self_help_tool', 'education_module', 'blog_article', 'caregiver_guide', 'emergency_guidance', 'support_org', 'clinical_reference');--> statement-breakpoint
CREATE TYPE "public"."content_review_status" AS ENUM('draft', 'in_clinical_review', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."deletion_status" AS ENUM('requested', 'in_review', 'approved', 'rejected', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."doctor_document_type" AS ENUM('degree_certificate', 'registration_certificate', 'identity_proof', 'address_proof', 'experience_letter', 'profile_photo', 'signature', 'other');--> statement-breakpoint
CREATE TYPE "public"."doctor_presence" AS ENUM('offline', 'available_now', 'request_pending', 'in_consultation', 'completing_notes', 'paused', 'scheduled_only');--> statement-breakpoint
CREATE TYPE "public"."doctor_seniority" AS ENUM('standard', 'expert');--> statement-breakpoint
CREATE TYPE "public"."doctor_verification_status" AS ENUM('pending', 'under_review', 'verified', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."document_review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('none', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other', 'undisclosed');--> statement-breakpoint
CREATE TYPE "public"."instant_consultancy_outcome" AS ENUM('pending', 'accepted', 'declined', 'timed_out', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."legal_document_type" AS ENUM('teleconsultation_consent', 'privacy_policy', 'terms_of_use', 'refund_policy', 'reconsult_policy', 'doctor_agreement');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."party" AS ENUM('patient', 'doctor', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."patient_file_category" AS ENUM('medical_history', 'report', 'photo', 'prescription_pdf', 'clarification_attachment');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."report_request_status" AS ENUM('open', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."risk_category" AS ENUM('low', 'moderate', 'high');--> statement-breakpoint
CREATE TYPE "public"."safety_alert_type" AS ENUM('red_flag', 'amber', 'missed_checkin', 'medication_side_effect', 'followup_due');--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(255) NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_permission_grants" (
	"admin_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"granted_by_admin_id" uuid,
	"reason" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_permission_grants_admin_id_permission_id_pk" PRIMARY KEY("admin_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"admin_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_by_admin_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_roles_admin_id_role_id_pk" PRIMARY KEY("admin_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"mobile_number" varchar(16) NOT NULL,
	"mobile_verified_at" timestamp with time zone,
	"full_name" varchar(160) NOT NULL,
	"token_version" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_mobile_number_unique" UNIQUE("mobile_number")
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(160) NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" "audit_action" NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" varchar(80) NOT NULL,
	"consultation_id" uuid,
	"metadata" jsonb,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkin_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"checkin_date" date NOT NULL,
	"answers" jsonb NOT NULL,
	"status" "checkin_status" NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarification_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treating_doctor_id" uuid NOT NULL,
	"source_consultation_id" uuid,
	"title" varchar(200) NOT NULL,
	"patient_age" smallint,
	"patient_gender" "gender",
	"brief_history" text NOT NULL,
	"diagnosis" text,
	"current_plan" text,
	"specific_doubt" text NOT NULL,
	"urgency" "clarification_urgency" DEFAULT 'routine' NOT NULL,
	"expert_doctor_id" uuid,
	"assigned_at" timestamp with time zone,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "clarification_status" DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"chief_complaint" text NOT NULL,
	"clinical_history" text,
	"diagnosis" text,
	"is_diagnosis_provisional" boolean DEFAULT true NOT NULL,
	"risk_category" "risk_category" NOT NULL,
	"referral_note" varchar(255),
	"medicines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"advice_covered" text,
	"advice_home_practice" text,
	"advice_next_focus" text,
	"advice_warning_signs" text,
	"case_summary" text,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_records_consultation_id_unique" UNIQUE("consultation_id")
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_code" varchar(24) NOT NULL,
	"patient_id" uuid NOT NULL,
	"consultation_id" uuid,
	"category" "complaint_category" NOT NULL,
	"subject" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"status" "complaint_status" DEFAULT 'open' NOT NULL,
	"assigned_to_admin_id" uuid,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_reference_code_unique" UNIQUE("reference_code")
);
--> statement-breakpoint
CREATE TABLE "concerns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specialty_id" uuid NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(120) NOT NULL,
	"match_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_weight" smallint DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid,
	"doctor_id" uuid,
	"legal_document_id" uuid NOT NULL,
	"document_type" "legal_document_type" NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" "inet"
);
--> statement-breakpoint
CREATE TABLE "consultation_participants" (
	"livekit_participant_sid" varchar(64) PRIMARY KEY NOT NULL,
	"consultation_id" uuid NOT NULL,
	"party" "party" NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"disconnect_reason" varchar(40),
	CONSTRAINT "consultation_participants_party_check" CHECK ("consultation_participants"."party" in ('patient', 'doctor'))
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_code" varchar(24) NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid,
	"specialty_id" uuid NOT NULL,
	"concern_id" uuid,
	"mode" "consultation_mode" NOT NULL,
	"status" "consultation_status" DEFAULT 'pending_payment' NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"duration_minutes" smallint NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"intake_answers" jsonb,
	"rescheduled_from_consultation_id" uuid,
	"followup_of_consultation_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_party" "party",
	"cancellation_reason" varchar(200),
	"followup_pathway_id" uuid,
	"followup_starts_on" date,
	"followup_status" "followup_status" DEFAULT 'none' NOT NULL,
	"extra_checkin_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feedback_rating" smallint,
	"feedback_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consultations_reference_code_unique" UNIQUE("reference_code")
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_type" "content_item_type" NOT NULL,
	"slug" varchar(160) NOT NULL,
	"title" varchar(200) NOT NULL,
	"summary" varchar(400),
	"body" jsonb NOT NULL,
	"concern_id" uuid,
	"specialty_id" uuid,
	"cover_storage_key" text,
	"is_verified_org" boolean,
	"review_status" "content_review_status" DEFAULT 'draft' NOT NULL,
	"reviewed_by_admin_id" uuid,
	"reviewed_at" timestamp with time zone,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_items_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "content_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "deletion_status" DEFAULT 'requested' NOT NULL,
	"reason" text,
	"reviewed_by_admin_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"execution_outcome" jsonb,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"rule_type" "availability_rule_type" NOT NULL,
	"day_of_week" smallint,
	"specific_date" date,
	"start_time" time,
	"end_time" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_clinical_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"specialty_id" uuid,
	"name" varchar(120) NOT NULL,
	"medicines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"advice_covered" text,
	"advice_home_practice" text,
	"advice_next_focus" text,
	"advice_warning_signs" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"document_type" "doctor_document_type" NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"review_status" "document_review_status" DEFAULT 'pending' NOT NULL,
	"verified_by_admin_id" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_documents_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "doctor_specialties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"specialty_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_specialties_doctor_id_specialty_id_unique" UNIQUE("doctor_id","specialty_id")
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile_number" varchar(16) NOT NULL,
	"mobile_verified_at" timestamp with time zone,
	"token_version" smallint DEFAULT 0 NOT NULL,
	"push_token" text,
	"device_id" varchar(120),
	"full_name" varchar(160) NOT NULL,
	"bio" text,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_status" "doctor_verification_status" DEFAULT 'pending' NOT NULL,
	"registration_number" varchar(80),
	"qualification" varchar(255),
	"years_of_experience" smallint,
	"verified_by_admin_id" uuid,
	"verified_at" timestamp with time zone,
	"seniority_level" "doctor_seniority" DEFAULT 'standard' NOT NULL,
	"consultation_fee_inr" numeric(10, 2) DEFAULT '0' NOT NULL,
	"consultation_duration_minutes" smallint DEFAULT 30 NOT NULL,
	"buffer_minutes" smallint DEFAULT 5 NOT NULL,
	"is_listed" boolean DEFAULT false NOT NULL,
	"allow_instant_consult" boolean DEFAULT false NOT NULL,
	"presence" "doctor_presence" DEFAULT 'offline' NOT NULL,
	"blocked_by_consultation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctors_mobile_number_unique" UNIQUE("mobile_number"),
	CONSTRAINT "doctors_registration_number_unique" UNIQUE("registration_number")
);
--> statement-breakpoint
CREATE TABLE "followup_pathways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(120) NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"duration_days" smallint DEFAULT 7 NOT NULL,
	"questions" jsonb NOT NULL,
	"red_flag_rules" jsonb NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instant_consultancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"attempt_number" smallint NOT NULL,
	"outcome" "instant_consultancy_outcome" DEFAULT 'pending' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_type" "legal_document_type" NOT NULL,
	"version" varchar(20) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_documents_id_document_type_key" UNIQUE("id","document_type")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"doctor_id" uuid,
	"admin_id" uuid,
	"template_code" varchar(80) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"deep_link_data" jsonb,
	"consultation_id" uuid,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failure_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile_number" varchar(16) NOT NULL,
	"audience" "account_type" NOT NULL,
	"provider_request_id" varchar(120) NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"resend_count" smallint DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"ip_address" "inet",
	"device_id" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenges_provider_request_id_unique" UNIQUE("provider_request_id")
);
--> statement-breakpoint
CREATE TABLE "patient_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_category" "patient_file_category" NOT NULL,
	"patient_id" uuid,
	"uploaded_by_doctor_id" uuid,
	"consultation_id" uuid,
	"report_request_id" uuid,
	"clarification_case_id" uuid,
	"storage_key" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "patient_files_deidentified_check" CHECK ("patient_files"."clarification_case_id" is null or "patient_files"."patient_id" is null)
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "account_status" DEFAULT 'pending' NOT NULL,
	"mobile_number" varchar(16) NOT NULL,
	"full_name" varchar(160),
	"date_of_birth" text,
	"gender" "gender" DEFAULT 'undisclosed' NOT NULL,
	"preferred_language" varchar(40) DEFAULT 'en' NOT NULL,
	"token_version" smallint DEFAULT 0 NOT NULL,
	"push_token" text,
	"device_id" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_mobile_number_unique" UNIQUE("mobile_number")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gateway_event_id" varchar(120) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"payment_id" uuid,
	"gateway_order_id" varchar(120),
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" varchar(200),
	CONSTRAINT "payment_events_gateway_event_id_unique" UNIQUE("gateway_event_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"consultation_fee" numeric(10, 2) NOT NULL,
	"convenience_fee_pct" numeric(5, 2) NOT NULL,
	"convenience_fee" numeric(10, 2) NOT NULL,
	"gst_pct" numeric(5, 2) NOT NULL,
	"gst_amount" numeric(10, 2) NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"gateway_order_id" varchar(120),
	"gateway_payment_id" varchar(120),
	"payment_method" varchar(40),
	"paid_at" timestamp with time zone,
	"failure_reason" varchar(200),
	"refund_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"refund_reason" varchar(200),
	"refund_initiated_by_admin_id" uuid,
	"gateway_refund_id" varchar(120),
	"refunded_at" timestamp with time zone,
	"payout_paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_consultation_id_unique" UNIQUE("consultation_id"),
	CONSTRAINT "payments_gateway_order_id_unique" UNIQUE("gateway_order_id"),
	CONSTRAINT "payments_gateway_payment_id_unique" UNIQUE("gateway_payment_id"),
	CONSTRAINT "payments_gateway_refund_id_unique" UNIQUE("gateway_refund_id")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(80) NOT NULL,
	"module" varchar(40) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "report_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"reason" text,
	"status" "report_request_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "safety_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_type" "safety_alert_type" NOT NULL,
	"consultation_id" uuid NOT NULL,
	"checkin_response_id" uuid,
	"reason" varchar(255),
	"acknowledged_by_admin_id" uuid,
	"acknowledged_by_doctor_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closing_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"query_text" varchar(500) NOT NULL,
	"is_voice_input" boolean DEFAULT false NOT NULL,
	"matched_concern_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_count" smallint DEFAULT 0 NOT NULL,
	"crisis_guardrail_fired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"can_prescribe" boolean DEFAULT false NOT NULL,
	"intake_form" jsonb,
	"first_consult_form" jsonb,
	"prescription_template" jsonb,
	"advice_template" jsonb,
	"required_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialties_code_unique" UNIQUE("code"),
	CONSTRAINT "specialties_prescription_template_check" CHECK ("specialties"."can_prescribe" or "specialties"."prescription_template" is null)
);
--> statement-breakpoint
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_granted_by_admin_id_admins_id_fk" FOREIGN KEY ("granted_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_granted_by_admin_id_admins_id_fk" FOREIGN KEY ("granted_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_responses" ADD CONSTRAINT "checkin_responses_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_cases" ADD CONSTRAINT "clarification_cases_treating_doctor_id_doctors_id_fk" FOREIGN KEY ("treating_doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_cases" ADD CONSTRAINT "clarification_cases_source_consultation_id_consultations_id_fk" FOREIGN KEY ("source_consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_cases" ADD CONSTRAINT "clarification_cases_expert_doctor_id_doctors_id_fk" FOREIGN KEY ("expert_doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assigned_to_admin_id_admins_id_fk" FOREIGN KEY ("assigned_to_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_document_id_legal_documents_id_fk" FOREIGN KEY ("legal_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_document_id_document_type_fk" FOREIGN KEY ("legal_document_id","document_type") REFERENCES "public"."legal_documents"("id","document_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_participants" ADD CONSTRAINT "consultation_participants_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "public"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_rescheduled_from_consultation_id_consultations_id_fk" FOREIGN KEY ("rescheduled_from_consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_followup_of_consultation_id_consultations_id_fk" FOREIGN KEY ("followup_of_consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_followup_pathway_id_followup_pathways_id_fk" FOREIGN KEY ("followup_pathway_id") REFERENCES "public"."followup_pathways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_id_payments_consultation_id_fk" FOREIGN KEY ("id") REFERENCES "public"."payments"("consultation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_id_clinical_records_consultation_id_fk" FOREIGN KEY ("id") REFERENCES "public"."clinical_records"("consultation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_doctor_specialty_fk" FOREIGN KEY ("doctor_id","specialty_id") REFERENCES "public"."doctor_specialties"("doctor_id","specialty_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "public"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_reviewed_by_admin_id_admins_id_fk" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_recommendations" ADD CONSTRAINT "content_recommendations_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_recommendations" ADD CONSTRAINT "content_recommendations_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_reviewed_by_admin_id_admins_id_fk" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_clinical_templates" ADD CONSTRAINT "doctor_clinical_templates_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_clinical_templates" ADD CONSTRAINT "doctor_clinical_templates_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_clinical_templates" ADD CONSTRAINT "doctor_clinical_templates_doctor_specialty_fk" FOREIGN KEY ("doctor_id","specialty_id") REFERENCES "public"."doctor_specialties"("doctor_id","specialty_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_documents" ADD CONSTRAINT "doctor_documents_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_documents" ADD CONSTRAINT "doctor_documents_verified_by_admin_id_admins_id_fk" FOREIGN KEY ("verified_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_specialties" ADD CONSTRAINT "doctor_specialties_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_specialties" ADD CONSTRAINT "doctor_specialties_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_verified_by_admin_id_admins_id_fk" FOREIGN KEY ("verified_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_blocked_by_consultation_id_consultations_id_fk" FOREIGN KEY ("blocked_by_consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_consultancy" ADD CONSTRAINT "instant_consultancy_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_consultancy" ADD CONSTRAINT "instant_consultancy_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_uploaded_by_doctor_id_doctors_id_fk" FOREIGN KEY ("uploaded_by_doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_report_request_id_report_requests_id_fk" FOREIGN KEY ("report_request_id") REFERENCES "public"."report_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_clarification_case_id_clarification_cases_id_fk" FOREIGN KEY ("clarification_case_id") REFERENCES "public"."clarification_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_initiated_by_admin_id_admins_id_fk" FOREIGN KEY ("refund_initiated_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_requests" ADD CONSTRAINT "report_requests_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_checkin_response_id_checkin_responses_id_fk" FOREIGN KEY ("checkin_response_id") REFERENCES "public"."checkin_responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_acknowledged_by_admin_id_admins_id_fk" FOREIGN KEY ("acknowledged_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_acknowledged_by_doctor_id_doctors_id_fk" FOREIGN KEY ("acknowledged_by_doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outbox_status_scheduled" ON "outbox_events" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "idx_outbox_event_type" ON "outbox_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_outbox_created_at" ON "outbox_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_permission_grants_permission_id_index" ON "admin_permission_grants" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "admin_roles_role_id_index" ON "admin_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "admins_status_index" ON "admins" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_actor_type_actor_id_created_at_index" ON "audit_log" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_index" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_created_at_index" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_consultation_id_index" ON "audit_log" USING btree ("consultation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkin_responses_consultation_id_checkin_date_index" ON "checkin_responses" USING btree ("consultation_id","checkin_date");--> statement-breakpoint
CREATE INDEX "checkin_responses_status_submitted_at_index" ON "checkin_responses" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "clarification_cases_treating_doctor_id_status_index" ON "clarification_cases" USING btree ("treating_doctor_id","status");--> statement-breakpoint
CREATE INDEX "clarification_cases_expert_doctor_id_status_index" ON "clarification_cases" USING btree ("expert_doctor_id","status");--> statement-breakpoint
CREATE INDEX "clarification_cases_status_urgency_index" ON "clarification_cases" USING btree ("status","urgency");--> statement-breakpoint
CREATE INDEX "clinical_records_finalised_at_index" ON "clinical_records" USING btree ("finalised_at");--> statement-breakpoint
CREATE INDEX "complaints_status_created_at_index" ON "complaints" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "complaints_patient_id_index" ON "complaints" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concerns_specialty_id_code_index" ON "concerns" USING btree ("specialty_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_patient_id_legal_document_id_index" ON "consents" USING btree ("patient_id","legal_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_doctor_id_legal_document_id_index" ON "consents" USING btree ("doctor_id","legal_document_id");--> statement-breakpoint
CREATE INDEX "consents_patient_id_document_type_index" ON "consents" USING btree ("patient_id","document_type");--> statement-breakpoint
CREATE INDEX "consultation_participants_consultation_id_party_joined_at_index" ON "consultation_participants" USING btree ("consultation_id","party","joined_at");--> statement-breakpoint
CREATE INDEX "consultations_patient_id_status_index" ON "consultations" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "consultations_doctor_id_status_index" ON "consultations" USING btree ("doctor_id","status");--> statement-breakpoint
CREATE INDEX "consultations_doctor_id_scheduled_start_at_index" ON "consultations" USING btree ("doctor_id","scheduled_start_at");--> statement-breakpoint
CREATE INDEX "consultations_status_scheduled_start_at_index" ON "consultations" USING btree ("status","scheduled_start_at");--> statement-breakpoint
CREATE INDEX "consultations_followup_status_followup_starts_on_index" ON "consultations" USING btree ("followup_status","followup_starts_on");--> statement-breakpoint
CREATE INDEX "consultations_hold_expires_at_index" ON "consultations" USING btree ("hold_expires_at");--> statement-breakpoint
CREATE INDEX "consultations_followup_of_consultation_id_index" ON "consultations" USING btree ("followup_of_consultation_id");--> statement-breakpoint
CREATE INDEX "content_items_item_type_review_status_index" ON "content_items" USING btree ("item_type","review_status");--> statement-breakpoint
CREATE INDEX "content_items_concern_id_item_type_index" ON "content_items" USING btree ("concern_id","item_type");--> statement-breakpoint
CREATE UNIQUE INDEX "content_recommendations_consultation_id_content_item_id_index" ON "content_recommendations" USING btree ("consultation_id","content_item_id");--> statement-breakpoint
CREATE INDEX "content_recommendations_content_item_id_index" ON "content_recommendations" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "data_deletion_requests_status_created_at_index" ON "data_deletion_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "data_deletion_requests_patient_id_index" ON "data_deletion_requests" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "doctor_availability_doctor_id_rule_type_index" ON "doctor_availability" USING btree ("doctor_id","rule_type");--> statement-breakpoint
CREATE INDEX "doctor_availability_doctor_id_specific_date_index" ON "doctor_availability" USING btree ("doctor_id","specific_date");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_clinical_templates_doctor_id_name_index" ON "doctor_clinical_templates" USING btree ("doctor_id","name");--> statement-breakpoint
CREATE INDEX "doctor_documents_doctor_id_document_type_index" ON "doctor_documents" USING btree ("doctor_id","document_type");--> statement-breakpoint
CREATE INDEX "doctor_documents_review_status_created_at_index" ON "doctor_documents" USING btree ("review_status","created_at");--> statement-breakpoint
CREATE INDEX "doctor_specialties_specialty_id_index" ON "doctor_specialties" USING btree ("specialty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_specialties_one_primary_idx" ON "doctor_specialties" USING btree ("doctor_id") WHERE "doctor_specialties"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "doctors_verification_status_is_listed_index" ON "doctors" USING btree ("verification_status","is_listed");--> statement-breakpoint
CREATE INDEX "doctors_presence_allow_instant_consult_index" ON "doctors" USING btree ("presence","allow_instant_consult");--> statement-breakpoint
CREATE INDEX "doctors_seniority_level_index" ON "doctors" USING btree ("seniority_level");--> statement-breakpoint
CREATE INDEX "doctors_push_token_index" ON "doctors" USING btree ("push_token");--> statement-breakpoint
CREATE UNIQUE INDEX "followup_pathways_code_version_index" ON "followup_pathways" USING btree ("code","version");--> statement-breakpoint
CREATE INDEX "followup_pathways_code_is_current_index" ON "followup_pathways" USING btree ("code","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "instant_consultancy_consultation_id_attempt_number_index" ON "instant_consultancy" USING btree ("consultation_id","attempt_number");--> statement-breakpoint
CREATE INDEX "instant_consultancy_doctor_id_outcome_index" ON "instant_consultancy" USING btree ("doctor_id","outcome");--> statement-breakpoint
CREATE INDEX "instant_consultancy_expires_at_index" ON "instant_consultancy" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_document_type_version_index" ON "legal_documents" USING btree ("document_type","version");--> statement-breakpoint
CREATE INDEX "legal_documents_document_type_is_current_index" ON "legal_documents" USING btree ("document_type","is_current");--> statement-breakpoint
CREATE INDEX "notifications_patient_id_created_at_index" ON "notifications" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_doctor_id_created_at_index" ON "notifications" USING btree ("doctor_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_admin_id_created_at_index" ON "notifications" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_created_at_index" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_mobile_number_created_at_index" ON "otp_challenges" USING btree ("mobile_number","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_ip_address_created_at_index" ON "otp_challenges" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_created_at_index" ON "otp_challenges" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "patient_files_patient_id_file_category_index" ON "patient_files" USING btree ("patient_id","file_category");--> statement-breakpoint
CREATE INDEX "patient_files_consultation_id_index" ON "patient_files" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "patient_files_report_request_id_index" ON "patient_files" USING btree ("report_request_id");--> statement-breakpoint
CREATE INDEX "patient_files_clarification_case_id_index" ON "patient_files" USING btree ("clarification_case_id");--> statement-breakpoint
CREATE INDEX "patients_status_index" ON "patients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "patients_push_token_index" ON "patients" USING btree ("push_token");--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_index" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_events_event_type_received_at_index" ON "payment_events" USING btree ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "payment_events_processed_at_index" ON "payment_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "payments_status_created_at_index" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_paid_at_index" ON "payments" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "permissions_module_key_index" ON "permissions" USING btree ("module","key");--> statement-breakpoint
CREATE INDEX "report_requests_consultation_id_status_index" ON "report_requests" USING btree ("consultation_id","status");--> statement-breakpoint
CREATE INDEX "report_requests_status_created_at_index" ON "report_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_id_index" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "safety_alerts_alert_type_created_at_index" ON "safety_alerts" USING btree ("alert_type","created_at");--> statement-breakpoint
CREATE INDEX "safety_alerts_consultation_id_index" ON "safety_alerts" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "search_queries_patient_id_created_at_index" ON "search_queries" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "search_queries_created_at_index" ON "search_queries" USING btree ("created_at");