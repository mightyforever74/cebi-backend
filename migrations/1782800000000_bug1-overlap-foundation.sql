-- =============================================================================
-- BUG-1 Spec v3 — Overlap Constraint DB Temeli (Faz D)
-- Migration: 1782800000000_bug1-overlap-foundation
-- Staging'de uygulandı: 2026-08-02 (nesne-varlık kanıtı 3/3)
-- Prod aynası: savunmacı blok — enterprise.* tabloları yoksa NOTICE ile atlar
--   (FEAT-010 exception_events prod'da kurulmamış olabilir; kör hata yerine
--    açık atlama + log). public.tasks index'i her iki ortamda koşulsuz.
-- Kararlar (Cem, 2026-08-02): estimated_end ayrı kolon YOK → scheduled_end
--   tek sözleşme (karar 1); NULL pencereli eski görevler kontrolden MUAF
--   (karar 2b — index predicate + köprü denetimi aynı sözleşme).
-- Kanıtlı şema: kolon adı vehicle_id (assigned_vehicle_id drivers'ta yaşar);
--   scheduled_start/end timestamp WITHOUT tz, DB Etc/UTC → tsrange.
-- =============================================================================
BEGIN;

-- 1) btree_gist: uuid + tsrange kompozit GIST index'in ön şartı
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2) exception_events CHECK'ine 19. tip: rule_violation (cascade-delay monitörü)
--    Tablo yoksa (prod'da FEAT-010 henüz kurulmadıysa) atlanır.
DO $$
DECLARE cname text;
BEGIN
  IF to_regclass('enterprise.exception_events') IS NULL THEN
    RAISE NOTICE 'enterprise.exception_events yok - CHECK genisletmesi ATLANDI';
    RETURN;
  END IF;
  SELECT conname INTO STRICT cname
  FROM pg_constraint
  WHERE conrelid = 'enterprise.exception_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%eta_delay%';
  EXECUTE format('ALTER TABLE enterprise.exception_events DROP CONSTRAINT %I', cname);
  ALTER TABLE enterprise.exception_events ADD CONSTRAINT exception_events_exception_type_check
  CHECK (exception_type = ANY (ARRAY[
    'eta_delay','traffic_impact','driver_no_show','driver_offline',
    'driver_location_mismatch','dock_conflict','compliance_zone_breach',
    'locker_pickup_expired','tender_withdrawn','tender_no_quotes',
    'returns_pickup_failed','rts_warehouse_unreachable','invoice_discrepancy',
    'invoice_audit_deadline_expired','rest_violation',
    'border_crossing_compliance_breach','range_anxiety_breach',
    'csrd_data_quality_breach','rule_violation']::text[]));
END $$;

-- 3) Partial GIST index — yalnız aktif statüler + her iki pencere dolu
--    (karar 2b: NULL pencereli legacy görevler kapsam dışı)
CREATE INDEX IF NOT EXISTS idx_tasks_time_overlap ON public.tasks
USING GIST (vehicle_id, tsrange(scheduled_start, scheduled_end))
WHERE status IN ('assigned','accepted','in_progress','pending_review')
  AND scheduled_start IS NOT NULL
  AND scheduled_end IS NOT NULL;

-- 4) migration kaydı
INSERT INTO pgmigrations (name, run_on)
SELECT '1782800000000_bug1-overlap-foundation', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1782800000000_bug1-overlap-foundation');

COMMIT;
