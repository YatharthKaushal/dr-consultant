CREATE TABLE "followup_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consultation_id" uuid NOT NULL,
	"pathway_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"status" "followup_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "followup_assignments" ADD CONSTRAINT "followup_assignments_consultation_id_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."consultations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_assignments" ADD CONSTRAINT "followup_assignments_pathway_id_followup_pathways_id_fk" FOREIGN KEY ("pathway_id") REFERENCES "public"."followup_pathways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "followup_assignments_consultation_id_index" ON "followup_assignments" USING btree ("consultation_id");--> statement-breakpoint
CREATE INDEX "followup_assignments_status_starts_on_index" ON "followup_assignments" USING btree ("status","starts_on");