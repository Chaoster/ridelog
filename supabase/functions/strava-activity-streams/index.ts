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

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

async function fetchElevationsFromOpenElevation(
  points: [number, number][]
): Promise<(number | null)[]> {
  if (points.length === 0) return [];

  // Open-Elevation free tier works best with modest batch sizes.
  const sampleSize = Math.min(points.length, 100);
  const sampledIndices: number[] = [];
  for (let i = 0; i < sampleSize; i++) {
    sampledIndices.push(Math.round((i / Math.max(sampleSize - 1, 1)) * (points.length - 1)));
  }

  const locations = sampledIndices.map((idx) => ({
    latitude: points[idx][0],
    longitude: points[idx][1],
  }));

  try {
    const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations }),
    });

    if (!res.ok) {
      throw new Error(`Open-Elevation error: ${res.status}`);
    }

    const data = await res.json();
    const sampledElevs: (number | null)[] = (data.results || []).map((r: any) =>
      r.elevation != null ? Number(r.elevation) : null
    );

    const elevations: (number | null)[] = new Array(points.length).fill(null);
    for (let i = 0; i < sampledIndices.length; i++) {
      elevations[sampledIndices[i]] = sampledElevs[i] ?? null;
    }

    // Linear interpolation between sampled points.
    let lastKnownIndex = 0;
    for (let i = 1; i < points.length; i++) {
      if (elevations[i] !== null) {
        const start = lastKnownIndex;
        const end = i;
        const startElev = elevations[start];
        const endElev = elevations[end];
        if (startElev != null && endElev != null) {
          for (let j = start + 1; j < end; j++) {
            const ratio = (j - start) / (end - start);
            elevations[j] = startElev + (endElev - startElev) * ratio;
          }
        }
        lastKnownIndex = i;
      }
    }

    return elevations;
  } catch (err) {
    console.error("[strava-activity-streams] Open-Elevation failed:", err);
    return new Array(points.length).fill(null);
  }
}

async function resolveUserFromSessionToken(
  supabaseAdmin: any,
  sessionToken: string
): Promise<string | null> {
  console.log("[strava-activity-streams] resolving session token:", sessionToken.slice(0, 8) + "...");
  const { data, error } = await supabaseAdmin
    .from("strava_session_tokens")
    .select("user_id, expires_at")
    .eq("token", sessionToken)
    .single();

  if (error) {
    console.error("[strava-activity-streams] session token lookup error:", error);
    return null;
  }

  if (!data) {
    console.error("[strava-activity-streams] session token not found");
    return null;
  }

  const now = new Date().toISOString();
  if (data.expires_at <= now) {
    console.error("[strava-activity-streams] session token expired. expires_at:", data.expires_at, "now:", now);
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
    console.error("[strava-activity-streams] Strava refresh failed:", res.status, text);
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
          { error: "Strava授权已过期，请重新授权" },
          { status: 400 }
        );
      }

      const userId = await resolveUserFromSessionToken(ctx.supabaseAdmin, sessionToken);
      if (!userId) {
        return Response.json(
          { error: "Strava授权已过期，请重新授权" },
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
      console.log("[strava-activity-streams] raw streams keys:", Object.keys(streams || {}), "activityId:", activityId);

      const latlng = streams.latlng?.data as [number, number][] | undefined;
      const elevation = streams.elevation?.data as number[] | undefined;
      const distance = streams.distance?.data as number[] | undefined;
      const time = streams.time?.data as number[] | undefined;

      console.log("[strava-activity-streams] latlng length:", latlng?.length, "elevation length:", elevation?.length, "distance length:", distance?.length, "time length:", time?.length);

      let effectiveLatLng = latlng;
      let effectiveElevation: (number | null)[] | undefined = elevation;
      let effectiveDistance = distance && distance.length > 0 ? distance[distance.length - 1] : 0;
      let elevationGain = 0;
      let totalSeconds = time && time.length > 0 ? time[time.length - 1] : 0;
      let detailElevationGain = 0;
      let detail: any = null;

      // Fetch activity detail if any primary stream is missing, so we have fallback data.
      const needsDetailFallback = (!effectiveLatLng || effectiveLatLng.length === 0) ||
        (!effectiveElevation || effectiveElevation.length === 0) ||
        (totalSeconds === 0);

      if (needsDetailFallback) {
        const detailRes = await fetch(
          `https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=false`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (detailRes.ok) {
          detail = await detailRes.json();
          console.log("[strava-activity-streams] activity detail:", JSON.stringify({
            distance: detail.distance,
            moving_time: detail.moving_time,
            total_elevation_gain: detail.total_elevation_gain,
            map: detail.map,
          }));
          detailElevationGain = Number(detail.total_elevation_gain) || 0;
          if (totalSeconds === 0) {
            totalSeconds = Number(detail.moving_time) || 0;
          }
        } else {
          console.error("[strava-activity-streams] failed to fetch activity detail:", detailRes.status, await detailRes.text());
        }
      }

      if (!effectiveLatLng || effectiveLatLng.length === 0) {
        const encodedPolyline = detail?.map?.polyline || detail?.map?.summary_polyline;
        if (encodedPolyline) {
          effectiveLatLng = decodePolyline(encodedPolyline);
          effectiveDistance = detail.distance || 0;
          console.log("[strava-activity-streams] decoded polyline points:", effectiveLatLng.length);
        }
      }

      if (!effectiveLatLng || effectiveLatLng.length === 0) {
        return Response.json(
          { error: "该活动没有路线数据，请选择包含 GPS 记录的骑行活动" },
          { status: 400 }
        );
      }

      // If Strava did not provide an elevation stream, try to fetch elevations from an external service.
      if (!effectiveElevation || effectiveElevation.length === 0) {
        console.log("[strava-activity-streams] fetching elevations from Open-Elevation for", effectiveLatLng.length, "points");
        effectiveElevation = await fetchElevationsFromOpenElevation(effectiveLatLng);
      }

      // Build gpxPoints: [lat, lng, elevation]
      const gpxPoints: [number, number, number | null][] = effectiveLatLng.map((coord, i) => [
        coord[0],
        coord[1],
        effectiveElevation ? effectiveElevation[i] : null,
      ]);

      const totalDistance = effectiveDistance > 0
        ? Math.round((effectiveDistance / 1000) * 10) / 10
        : 0;

      // Calculate elevation gain from elevation stream if available; otherwise use Strava's summary value.
      if (effectiveElevation) {
        for (let i = 1; i < effectiveElevation.length; i++) {
          const prev = effectiveElevation[i - 1];
          const curr = effectiveElevation[i];
          if (prev != null && curr != null) {
            const diff = curr - prev;
            if (diff > 0) elevationGain += diff;
          }
        }
      }
      elevationGain = Math.round(elevationGain > 0 ? elevationGain : detailElevationGain);

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
