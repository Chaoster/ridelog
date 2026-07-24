import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

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
      const { code } = await req.json();

      if (!code || typeof code !== "string") {
        return Response.json(
          { error: "Missing authorization code" },
          { status: 400 }
        );
      }

      const clientId = Deno.env.get("STRAVA_CLIENT_ID");
      const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        console.error("[strava-auth] Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET");
        return Response.json(
          { error: "Strava credentials not configured" },
          { status: 500 }
        );
      }

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

      // Upsert token for the authenticated user
      const user = ctx.user;
      if (!user) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401 }
        );
      }

      const { error } = await ctx.supabase
        .from("strava_tokens")
        .upsert({
          user_id: user.id,
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
