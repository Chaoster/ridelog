import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { getEnv } from "../_shared/env.ts";

interface StravaTokenRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

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

interface StravaActivity {
  id: number;
  name: string;
  start_date: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  type: string;
  [key: string]: unknown;
}

async function resolveUserFromSessionToken(
  supabaseAdmin: any,
  sessionToken: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("strava_session_tokens")
    .select("user_id")
    .eq("token", sessionToken)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (error || !data) return null;
  return data.user_id;
}

async function refreshStravaToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<StravaTokenResponse> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava refresh failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function getValidAccessToken(
  supabaseAdmin: any,
  userId: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("strava_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Strava not connected");
  }

  const token = data as StravaTokenRow;

  // Refresh if expiring within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at <= now + 300) {
    const refreshed = await refreshStravaToken(
      token.refresh_token,
      clientId,
      clientSecret
    );

    const { error: updateError } = await supabaseAdmin
      .from("strava_tokens")
      .update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_at,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (updateError) {
      console.error("[strava-activities] Failed to update refreshed token:", updateError);
    }

    return refreshed.access_token;
  }

  return token.access_token;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, ctx) => {
    try {
      const url = new URL(req.url);
      const sessionToken = url.searchParams.get("session_token");

      if (!sessionToken) {
        return Response.json(
          { error: "Missing session token" },
          { status: 400 }
        );
      }

      const userId = await resolveUserFromSessionToken(ctx.supabaseAdmin, sessionToken);
      if (!userId) {
        return Response.json(
          { error: "Invalid or expired session token" },
          { status: 401 }
        );
      }

      const clientId = await getEnv("STRAVA_CLIENT_ID");
      const clientSecret = await getEnv("STRAVA_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        console.error("[strava-activities] Missing Strava credentials");
        return Response.json(
          { error: "Strava credentials not configured" },
          { status: 500 }
        );
      }

      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const perPage = parseInt(url.searchParams.get("per_page") || "30", 10);

      const accessToken = await getValidAccessToken(
        ctx.supabaseAdmin,
        userId,
        clientId,
        clientSecret
      );

      const activitiesRes = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?page=${page}&per_page=${perPage}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!activitiesRes.ok) {
        const text = await activitiesRes.text();
        console.error("[strava-activities] Strava API error:", activitiesRes.status, text);
        return Response.json(
          { error: "Failed to fetch Strava activities" },
          { status: 400 }
        );
      }

      const activities: StravaActivity[] = await activitiesRes.json();

      const formatted = activities.map((a) => ({
        id: a.id,
        name: a.name,
        start_date: a.start_date,
        distance: Math.round((a.distance / 1000) * 10) / 10, // meters to km
        duration: formatDuration(a.moving_time),
        elevation_gain: Math.round(a.total_elevation_gain),
        type: a.type,
      }));

      return Response.json({ activities: formatted });
    } catch (err) {
      console.error("[strava-activities] Unexpected error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      return Response.json({ error: message }, { status: 500 });
    }
  }),
};
