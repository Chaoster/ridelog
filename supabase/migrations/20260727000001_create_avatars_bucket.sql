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

-- Create the public bucket for user avatars
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
VALUES (
  'avatars',
  'avatars',
  true,
  2097152, -- 2MB
  ARRAY['image/webp', 'image/jpeg', 'image/png']::text[],
  now(),
  now()
)
ON CONFLICT (name) DO UPDATE SET public = true;

-- Public read access for avatars
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Public read avatars'
  ) THEN
    CREATE POLICY "Public read avatars" ON storage.objects
      FOR SELECT TO anon, authenticated
      USING (bucket_id = 'avatars');
  END IF;
END $$;

-- Authenticated users can upload avatars
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated upload avatars'
  ) THEN
    CREATE POLICY "Authenticated upload avatars" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'avatars');
  END IF;
END $$;

-- Authenticated users can delete their own avatars
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated delete own avatars'
  ) THEN
    CREATE POLICY "Authenticated delete own avatars" ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'avatars' AND owner = auth.uid());
  END IF;
END $$;
