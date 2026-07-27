import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { getEnv } from "../_shared/env.ts";

const TIANDITU_STATIC_URL = "https://api.tianditu.gov.cn/staticimage";
const SNAPSHOT_BUCKET = "segment-photos";
const SNAPSHOT_FOLDER = "route-snapshots";
const MAX_URL_LENGTH = 1800;
const TARGET_WIDTH = 800;
const TARGET_HEIGHT = 400;
const MAX_PATH_POINTS = 80;

function simplifyPoints(points: [number, number][], maxCount: number): [number, number][] {
  if (points.length <= maxCount) return points;
  const step = points.length / maxCount;
  const result: [number, number][] = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.min(Math.floor(i * step), points.length - 1);
    result.push(points[idx]);
  }
  if (result[result.length - 1][0] !== points[points.length - 1][0] ||
      result[result.length - 1][1] !== points[points.length - 1][1]) {
    result.push(points[points.length - 1]);
  }
  return result;
}

function computeBounds(points: [number, number][]) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lat, lng] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, maxLng, minLat, maxLat };
}

function computeZoom(bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number }, width: number, height: number) {
  const lngDiff = bounds.maxLng - bounds.minLng;
  const latDiff = bounds.maxLat - bounds.minLat;
  if (lngDiff === 0 && latDiff === 0) return 15;

  // World size in pixels at zoom z is 256 * 2^z
  // lngPixel = (lng + 180) / 360 * worldSize
  const maxZoom = 18;
  for (let z = maxZoom; z >= 1; z--) {
    const worldSize = 256 * Math.pow(2, z);
    const pxPerLng = worldSize / 360;
    const pxPerLat = worldSize / (2 * Math.PI);

    const latMinRad = (bounds.minLat * Math.PI) / 180;
    const latMaxRad = (bounds.maxLat * Math.PI) / 180;
    const mercatorMin = Math.log(Math.tan(Math.PI / 4 + latMinRad / 2));
    const mercatorMax = Math.log(Math.tan(Math.PI / 4 + latMaxRad / 2));

    const w = (bounds.maxLng - bounds.minLng) * pxPerLng;
    const h = Math.abs(mercatorMax - mercatorMin) * pxPerLat;

    if (w <= width * 0.7 && h <= height * 0.7) {
      return z;
    }
  }
  return 1;
}

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, ctx) => {
    try {
      const { segmentId } = await req.json();
      if (!segmentId || typeof segmentId !== "string") {
        return Response.json({ error: "Missing segmentId" }, { status: 400 });
      }

      const tiandituKey = await getEnv("TIANDITU_KEY");
      if (!tiandituKey) {
        console.error("[generate-route-snapshot] Missing TIANDITU_KEY");
        return Response.json({ error: "Tianditu key not configured" }, { status: 500 });
      }

      const supabase = ctx.supabaseAdmin;

      // Fetch segment and gpx points
      const { data: segment, error: segmentErr } = await supabase
        .from("segments")
        .select("id, journey_id, day_index")
        .eq("id", segmentId)
        .maybeSingle();
      if (segmentErr || !segment) {
        console.error("[generate-route-snapshot] segment error:", segmentErr);
        return Response.json({ error: "Segment not found" }, { status: 404 });
      }

      const { data: gpxRows, error: gpxErr } = await supabase
        .from("gpx_points")
        .select("lat, lng")
        .eq("segment_id", segmentId)
        .order("point_index", { ascending: true });
      if (gpxErr) {
        console.error("[generate-route-snapshot] gpx error:", gpxErr);
        return Response.json({ error: "Failed to load gpx points" }, { status: 500 });
      }
      if (!gpxRows || gpxRows.length < 2) {
        return Response.json({ error: "Not enough gpx points" }, { status: 400 });
      }

      const points: [number, number][] = gpxRows
        .map((r) => [Number(r.lat), Number(r.lng)] as [number, number])
        .filter((p) => !isNaN(p[0]) && !isNaN(p[1]));

      if (points.length < 2) {
        return Response.json({ error: "Not enough valid gpx points" }, { status: 400 });
      }

      const simplified = simplifyPoints(points, MAX_PATH_POINTS);
      const bounds = computeBounds(simplified);
      const centerLng = (bounds.minLng + bounds.maxLng) / 2;
      const centerLat = (bounds.minLat + bounds.maxLat) / 2;
      const zoom = computeZoom(bounds, TARGET_WIDTH, TARGET_HEIGHT);

      const paths = simplified.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
      const pathStyles = "0xFF7B3D,4,1,0x00000000";

      const imageUrl = new URL(TIANDITU_STATIC_URL);
      imageUrl.searchParams.set("center", `${centerLng.toFixed(6)},${centerLat.toFixed(6)}`);
      imageUrl.searchParams.set("width", String(TARGET_WIDTH));
      imageUrl.searchParams.set("height", String(TARGET_HEIGHT));
      imageUrl.searchParams.set("zoom", String(zoom));
      imageUrl.searchParams.set("layers", "vec_w,cva_w");
      imageUrl.searchParams.set("paths", paths);
      imageUrl.searchParams.set("pathStyles", pathStyles);
      imageUrl.searchParams.set("tk", tiandituKey);

      const finalUrl = imageUrl.toString();
      if (finalUrl.length > MAX_URL_LENGTH) {
        // Further reduce points if URL too long
        const reducedCount = Math.max(10, Math.floor(MAX_PATH_POINTS * (MAX_URL_LENGTH / finalUrl.length)));
        const reduced = simplifyPoints(points, reducedCount);
        const reducedPaths = reduced.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
        imageUrl.searchParams.set("paths", reducedPaths);
      }

      console.log("[generate-route-snapshot] calling tianditu:", imageUrl.toString().slice(0, 200));

      const imageRes = await fetch(imageUrl.toString(), { method: "GET" });
      if (!imageRes.ok) {
        const text = await imageRes.text();
        console.error("[generate-route-snapshot] tianditu error:", imageRes.status, text);
        return Response.json({ error: "Tianditu static image failed", detail: text }, { status: 502 });
      }

      const contentType = imageRes.headers.get("content-type") || "image/png";
      const imageBlob = await imageRes.blob();

      const fileName = `${segment.journey_id}/${segmentId}.png`;
      const filePath = `${SNAPSHOT_FOLDER}/${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from(SNAPSHOT_BUCKET)
        .upload(filePath, imageBlob, {
          contentType,
          upsert: true,
        });
      if (uploadErr) {
        console.error("[generate-route-snapshot] upload error:", uploadErr);
        return Response.json({ error: "Failed to upload snapshot", detail: uploadErr.message }, { status: 500 });
      }

      const { data: publicUrlData } = supabase.storage
        .from(SNAPSHOT_BUCKET)
        .getPublicUrl(filePath);
      const publicUrl = publicUrlData?.publicUrl;

      if (!publicUrl) {
        return Response.json({ error: "Failed to get public URL" }, { status: 500 });
      }

      const { error: updateErr } = await supabase
        .from("segments")
        .update({ route_snapshot_url: publicUrl })
        .eq("id", segmentId);
      if (updateErr) {
        console.error("[generate-route-snapshot] update error:", updateErr);
        return Response.json({ error: "Failed to update segment", detail: updateErr.message }, { status: 500 });
      }

      return Response.json({ url: publicUrl });
    } catch (err) {
      console.error("[generate-route-snapshot] unexpected error:", err);
      return Response.json({ error: "Internal error", detail: (err as Error).message }, { status: 500 });
    }
  }),
};
