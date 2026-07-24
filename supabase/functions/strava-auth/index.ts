import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { getEnv } from "../_shared/env.ts";

interface StravaTokenResponse {
  token_type: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
  access_token: string;
  athlete: {
    id: number;
    [key: string]: unknown;
  };
}

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, ctx) => {
    try {
      const { code, state } = await req.json();

      if (!code || typeof code !== "string") {
        return Response.json(
          { error: "Missing authorization code" },
          { status: 400 }
        );
      }
      if (!state || typeof state !== "string") {
        return Response.json(
          { error: "Missing OAuth state" },
          { status: 400 }
        );
      }

      const clientId = await getEnv("STRAVA_CLIENT_ID");
      const clientSecret = await getEnv("STRAVA_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        console.error("[strava-auth] Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET");
        return Response.json(
          { error: "Strava credentials not configured" },
          { status: 500 }
        );
      }

      // Look up the user_id associated with this OAuth state.
      // State records are short-lived and deleted after use.
      const { data: stateRow, error: stateError } = await ctx.supabaseAdmin
        .from("strava_oauth_states")
        .select("user_id")
        .eq("state", state)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (stateError || !stateRow) {
        console.error("[strava-auth] invalid or expired state:", stateError);
        return Response.json(
          { error: "Invalid or expired OAuth state" },
          { status: 400 }
        );
      }

      const userId = stateRow.user_id;

      // Delete the state so it cannot be reused
      await ctx.supabaseAdmin
        .from("strava_oauth_states")
        .delete()
        .eq("state", state);

      // Exchange code for tokens
      const tokenRes = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        console.error("[strava-auth] Strava token exchange failed:", tokenRes.status, errorText);
        return Response.json(
          { error: "Failed to exchange Strava authorization code" },
          { status: 400 }
        );
      }

      const tokenData: StravaTokenResponse = await tokenRes.json();

      const {
        access_token,
        refresh_token,
        expires_at,
        athlete,
      } = tokenData;

      const { error } = await ctx.supabaseAdmin
        .from("strava_tokens")
        .upsert({
          user_id: userId,
          access_token,
          refresh_token,
          expires_at,
          athlete_id: athlete?.id ?? null,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "user_id",
        });

      if (error) {
        console.error("[strava-auth] Failed to save token:", error);
        return Response.json(
          { error: "Failed to save Strava token" },
          { status: 500 }
        );
      }

      return Response.json({
        success: true,
        athlete_id: athlete?.id ?? null,
      });
    } catch (err) {
      console.error("[strava-auth] Unexpected error:", err);
      return Response.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  }),
};
