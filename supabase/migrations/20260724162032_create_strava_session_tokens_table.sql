CREATE TABLE IF NOT EXISTS "public"."strava_session_tokens" (
  "token" text NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  CONSTRAINT "strava_session_tokens_pkey" PRIMARY KEY ("token"),
  CONSTRAINT "strava_session_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

COMMENT ON TABLE "public"."strava_session_tokens" IS 'Short-lived tokens for Strava import session across OAuth redirect';

CREATE INDEX IF NOT EXISTS "idx_strava_session_tokens_expires_at"
  ON "public"."strava_session_tokens" ("expires_at");

ALTER TABLE "public"."strava_session_tokens" ENABLE ROW LEVEL SECURITY;

-- Only service role can manage these tokens; users never access this table directly.
-- Edge Functions use supabaseAdmin.
