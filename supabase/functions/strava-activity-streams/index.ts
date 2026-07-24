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

interface StravaStream {
  type: string;
  data: number[] | number[][];
}

interface StravaStreamsResponse {
  latlng?: StravaStream;
  elevation?: StravaStream;
  distance?: StravaStream;
  time?: StravaStream;
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
      console.error("[strava-activity-streams] Failed to update refreshed token:", updateError);
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
      const { activityId, sessionToken } = await req.json();

      if (!sessionToken || typeof sessionToken !== "string") {
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
        console.error("[strava-activity-streams] Missing Strava credentials");
        return Response.json(
          { error: "Strava credentials not configured" },
          { status: 500 }
        );
      }

      if (!activityId || typeof activityId !== "number") {
        return Response.json(
          { error: "Missing or invalid activityId" },
          { status: 400 }
        );
      }

      const accessToken = await getValidAccessToken(
        ctx.supabaseAdmin,
        userId,
        clientId,
        clientSecret
      );

      const streamsRes = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=latlng,elevation,distance,time`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!streamsRes.ok) {
        const text = await streamsRes.text();
        console.error("[strava-activity-streams] Strava API error:", streamsRes.status, text);
        return Response.json(
          { error: "Failed to fetch activity streams" },
          { status: 400 }
        );
      }

      const streams: StravaStreamsResponse = await streamsRes.json();

      const latlng = streams.latlng?.data as [number, number][] | undefined;
      const elevation = streams.elevation?.data as number[] | undefined;
      const distance = streams.distance?.data as number[] | undefined;
      const time = streams.time?.data as number[] | undefined;

      if (!latlng || latlng.length === 0) {
        return Response.json(
          { error: "Activity has no route data" },
          { status: 400 }
        );
      }

      // Build gpxPoints: [lat, lng, elevation]
      const gpxPoints: [number, number, number | null][] = latlng.map((coord, i) => [
        coord[0],
        coord[1],
        elevation ? elevation[i] : null,
      ]);

      const totalDistance = distance && distance.length > 0
        ? Math.round((distance[distance.length - 1] / 1000) * 10) / 10
        : 0;

      // Calculate elevation gain from elevation stream
      let elevationGain = 0;
      if (elevation) {
        for (let i = 1; i < elevation.length; i++) {
          const diff = elevation[i] - elevation[i - 1];
          if (diff > 0) elevationGain += diff;
        }
      }
      elevationGain = Math.round(elevationGain);

      const totalSeconds = time && time.length > 0 ? time[time.length - 1] : 0;

      return Response.json({
        activity_id: activityId,
        points: gpxPoints,
        distance: totalDistance,
        elevation_gain: elevationGain,
        duration: formatDuration(totalSeconds),
        point_count: gpxPoints.length,
      });
    } catch (err) {
      console.error("[strava-activity-streams] Unexpected error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      return Response.json({ error: message }, { status: 500 });
    }
  }),
};
