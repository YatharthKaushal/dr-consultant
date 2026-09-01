CREATE TABLE "otp_request_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mobile_number" varchar(16) NOT NULL,
	"audience" "account_type" NOT NULL,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_request_attempts_mobile_number_created_at_index" ON "otp_request_attempts" USING btree ("mobile_number","created_at");--> statement-breakpoint
CREATE INDEX "otp_request_attempts_ip_address_created_at_index" ON "otp_request_attempts" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "otp_request_attempts_created_at_index" ON "otp_request_attempts" USING btree ("created_at");