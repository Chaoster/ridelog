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
  workout_type?: number;
  average_speed?: number;
  max_speed?: number;
  average_watts?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number;
  trainer?: boolean;
  commute?: boolean;
  manual?: boolean;
  private?: boolean;
  gear_id?: string | null;
  description?: string | null;
  elev_high?: number;
  elev_low?: number;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  map?: {
    summary_polyline?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function resolveUserFromSessionToken(
  supabaseAdmin: any,
  sessionToken: string
): Promise<string | null> {
  console.log("[strava-activities] resolving session token:", sessionToken.slice(0, 8) + "...");
  const { data, error } = await supabaseAdmin
    .from("strava_session_tokens")
    .select("user_id, expires_at")
    .eq("token", sessionToken)
    .single();

  if (error) {
    console.error("[strava-activities] session token lookup error:", error);
    return null;
  }

  if (!data) {
    console.error("[strava-activities] session token not found");
    return null;
  }

  const now = new Date().toISOString();
  if (data.expires_at <= now) {
    console.error("[strava-activities] session token expired. expires_at:", data.expires_at, "now:", now);
    return null;
  }

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
    console.error("[strava-activities] Strava refresh failed:", res.status, text);
    throw new Error("Strava授权已过期，请重新授权");
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
    throw new Error("Strava授权已过期，请重新授权");
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
      const { page: pageParam, per_page: perPageParam, sessionToken } = await req.json();

      if (!sessionToken || typeof sessionToken !== "string") {
        return Response.json(
          { error: "Strava授权已过期，请重新授权" }
        );
      }

      const userId = await resolveUserFromSessionToken(ctx.supabaseAdmin, sessionToken);
      if (!userId) {
        return Response.json(
          { error: "Strava授权已过期，请重新授权" }
        );
      }

      const clientId = await getEnv("STRAVA_CLIENT_ID");
      const clientSecret = await getEnv("STRAVA_CLIENT_SECRET");

      if (!clientId || !clientSecret) {
        console.error("[strava-activities] Missing Strava credentials");
        return Response.json(
          { error: "Strava credentials not configured" }
        );
      }

      const page = parseInt(pageParam || "1", 10);
      const perPage = parseInt(perPageParam || "30", 10);

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

        let detail = text || String(activitiesRes.status);
        try {
          const parsed = JSON.parse(text);
          if (parsed.message === "Forbidden" && parsed.errors?.some((e: any) => e.code === "Inactive")) {
            detail = "Strava授权已过期，请重新授权";
          }
        } catch {
          // ignore parse error
        }

        return Response.json(
          { error: `Failed to fetch Strava activities: ${detail}` }
        );
      }

      const activities: StravaActivity[] = await activitiesRes.json();

      const formatted = activities.map((a) => {
        const avgSpeedKmh = a.average_speed ? Math.round((a.average_speed * 3.6) * 10) / 10 : 0;
        const maxSpeedKmh = a.max_speed ? Math.round((a.max_speed * 3.6) * 10) / 10 : 0;
        return {
          id: a.id,
          name: a.name,
          start_date: a.start_date,
          distance: Math.round((a.distance / 1000) * 10) / 10, // meters to km
          duration: formatDuration(a.moving_time),
          elevation_gain: Math.round(a.total_elevation_gain),
          type: a.type,
          has_route: !!(a.map?.summary_polyline && a.map.summary_polyline.length > 0),
          summary_polyline: a.map?.summary_polyline || '',
          avg_speed: avgSpeedKmh,
          max_speed: maxSpeedKmh,
          avg_watts: a.average_watts ? Math.round(a.average_watts) : null,
          avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
          max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
          calories: a.calories ? Math.round(a.calories) : null,
          trainer: !!a.trainer,
          commute: !!a.commute,
          manual: !!a.manual,
          private: !!a.private,
          workout_type: a.workout_type ?? 0,
          gear_id: a.gear_id || null,
          description: a.description || '',
          elev_high: a.elev_high ? Math.round(a.elev_high) : null,
          elev_low: a.elev_low ? Math.round(a.elev_low) : null,
        };
      });

      return Response.json({ activities: formatted });
    } catch (err) {
      console.error("[strava-activities] Unexpected error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      // Return 200 for known business errors so the client can read data.error
      if (message === "Strava授权已过期，请重新授权") {
        return Response.json({ error: message });
      }
      return Response.json({ error: message }, { status: 500 });
    }
  }),
};
