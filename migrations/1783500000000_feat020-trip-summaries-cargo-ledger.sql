-- FEAT-020 Katman B — Tarihsel Ledger / Yield Management verisi (Phase 1.3a)
-- Spec: tulipfleet-dispatcher/docs/functions/FEAT-020-capacity-aware-delivery-promising.md §5.2
-- ADR: 0004 (Database Strategy). Cem onayi: 2026-10-13 (ledger-once kurulumu, baştan aşağı
-- genişletilmiş FEAT-020 mimarisinin ilk katmanı).
--
-- Kapsam: enterprise.trip_summaries (FEAT-010 FN-19, migration 1782500000000) ZATEN VAR olan
-- ledger tablosunu genişletir — sıfırdan yeni tablo kurulmaz (duplikasyon engellendi).
-- Köprü: public.tasks.enterprise_dispatch_task_id (migration 1782100000000) üzerinden
-- enterprise.dispatch_tasks.capacity_required/pickup_location/dropoff_location worker
-- tarafından (tripSummaryWorker.js, FN-4) bu yeni kolonlara yazılır.
--
-- gross_revenue_eur: NULLABLE, bu turda HİÇBİR worker tarafından yazılmaz (FEAT-015 /
-- ADR-0011 §6 "customer-funded trigger" kapısını erken açmamak için kasıtlı karar).
-- Sadece şema hazırlığı — ileride FEAT-015 veya bir ücret-girdi ekranı bu alanı UPDATE eder.
--
-- Yeni GRANT gerekmiyor: enterprise_backend rolü migration 1782000000000 ile
-- "GRANT ALL ON ALL TABLES IN SCHEMA enterprise" aldı — tablo-seviyesi grant yeni
-- kolonları otomatik kapsar.

-- Up Migration

ALTER TABLE enterprise.trip_summaries
  ADD COLUMN IF NOT EXISTS cargo_volume_m3    numeric,
  ADD COLUMN IF NOT EXISTS cargo_weight_kg    numeric,
  ADD COLUMN IF NOT EXISTS hazmat_classes     text[],
  ADD COLUMN IF NOT EXISTS pickup_location    jsonb,
  ADD COLUMN IF NOT EXISTS dropoff_location   jsonb,
  ADD COLUMN IF NOT EXISTS gross_revenue_eur  numeric;

COMMENT ON COLUMN enterprise.trip_summaries.cargo_volume_m3 IS
  'FEAT-020 Katman B. dispatch_tasks.capacity_required->volume_m3 uzerinden worker tarafindan yazilir. Kopru yoksa (legacy/non-dispatcher gorev) NULL kalir.';
COMMENT ON COLUMN enterprise.trip_summaries.cargo_weight_kg IS
  'FEAT-020 Katman B. dispatch_tasks.capacity_required->weight_kg uzerinden worker tarafindan yazilir. Kopru yoksa NULL kalir.';
COMMENT ON COLUMN enterprise.trip_summaries.hazmat_classes IS
  'FEAT-020 Katman B. dispatch_tasks.capacity_required->hazmat_classes uzerinden worker tarafindan yazilir. Kopru yoksa NULL kalir.';
COMMENT ON COLUMN enterprise.trip_summaries.pickup_location IS
  'FEAT-020 Katman B. dispatch_tasks.pickup_location kopyasi, worker tarafindan yazilir. Kopru yoksa NULL kalir.';
COMMENT ON COLUMN enterprise.trip_summaries.dropoff_location IS
  'FEAT-020 Katman B. dispatch_tasks.dropoff_location kopyasi, worker tarafindan yazilir. Kopru yoksa NULL kalir.';
COMMENT ON COLUMN enterprise.trip_summaries.gross_revenue_eur IS
  'FEAT-020 Katman B semaa hazirligi (ADR-0011 SS6 / FEAT-015 Phase-2 gate korunuyor). Bu migration ile hicbir worker bu alani YAZMAZ -- her zaman NULL. Ileride FEAT-015 veya bir ucret-girdi ekrani UPDATE ile doldurur.';

\echo '=== enterprise.trip_summaries Katman B kolonlari (cargo_volume_m3, cargo_weight_kg, hazmat_classes, pickup_location, dropoff_location, gross_revenue_eur) eklendi ==='

-- Down Migration

-- ALTER TABLE enterprise.trip_summaries
--   DROP COLUMN IF EXISTS cargo_volume_m3,
--   DROP COLUMN IF EXISTS cargo_weight_kg,
--   DROP COLUMN IF EXISTS hazmat_classes,
--   DROP COLUMN IF EXISTS pickup_location,
--   DROP COLUMN IF EXISTS dropoff_location,
--   DROP COLUMN IF EXISTS gross_revenue_eur;
