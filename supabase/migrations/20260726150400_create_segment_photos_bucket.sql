-- Allow listing/reading bucket metadata (required for the storage service to find buckets)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'buckets'
    AND policyname = 'Allow access to buckets'
  ) THEN
    CREATE POLICY "Allow access to buckets" ON storage.buckets
      FOR SELECT USING (true);
  END IF;
END $$;

-- Create the public bucket for segment photos (local dev fallback; prod already has this bucket)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
VALUES (
  'segment-photos',
  'segment-photos',
  true,
  10485760, -- 10MB
  ARRAY['image/webp', 'image/jpeg', 'image/png']::text[],
  now(),
  now()
)
ON CONFLICT (name) DO UPDATE SET public = true;

-- Public read access for the public bucket
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Public read segment photos'
  ) THEN
    CREATE POLICY "Public read segment photos" ON storage.objects
      FOR SELECT TO anon, authenticated
      USING (bucket_id = 'segment-photos');
  END IF;
END $$;

-- Authenticated users can upload photos to this bucket
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated upload segment photos'
  ) THEN
    CREATE POLICY "Authenticated upload segment photos" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'segment-photos');
  END IF;
END $$;

-- Authenticated users can delete their own photos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated delete own segment photos'
  ) THEN
    CREATE POLICY "Authenticated delete own segment photos" ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'segment-photos' AND owner = auth.uid());
  END IF;
END $$;
