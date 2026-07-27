-- Add route snapshot URL for static map images with Tianditu basemap
ALTER TABLE public.segments ADD COLUMN IF NOT EXISTS route_snapshot_url text;
