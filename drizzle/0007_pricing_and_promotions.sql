-- PRICING AND PROMOTIONS FOUNDATION. Two subsystems, landed in one migration
-- because they are being built in PARALLEL WORKTREES and a same-numbered
-- migration is a collision this project has already hit once. M-13 (instant
-- consult) and M-08 (notifications) are in the same round and need NO schema:
-- `instant_consultancy`, the seven-state `doctor_presence` enum,
-- `doctors.blocked_by_consultation_id` and `consultations.status =
-- 'awaiting_doctor'` all already exist and are simply unused, and M-08's
-- templates live in `app_config` with delivery in `notifications`.
--
-- 1. THE BILL BECOMES A LIST, NOT THREE COLUMNS. `price_quotes` +
--    `price_quote_components` replace "fee, convenience fee, one GST rate on
--    their sum" with an ordered list of components, each carrying its OWN tax
--    treatment (`exempt` or `taxable` at a rate) and its own inclusive/exclusive
--    mode.
--
--    This is what makes the GST question answerable in configuration instead of
--    code. Under Notification 12/2017 entry 74 a doctor's consultation fee is
--    normally GST-EXEMPT while a platform's own service fee is taxable; FR-7.3
--    as written taxes both and arrives at 708. Seeded here as fee-exempt
--    (giving 618), the engine still reproduces FR-7.3's five numbers EXACTLY
--    when both components are configured taxable at 18%. The client's CA owns
--    which is right (docs/SRS.md 2.5 and 8); the schema owns being able to
--    express either.
--
--    `place_of_supply_state_code` is NOT NULL deliberately. CBIC Circular
--    242/36/2024 requires the recipient's STATE on the invoice for online
--    services to unregistered recipients, irrespective of value. A nullable
--    column is one a bug can ship empty, and the resulting invoice is invalid.
--    Razorpay cannot supply it -- Standard Checkout collects no address and the
--    payment entity carries no state -- so it is collected by us, before the
--    order exists, which it must be anyway since the tax decides the amount and
--    Razorpay fixes an order's amount at creation.
--
-- 2. A QUOTE CARRIES THE AUTHORITATIVE TOTAL. `payments` deliberately has no
--    total column, on the argument that a stored copy could disagree with its
--    components. That argument holds only while those three columns ARE the
--    bill. Once a bill can carry a discount, a third component or an inclusive
--    component they are a LOSSY SUMMARY, and re-summing them computes a
--    different number rather than recomputing the total. `price_quotes` is
--    immutable by construction -- nothing updates its money after write -- so
--    it can hold the total without reintroducing the drift that comment feared.
--    `payments.price_quote_id` is nullable, and THAT NULLABILITY IS THE LEGACY
--    BRANCH: rows without a quote stay priced by `calculateBill`.
--
-- 3. REFUNDS LEARN WHAT WAS TAX. `refunds` gains the three GST heads and a
--    credit-note serial; `refund_components` records the per-component
--    apportionment. Under s.34 CGST a refund needs a credit note with
--    proportional tax reversal, and "we gave 618.00 back" cannot support one.
--    `pricing_document_sequences` issues the serials -- a table rather than a
--    Postgres SEQUENCE because `nextval` does not roll back, and a gap in a
--    statutory series is its own compliance question.
--
-- 4. DISCOUNTING, ENTIRELY NET-NEW. `discount_instruments` holds coupons,
--    vouchers, referral codes and affiliate codes in ONE table and ONE `code`
--    namespace, because the requirement is a single input box that resolves any
--    code -- and only a single UNIQUE(code) makes "no collisions across kinds" a
--    database guarantee rather than a service convention. The kinds differ only
--    in which ownership column is set, enforced by a CHECK.
--
--    `discount_redemptions` is the reservation ledger, and its partial unique
--    indexes are the concurrency design: one live discount per consultation (no
--    stacking, race-proof) and one use per patient where the cap is 1. There is
--    deliberately NO `redeemed_count` column -- counted caps are read under the
--    instrument's row lock, the same call `RefundService` makes for the refund
--    ceiling, because a denormalised counter drifts silently.
--
-- 5. AFFILIATES SHIP SWITCHED OFF. `affiliate_partners` defaults to `paused`
--    and the feature is gated behind `promotion.affiliate_enabled = false`.
--    India's NMC Registered Medical Practitioner (Professional Conduct)
--    Regulations, 2023 prohibit a registered practitioner from receiving a
--    commission in return for referring or procuring a patient, with suspension
--    as the stated penalty -- and the exposure lands on the DOCTOR. The
--    mechanism is built; enabling it is the client's legal advisor's decision,
--    the same deferral docs/SRS.md 8 makes for GST.
--
-- Safe on existing data: every table here is NEW, so nothing can violate its
-- constraints. Every added column is either nullable (`payments.price_quote_id`,
-- `invoice_number`, `invoice_issued_at`, `refunds.credit_note_*`) or NOT NULL
-- with a DEFAULT (`refunds.taxable_value` and the three GST heads, all '0.00'),
-- so existing `payments` and `refunds` rows remain valid and keep their current
-- meaning: a refund written before this migration genuinely had no reported tax
-- reversal, and zero is the honest record of that. The balancing CHECK is on
-- `refund_components`, which has no legacy rows, precisely so those rows are not
-- forced to assert a reversal that never happened. No constraint is dropped, no
-- column is removed, and no value is rewritten.

