CREATE TABLE IF NOT EXISTS "public"."strava_oauth_states" (
  "state" text NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT "strava_oauth_states_pkey" PRIMARY KEY ("state"),
  CONSTRAINT "strava_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

COMMENT ON TABLE "public"."strava_oauth_states" IS 'Temporary OAuth state tokens for Strava authorization flow';

CREATE INDEX IF NOT EXISTS "idx_strava_oauth_states_expires_at"
  ON "public"."strava_oauth_states" ("expires_at");

ALTER TABLE "public"."strava_oauth_states" ENABLE ROW LEVEL SECURITY;

-- Users can only insert their own state
CREATE POLICY "Users can insert own oauth state"
  ON "public"."strava_oauth_states"
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only read their own state
CREATE POLICY "Users can read own oauth state"
  ON "public"."strava_oauth_states"
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can only delete their own state
CREATE POLICY "Users can delete own oauth state"
  ON "public"."strava_oauth_states"
  FOR DELETE
  USING (auth.uid() = user_id);
