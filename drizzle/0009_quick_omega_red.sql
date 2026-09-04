CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_rating_range_check" CHECK ("feedback"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_consultation_id_index" ON "feedback" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "feedback_rating_created_at_index" ON "feedback" USING btree ("rating","created_at");--> statement-breakpoint
CREATE INDEX "feedback_patient_id_index" ON "feedback" USING btree ("patient_id");