CREATE TABLE IF NOT EXISTS "public"."strava_tokens" (
  "user_id" uuid NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "expires_at" bigint NOT NULL,
  "athlete_id" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "strava_tokens_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "strava_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

COMMENT ON TABLE "public"."strava_tokens" IS 'Stores Strava OAuth tokens per user';

ALTER TABLE "public"."strava_tokens" ENABLE ROW LEVEL SECURITY;

-- Users can only read their own token
CREATE POLICY "Users can read own strava token"
  ON "public"."strava_tokens"
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can only insert/update their own token
CREATE POLICY "Users can insert own strava token"
  ON "public"."strava_tokens"
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own strava token"
  ON "public"."strava_tokens"
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Optional: service role can manage all tokens (for Edge Functions using service_role key)
-- Edge Functions with service_role bypass RLS by default, so this is not strictly needed.

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strava_tokens_updated_at
  BEFORE UPDATE ON "public"."strava_tokens"
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