CREATE TYPE "public"."affiliate_commission_base" AS ENUM('net_platform_margin', 'convenience_fee', 'consultation_fee');--> statement-breakpoint
CREATE TYPE "public"."affiliate_commission_status" AS ENUM('pending', 'accrued', 'settled', 'void', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."affiliate_partner_status" AS ENUM('active', 'paused', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."affiliate_settlement_method" AS ENUM('in_system', 'off_system');--> statement-breakpoint
CREATE TYPE "public"."discount_instrument_kind" AS ENUM('coupon', 'voucher', 'referral', 'referral_reward', 'affiliate');--> statement-breakpoint
CREATE TYPE "public"."discount_instrument_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."discount_redemption_status" AS ENUM('reserved', 'consumed', 'released');--> statement-breakpoint
CREATE TYPE "public"."discount_value_kind" AS ENUM('flat', 'percent');--> statement-breakpoint
CREATE TYPE "public"."place_of_supply_kind" AS ENUM('intra_state', 'inter_state');--> statement-breakpoint
CREATE TYPE "public"."price_quote_status" AS ENUM('draft', 'pinned', 'consumed', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."referral_event_status" AS ENUM('qualifying', 'qualified', 'void');--> statement-breakpoint
CREATE TYPE "public"."referral_reward_role" AS ENUM('referrer', 'referee');--> statement-breakpoint
CREATE TYPE "public"."tax_mode" AS ENUM('exclusive', 'inclusive');--> statement-breakpoint
CREATE TYPE "public"."tax_treatment" AS ENUM('exempt', 'taxable');--> statement-breakpoint
CREATE TABLE "affiliate_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"source" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"consultation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"redemption_id" uuid,
	"status" "affiliate_commission_status" DEFAULT 'pending' NOT NULL,
	"attribution_source" varchar(20) NOT NULL,
	"commission_value_kind" "discount_value_kind" NOT NULL,
	"commission_rate" numeric(5, 2),
	"commission_flat" numeric(10, 2),
	"commission_base" "affiliate_commission_base" NOT NULL,
	"commission_max" numeric(10, 2),
	"base_amount" numeric(10, 2) NOT NULL,
	"commission_amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"accrued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(120),
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_commissions_amount_check" CHECK ("affiliate_commissions"."commission_amount" >= 0 AND "affiliate_commissions"."base_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "affiliate_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"status" "affiliate_partner_status" DEFAULT 'paused' NOT NULL,
	"link_slug" varchar(40),
	"commission_value_kind" "discount_value_kind" NOT NULL,
	"commission_rate" numeric(5, 2),
	"commission_flat" numeric(10, 2),
	"commission_base" "affiliate_commission_base" DEFAULT 'net_platform_margin' NOT NULL,
	"commission_max" numeric(10, 2),
	"agreement_reference" varchar(120),
	"note" varchar(400),
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_partners_doctor_id_unique" UNIQUE("doctor_id"),
	CONSTRAINT "affiliate_partners_link_slug_unique" UNIQUE("link_slug"),
	CONSTRAINT "affiliate_partners_commission_check" CHECK (("affiliate_partners"."commission_value_kind" = 'flat' AND "affiliate_partners"."commission_flat" IS NOT NULL AND "affiliate_partners"."commission_flat" >= 0 AND "affiliate_partners"."commission_rate" IS NULL)
       OR ("affiliate_partners"."commission_value_kind" = 'percent' AND "affiliate_partners"."commission_rate" IS NOT NULL AND "affiliate_partners"."commission_rate" > 0 AND "affiliate_partners"."commission_rate" <= 100 AND "affiliate_partners"."commission_flat" IS NULL)),
	CONSTRAINT "affiliate_partners_nondefault_base_needs_cap" CHECK ("affiliate_partners"."commission_base" = 'net_platform_margin' OR "affiliate_partners"."commission_max" IS NOT NULL),
	CONSTRAINT "affiliate_partners_link_slug_shape" CHECK ("affiliate_partners"."link_slug" IS NULL OR "affiliate_partners"."link_slug" ~ '^[a-z0-9-]{6,40}$')
);
--> statement-breakpoint
CREATE TABLE "affiliate_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"method" "affiliate_settlement_method" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"commission_count" integer NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"reference" varchar(120),
	"note" varchar(400),
	"settled_by_admin_id" uuid NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'recorded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_settlements_amount_check" CHECK ("affiliate_settlements"."amount" >= 0 AND "affiliate_settlements"."commission_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "discount_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"kind" "discount_instrument_kind" NOT NULL,
	"status" "discount_instrument_status" DEFAULT 'draft' NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"is_publicly_listed" boolean DEFAULT false NOT NULL,
	"value_kind" "discount_value_kind" NOT NULL,
	"flat_amount" numeric(10, 2),
	"percent_rate" numeric(5, 2),
	"max_discount_amount" numeric(10, 2),
	"min_order_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"max_total_redemptions" integer,
	"max_distinct_redeemers" integer,
	"max_redemptions_per_user" integer DEFAULT 1 NOT NULL,
	"assigned_patient_id" uuid,
	"referrer_patient_id" uuid,
	"affiliate_partner_id" uuid,
	"referral_event_id" uuid,
	"referral_reward_role" "referral_reward_role",
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_instruments_code_unique" UNIQUE("code"),
	CONSTRAINT "discount_instruments_code_shape_check" CHECK ("discount_instruments"."code" ~ '^[A-Z0-9]{4,32}$'),
	CONSTRAINT "discount_instruments_value_check" CHECK (("discount_instruments"."value_kind" = 'flat' AND "discount_instruments"."flat_amount" IS NOT NULL AND "discount_instruments"."flat_amount" >= 0 AND "discount_instruments"."percent_rate" IS NULL AND "discount_instruments"."max_discount_amount" IS NULL)
       OR ("discount_instruments"."value_kind" = 'percent' AND "discount_instruments"."percent_rate" IS NOT NULL AND "discount_instruments"."percent_rate" > 0 AND "discount_instruments"."percent_rate" <= 100 AND "discount_instruments"."max_discount_amount" IS NOT NULL AND "discount_instruments"."max_discount_amount" > 0 AND "discount_instruments"."flat_amount" IS NULL)),
	CONSTRAINT "discount_instruments_caps_check" CHECK (("discount_instruments"."max_total_redemptions" IS NULL OR "discount_instruments"."max_total_redemptions" > 0)
      AND ("discount_instruments"."max_distinct_redeemers" IS NULL OR "discount_instruments"."max_distinct_redeemers" > 0)
      AND "discount_instruments"."max_redemptions_per_user" > 0
      AND ("discount_instruments"."max_distinct_redeemers" IS NULL OR "discount_instruments"."max_total_redemptions" IS NULL OR "discount_instruments"."max_distinct_redeemers" <= "discount_instruments"."max_total_redemptions")),
	CONSTRAINT "discount_instruments_validity_check" CHECK ("discount_instruments"."valid_to" IS NULL OR "discount_instruments"."valid_to" > "discount_instruments"."valid_from"),
	CONSTRAINT "discount_instruments_kind_shape_check" CHECK (CASE "discount_instruments"."kind"
        WHEN 'coupon' THEN "discount_instruments"."assigned_patient_id" IS NULL AND "discount_instruments"."referrer_patient_id" IS NULL AND "discount_instruments"."referral_event_id" IS NULL AND "discount_instruments"."affiliate_partner_id" IS NULL
        WHEN 'voucher' THEN "discount_instruments"."assigned_patient_id" IS NOT NULL AND "discount_instruments"."referrer_patient_id" IS NULL AND "discount_instruments"."referral_event_id" IS NULL
        WHEN 'referral' THEN "discount_instruments"."referrer_patient_id" IS NOT NULL AND "discount_instruments"."assigned_patient_id" IS NULL AND "discount_instruments"."referral_event_id" IS NULL AND "discount_instruments"."affiliate_partner_id" IS NULL
        WHEN 'referral_reward' THEN "discount_instruments"."assigned_patient_id" IS NOT NULL AND "discount_instruments"."referral_event_id" IS NOT NULL AND "discount_instruments"."referral_reward_role" IS NOT NULL AND "discount_instruments"."affiliate_partner_id" IS NULL
        WHEN 'affiliate' THEN "discount_instruments"."affiliate_partner_id" IS NOT NULL AND "discount_instruments"."assigned_patient_id" IS NULL AND "discount_instruments"."referrer_patient_id" IS NULL AND "discount_instruments"."referral_event_id" IS NULL
      END)
);
--> statement-breakpoint
CREATE TABLE "discount_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"consultation_id" uuid NOT NULL,
	"payment_id" uuid,
	"status" "discount_redemption_status" DEFAULT 'reserved' NOT NULL,
	"value_kind" "discount_value_kind" NOT NULL,
	"flat_amount" numeric(10, 2),
	"percent_rate" numeric(5, 2),
	"max_discount_amount" numeric(10, 2),
	"discountable_base" numeric(10, 2) NOT NULL,
	"discount_amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"captured_consultation_fee" numeric(10, 2),
	"captured_convenience_fee" numeric(10, 2),
	"affiliate_partner_id" uuid,
	"attribution_source" varchar(20),
	"enforces_single_use_per_user" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemptions_amount_check" CHECK ("discount_redemptions"."discount_amount" >= 0 AND "discount_redemptions"."discount_amount" <= "discount_redemptions"."discountable_base")
);
--> statement-breakpoint
CREATE TABLE "price_quote_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_quote_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"code" varchar(40) NOT NULL,
	"label" varchar(80) NOT NULL,
	"hsn_sac" varchar(10),
	"gross_amount" numeric(10, 2) NOT NULL,
	"discount_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"taxable_value" numeric(10, 2) NOT NULL,
	"tax_treatment" "tax_treatment" NOT NULL,
	"tax_mode" "tax_mode" NOT NULL,
	"tax_rate_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"cgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"sgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"igst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"line_total" numeric(10, 2) NOT NULL,
	"discount_bearer" varchar(10),
	"basis" varchar(20) NOT NULL,
	"basis_pct" numeric(5, 2),
	"basis_codes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_quote_components_line_balances" CHECK ("price_quote_components"."line_total" = "price_quote_components"."taxable_value" + "price_quote_components"."cgst_amount" + "price_quote_components"."sgst_amount" + "price_quote_components"."igst_amount"),
	CONSTRAINT "price_quote_components_exempt_has_no_tax" CHECK ("price_quote_components"."tax_treatment" <> 'exempt' OR ("price_quote_components"."cgst_amount" = 0 AND "price_quote_components"."sgst_amount" = 0 AND "price_quote_components"."igst_amount" = 0 AND "price_quote_components"."tax_rate_pct" = 0)),
	CONSTRAINT "price_quote_components_discount_within_gross" CHECK ("price_quote_components"."discount_amount" <= "price_quote_components"."gross_amount"),
	CONSTRAINT "price_quote_components_exempt_is_not_inclusive" CHECK ("price_quote_components"."tax_treatment" <> 'exempt' OR "price_quote_components"."tax_mode" = 'exclusive')
);
--> statement-breakpoint
CREATE TABLE "price_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "price_quote_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"patient_id" uuid,
	"doctor_id" uuid,
	"specialty_id" uuid,
	"consultation_id" uuid,
	"place_of_supply_state_code" char(2) NOT NULL,
	"place_of_supply_pincode" varchar(6),
	"place_of_supply_kind" "place_of_supply_kind" NOT NULL,
	"supplier_state_code" char(2) NOT NULL,
	"supplier_gstin" varchar(15),
	"gross_total" numeric(10, 2) NOT NULL,
	"discount_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"taxable_total" numeric(10, 2) NOT NULL,
	"cgst_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"sgst_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"igst_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_payable" numeric(10, 2) NOT NULL,
	"discount_id" uuid,
	"discount_code" varchar(60),
	"discount_label" varchar(80),
	"expires_at" timestamp with time zone NOT NULL,
	"pinned_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_quotes_total_balances" CHECK ("price_quotes"."total_payable" = "price_quotes"."taxable_total" + "price_quotes"."cgst_total" + "price_quotes"."sgst_total" + "price_quotes"."igst_total"),
	CONSTRAINT "price_quotes_single_tax_regime" CHECK ("price_quotes"."igst_total" = 0 OR ("price_quotes"."cgst_total" = 0 AND "price_quotes"."sgst_total" = 0))
);
--> statement-breakpoint
CREATE TABLE "pricing_document_sequences" (
	"series" varchar(10) NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_document_sequences_series_financial_year_pk" PRIMARY KEY("series","financial_year"),
	CONSTRAINT "pricing_document_sequences_next_value_positive" CHECK ("pricing_document_sequences"."next_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_code_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"ip_address" "inet",
	"outcome" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_instrument_id" uuid NOT NULL,
	"referrer_patient_id" uuid NOT NULL,
	"referee_patient_id" uuid NOT NULL,
	"consultation_id" uuid NOT NULL,
	"redemption_id" uuid NOT NULL,
	"status" "referral_event_status" DEFAULT 'qualifying' NOT NULL,
	"program_snapshot" jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_events_not_self_check" CHECK ("referral_events"."referrer_patient_id" <> "referral_events"."referee_patient_id")
);
--> statement-breakpoint
CREATE TABLE "refund_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"taxable_value" numeric(10, 2) NOT NULL,
	"tax_rate_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"cgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"sgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"igst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_components_balances" CHECK ("refund_components"."amount" = "refund_components"."taxable_value" + "refund_components"."cgst_amount" + "refund_components"."sgst_amount" + "refund_components"."igst_amount")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "price_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_number" varchar(40);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "taxable_value" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "cgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "sgst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "igst_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "credit_note_number" varchar(40);--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "credit_note_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_partner_id_affiliate_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."affiliate_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_partner_id_affiliate_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."affiliate_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_redemption_id_discount_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."discount_redemptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_settlement_id_affiliate_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."affiliate_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_partners" ADD CONSTRAINT "affiliate_partners_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_partners" ADD CONSTRAINT "affiliate_partners_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_settlements" ADD CONSTRAINT "affiliate_settlements_partner_id_affiliate_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."affiliate_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_settlements" ADD CONSTRAINT "affiliate_settlements_settled_by_admin_id_admins_id_fk" FOREIGN KEY ("settled_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_instruments" ADD CONSTRAINT "discount_instruments_assigned_patient_id_patients_id_fk" FOREIGN KEY ("assigned_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_instruments" ADD CONSTRAINT "discount_instruments_referrer_patient_id_patients_id_fk" FOREIGN KEY ("referrer_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_instruments" ADD CONSTRAINT "discount_instruments_affiliate_partner_id_affiliate_partners_id_fk" FOREIGN KEY ("affiliate_partner_id") REFERENCES "public"."affiliate_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_instruments" ADD CONSTRAINT "discount_instruments_referral_event_id_referral_events_id_fk" FOREIGN KEY ("referral_event_id") REFERENCES "public"."referral_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_instruments" ADD CONSTRAINT "discount_instruments_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_instrument_id_discount_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."discount_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_affiliate_partner_id_affiliate_partners_id_fk" FOREIGN KEY ("affiliate_partner_id") REFERENCES "public"."affiliate_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote_components" ADD CONSTRAINT "price_quote_components_price_quote_id_price_quotes_id_fk" FOREIGN KEY ("price_quote_id") REFERENCES "public"."price_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_specialty_id_specialties_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referral_instrument_id_discount_instruments_id_fk" FOREIGN KEY ("referral_instrument_id") REFERENCES "public"."discount_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referrer_patient_id_patients_id_fk" FOREIGN KEY ("referrer_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referee_patient_id_patients_id_fk" FOREIGN KEY ("referee_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_redemption_id_discount_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."discount_redemptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_components" ADD CONSTRAINT "refund_components_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_attributions_one_active_idx" ON "affiliate_attributions" USING btree ("patient_id") WHERE "affiliate_attributions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "affiliate_attributions_partner_id_created_at_index" ON "affiliate_attributions" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_commissions_consultation_unique_idx" ON "affiliate_commissions" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_partner_id_status_created_at_index" ON "affiliate_commissions" USING btree ("partner_id","status","created_at");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_status_created_at_index" ON "affiliate_commissions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_settlement_id_index" ON "affiliate_commissions" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "affiliate_partners_status_index" ON "affiliate_partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "affiliate_settlements_partner_id_settled_at_index" ON "affiliate_settlements" USING btree ("partner_id","settled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_instruments_one_referral_per_patient_idx" ON "discount_instruments" USING btree ("referrer_patient_id") WHERE "discount_instruments"."kind" = 'referral' AND "discount_instruments"."status" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "discount_instruments_referral_reward_once_idx" ON "discount_instruments" USING btree ("referral_event_id","referral_reward_role") WHERE "discount_instruments"."kind" = 'referral_reward';--> statement-breakpoint
CREATE INDEX "discount_instruments_status_kind_created_at_index" ON "discount_instruments" USING btree ("status","kind","created_at");--> statement-breakpoint
CREATE INDEX "discount_instruments_assigned_patient_id_status_index" ON "discount_instruments" USING btree ("assigned_patient_id","status");--> statement-breakpoint
CREATE INDEX "discount_instruments_affiliate_partner_id_index" ON "discount_instruments" USING btree ("affiliate_partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_live_consultation_unique_idx" ON "discount_redemptions" USING btree ("consultation_id") WHERE "discount_redemptions"."status" IN ('reserved','consumed');--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_single_use_per_user_idx" ON "discount_redemptions" USING btree ("instrument_id","patient_id") WHERE "discount_redemptions"."status" IN ('reserved','consumed') AND "discount_redemptions"."enforces_single_use_per_user";--> statement-breakpoint
CREATE INDEX "discount_redemptions_instrument_id_status_index" ON "discount_redemptions" USING btree ("instrument_id","status");--> statement-breakpoint
CREATE INDEX "discount_redemptions_instrument_id_patient_id_status_index" ON "discount_redemptions" USING btree ("instrument_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "discount_redemptions_status_expires_at_index" ON "discount_redemptions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "discount_redemptions_patient_id_created_at_index" ON "discount_redemptions" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_quote_components_price_quote_id_code_index" ON "price_quote_components" USING btree ("price_quote_id","code");--> statement-breakpoint
CREATE INDEX "price_quote_components_price_quote_id_position_index" ON "price_quote_components" USING btree ("price_quote_id","position");--> statement-breakpoint
CREATE INDEX "price_quotes_status_expires_at_index" ON "price_quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "price_quotes_patient_id_created_at_index" ON "price_quotes" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "price_quotes_consultation_id_index" ON "price_quotes" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "promotion_code_attempts_patient_id_created_at_index" ON "promotion_code_attempts" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "promotion_code_attempts_ip_address_created_at_index" ON "promotion_code_attempts" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "promotion_code_attempts_created_at_index" ON "promotion_code_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_events_referee_once_idx" ON "referral_events" USING btree ("referee_patient_id");--> statement-breakpoint
CREATE INDEX "referral_events_referrer_patient_id_status_created_at_index" ON "referral_events" USING btree ("referrer_patient_id","status","created_at");--> statement-breakpoint
CREATE INDEX "referral_events_status_created_at_index" ON "referral_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_components_refund_id_code_index" ON "refund_components" USING btree ("refund_id","code");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_price_quote_id_price_quotes_id_fk" FOREIGN KEY ("price_quote_id") REFERENCES "public"."price_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_price_quote_id_unique" UNIQUE("price_quote_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_number_unique" UNIQUE("invoice_number");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_number_unique" UNIQUE("credit_note_number");