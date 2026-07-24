


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."gpx_points" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "segment_id" "uuid" NOT NULL,
    "lat" numeric NOT NULL,
    "lng" numeric NOT NULL,
    "elevation" numeric,
    "point_index" integer NOT NULL
);


ALTER TABLE "public"."gpx_points" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."journeys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" NOT NULL,
    "cover_url" "text",
    "total_distance" numeric DEFAULT 0,
    "total_elevation" numeric DEFAULT 0,
    "completed_at" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_public" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "journeys_status_check" CHECK (("status" = ANY (ARRAY['ongoing'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."journeys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "segment_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "lat" numeric,
    "lng" numeric,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "nickname" "text" DEFAULT '一只小毛驴'::"text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."segments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journey_id" "uuid" NOT NULL,
    "day_index" integer NOT NULL,
    "date" "date",
    "distance" numeric DEFAULT 0,
    "elevation" numeric DEFAULT 0,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "elevation_loss" numeric DEFAULT 0,
    "duration" "text",
    "route_svg" "text"
);


ALTER TABLE "public"."segments" OWNER TO "postgres";


ALTER TABLE ONLY "public"."gpx_points"
    ADD CONSTRAINT "gpx_points_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journeys"
    ADD CONSTRAINT "journeys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."segments"
    ADD CONSTRAINT "segments_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_journeys_public_feed" ON "public"."journeys" USING "btree" ("is_public", "status", "created_at" DESC) WHERE (("is_public" = true) AND ("status" = 'completed'::"text"));



ALTER TABLE ONLY "public"."gpx_points"
    ADD CONSTRAINT "gpx_points_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journeys"
    ADD CONSTRAINT "journeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."segments"
    ADD CONSTRAINT "segments_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE CASCADE;



CREATE POLICY "Authenticated can read public completed journeys" ON "public"."journeys" FOR SELECT TO "authenticated" USING ((("status" = 'completed'::"text") AND ("is_public" = true)));



CREATE POLICY "Public can read completed journeys" ON "public"."journeys" FOR SELECT TO "anon" USING ((("is_public" = true) AND ("status" = 'completed'::"text")));



CREATE POLICY "Public can read gpx_points of public journeys" ON "public"."gpx_points" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."journeys" "j"
     JOIN "public"."segments" "s" ON (("s"."journey_id" = "j"."id")))
  WHERE (("s"."id" = "gpx_points"."segment_id") AND ("j"."is_public" = true) AND ("j"."status" = 'completed'::"text")))));



CREATE POLICY "Public can read photos of public journeys" ON "public"."photos" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."journeys" "j"
     JOIN "public"."segments" "s" ON (("s"."journey_id" = "j"."id")))
  WHERE (("s"."id" = "photos"."segment_id") AND ("j"."is_public" = true) AND ("j"."status" = 'completed'::"text")))));



CREATE POLICY "Public can read segments of public journeys" ON "public"."segments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."journeys" "j"
  WHERE (("j"."id" = "segments"."journey_id") AND ("j"."is_public" = true) AND ("j"."status" = 'completed'::"text")))));



CREATE POLICY "Users can only access own gpx_points" ON "public"."gpx_points" USING (("auth"."uid"() = ( SELECT "j"."user_id"
   FROM ("public"."journeys" "j"
     JOIN "public"."segments" "s" ON (("s"."journey_id" = "j"."id")))
  WHERE ("s"."id" = "gpx_points"."segment_id"))));



CREATE POLICY "Users can only access own journeys" ON "public"."journeys" TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can only access own photos" ON "public"."photos" USING (("auth"."uid"() = ( SELECT "j"."user_id"
   FROM ("public"."journeys" "j"
     JOIN "public"."segments" "s" ON (("s"."journey_id" = "j"."id")))
  WHERE ("s"."id" = "photos"."segment_id"))));



CREATE POLICY "Users can only access own segments" ON "public"."segments" USING (("auth"."uid"() = ( SELECT "journeys"."user_id"
   FROM "public"."journeys"
  WHERE ("journeys"."id" = "segments"."journey_id"))));



ALTER TABLE "public"."gpx_points" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."journeys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."segments" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





































































































































































GRANT ALL ON TABLE "public"."gpx_points" TO "anon";
GRANT ALL ON TABLE "public"."gpx_points" TO "authenticated";
GRANT ALL ON TABLE "public"."gpx_points" TO "service_role";



GRANT ALL ON TABLE "public"."journeys" TO "anon";
GRANT ALL ON TABLE "public"."journeys" TO "authenticated";
GRANT ALL ON TABLE "public"."journeys" TO "service_role";



GRANT ALL ON TABLE "public"."photos" TO "anon";
GRANT ALL ON TABLE "public"."photos" TO "authenticated";
GRANT ALL ON TABLE "public"."photos" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."segments" TO "anon";
GRANT ALL ON TABLE "public"."segments" TO "authenticated";
GRANT ALL ON TABLE "public"."segments" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";


  create policy "Authenticated upload 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((auth.role() = 'authenticated'::text));



  create policy "Authenticated upload k098pn_0"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((auth.role() = 'authenticated'::text));



  create policy "Public read 1oj01fe_0"
  on "storage"."objects"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Public read k098pn_0"
  on "storage"."objects"
  as permissive
  for select
  to authenticated, anon
using (true);



