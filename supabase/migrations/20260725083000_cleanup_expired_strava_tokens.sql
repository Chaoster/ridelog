-- Cleanup expired Strava session tokens and OAuth states daily.
-- This prevents the helper tables from growing indefinitely.

CREATE OR REPLACE FUNCTION public.cleanup_expired_strava_tokens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.strava_session_tokens WHERE expires_at <= now();
  DELETE FROM public.strava_oauth_states WHERE expires_at <= now();
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_strava_tokens() IS
  'Removes expired Strava session tokens and OAuth state records';

-- Schedule daily cleanup at 03:30 UTC if pg_cron is available.
-- On local dev without pg_cron, the function is still available for manual cleanup.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup-expired-strava-tokens',
      '30 3 * * *',
      'SELECT public.cleanup_expired_strava_tokens();'
    );
  END IF;
END $$;
