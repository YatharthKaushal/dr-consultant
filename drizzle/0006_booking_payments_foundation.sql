-- M-11/M-12 FOUNDATION. Three changes, all prerequisites for booking and
-- payments, applied together because the first one is a correctness fix that
-- blocks everything else.
--
-- 1. THE FK INVERSION — this is why a consultation could not be inserted AT ALL.
--    `consultations.id` referenced `payments.consultation_id` AND
--    `clinical_records.consultation_id`, both NON-DEFERRABLE (docs/erd.sql
--    declared them DEFERRABLE; migration 0000 emitted them without the clause,
--    and a non-deferrable constraint cannot be deferred at runtime).
--    Inserting a booking therefore required a clinical_records row to already
--    exist -- impossible, because chief_complaint / risk_category / medicines
--    are NOT NULL and only exist AFTER the consult happens. Meanwhile no
--    forward FK existed in either direction, so orphan payments were entirely
--    unguarded.
--
--    Those constraints were expressing "every consultation eventually has a
--    payment and a clinical record". That is a LIFECYCLE invariant, owned by
--    the status machine -- not an immediate referential one. Encoding it as an
--    FK was the original modelling error. The relationship now runs the normal
--    way; the existing UNIQUE on each consultation_id preserves 1:1 and adds
--    the orphan protection that was genuinely missing.
--
-- 2. THE `refunds` TABLE. `payments` carried refunds as inline columns, making
--    exactly ONE refund per payment representable. Razorpay permits multiple
--    partial refunds against one payment, and docs/SRS.md 5.1 names "refunds"
--    as its own entity. The old columns are left in place and marked
--    @deprecated in the schema so this change is non-destructive; a later
--    migration drops them once nothing reads them. `payment_status` gains
--    `partially_refunded`, which only became a representable state once one
--    payment could carry many refunds.
--
-- 3. `payments.currency`. Razorpay requires a currency on every order and the
--    column did not exist -- INR was implied only by the NAME of
--    `doctors.consultation_fee_inr`, which no code can read.
--
-- Safe on existing data: both DROPped constraints are being removed, not
-- added, so nothing can violate them; the two new FKs are satisfied vacuously
-- because `payments` and `clinical_records` are both empty at this point in
-- the project; and the new column is defaulted.

CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processing', 'processed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'partially_refunded';--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"reason" varchar(200),
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"initiated_by_admin_id" uuid,
	"is_automatic" boolean DEFAULT false NOT NULL,
	"gateway_refund_id" varchar(120),
	"failure_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_gateway_refund_id_unique" UNIQUE("gateway_refund_id")
);
--> statement-breakpoint
ALTER TABLE "consultations" DROP CONSTRAINT "consultations_id_payments_consultation_id_fk";
--> statement-breakpoint
ALTER TABLE "consultations" DROP CONSTRAINT "consultations_id_clinical_records_consultation_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" varchar(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_admin_id_admins_id_fk" FOREIGN KEY ("initiated_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_payment_id_created_at_index" ON "refunds" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_created_at_index" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;