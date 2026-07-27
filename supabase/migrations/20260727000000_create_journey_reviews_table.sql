CREATE TABLE IF NOT EXISTS "public"."journey_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journey_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "journey_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "journey_reviews_content_length" CHECK ((length("content") <= 100))
);

ALTER TABLE "public"."journey_reviews" OWNER TO "postgres";

ALTER TABLE ONLY "public"."journey_reviews"
    ADD CONSTRAINT "journey_reviews_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."journey_reviews"
    ADD CONSTRAINT "journey_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

CREATE INDEX "idx_journey_reviews_journey_created" ON "public"."journey_reviews" USING "btree" ("journey_id", "created_at" DESC);

ALTER TABLE "public"."journey_reviews" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read reviews of public journeys" ON "public"."journey_reviews" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."journeys" "j"
  WHERE (("j"."id" = "journey_reviews"."journey_id") AND ("j"."is_public" = true) AND ("j"."status" = 'completed'::"text")))));

CREATE POLICY "Users can insert own reviews" ON "public"."journey_reviews" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."journeys" "j"
  WHERE (("j"."id" = "journey_reviews"."journey_id") AND ("j"."is_public" = true) AND ("j"."status" = 'completed'::"text"))))));

CREATE POLICY "Users can delete own or owner can delete reviews" ON "public"."journey_reviews" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR ("auth"."uid"() = ( SELECT "j"."user_id"
   FROM "public"."journeys" "j"
  WHERE ("j"."id" = "journey_reviews"."journey_id")))));

CREATE POLICY "Public can read profiles" ON "public"."profiles" FOR SELECT TO "anon", "authenticated" USING (true);

CREATE POLICY "Users can upsert own profile" ON "public"."profiles" TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));

GRANT ALL ON TABLE "public"."journey_reviews" TO "anon";
GRANT ALL ON TABLE "public"."journey_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."journey_reviews" TO "service_role";
