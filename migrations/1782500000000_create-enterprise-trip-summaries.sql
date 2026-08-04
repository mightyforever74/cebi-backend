-- FEAT-010 v1.8 — FN-19 trip_summaries (#19 ONAYLI: enterprise worker yazar)
-- Spec: FEAT-010 §6.5. Retention YOK (#21 ONAYLI). Idempotent.
-- NOT: kaynak tasks.scheduled_*/actual_* timestamp WITHOUT tz — timestamptz'e
-- session TZ (UTC) varsayımıyla yazılır.

CREATE TABLE IF NOT EXISTS enterprise.trip_summaries (
  task_id              uuid PRIMARY KEY,
  company_id           uuid NOT NULL,
  vehicle_id           uuid,
  driver_id            uuid,
  planned_start        timestamptz,
  planned_end          timestamptz,
  actual_start         timestamptz,
  actual_end           timestamptz,
  planned_distance_km  numeric,
  actual_distance_km   numeric,
  location_points      int,
  eta_deviation_min    numeric,
  alert_counts         jsonb,
  summarized_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_summaries_company_end
  ON enterprise.trip_summaries (company_id, actual_end DESC);

-- FN-19 rol ön koşulu: enterprise_backend'in locations/alerts SELECT'i YOKTU (kanıtlı)
GRANT SELECT ON public.locations TO enterprise_backend;
GRANT SELECT ON public.alerts    TO enterprise_backend;
GRANT ALL ON enterprise.trip_summaries TO enterprise_backend;

\echo '=== enterprise.trip_summaries + GRANTs OK ==='
