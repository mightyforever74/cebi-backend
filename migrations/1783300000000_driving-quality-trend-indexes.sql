-- =============================================================================
-- §5 Reports — Driving Quality Trend (compare_with_previous)
-- Migration: 1783300000000_driving-quality-trend-indexes
-- 11 Ekim 2026 — Cem'in tenkiti: GET /api/reports/drivers/performance artık
--   compare_with_previous=true ile AYNI sorguyu (routes/reportsDrivingQuality
--   Helpers.js: fetchDriverPerformanceRows) iki kez çalıştırabiliyor (güncel
--   + önceki dönem). Bu dosyadan önce repo'da bu tabloların oluşturulduğu bir
--   migration YOK (alerts/tasks/drivers canlı DB'de migration dışı
--   oluşturulmuş) — bu yüzden mevcut index durumu bu oturumdan DOĞRULANAMADI
--   (DB erişimi yok). Bu migration o yüzden KOŞULSUZ ve İDEMPOTENT
--   (IF NOT EXISTS) — zaten varsa no-op, yoksa ekler.
--
-- Hedeflenen filtre kolonları (fetchDriverPerformanceRows'daki JOIN/WHERE'den):
--   tasks:  driver_id = ... AND created_at >= $2 AND created_at < $3
--   alerts: vehicle_id = ... AND created_at >= ... AND created_at <= ...
--
-- NOT (Cem için): `alerts` bir TimescaleDB hipertablosu (bkz.
--   reconcileBatch.js "alerts hipertablosuna yazar" yorumu). Düz
--   CREATE INDEX IF NOT EXISTS hipertablolarda çalışır (Timescale yeni/
--   mevcut tüm chunk'lara otomatik yayar) ama satır sayısı büyükse kısa bir
--   yazma kilidi alır. Prod'da trafiğin yoğun olduğu bir saatte çalıştırmak
--   istemiyorsan, bu dosyayı BEGIN/COMMIT içinde çalıştırmak YERİNE, psql'de
--   tek tek ve CONCURRENTLY ile uygula (CONCURRENTLY bir transaction bloğu
--   içinde ÇALIŞMAZ, o yüzden bu .sql dosyasını olduğu gibi değil, aşağıdaki
--   iki satırı ayrı ayrı elle çalıştır):
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_driver_created_at ON public.tasks (driver_id, created_at);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_vehicle_created_at ON public.alerts (vehicle_id, created_at);
--   Düşük trafikli bir pencerede (örn. gece) ya da tablo küçükse, bu dosyayı
--   olduğu gibi (BEGIN/COMMIT, kısa kilitli) çalıştırmak da güvenli.
-- =============================================================================
BEGIN;

CREATE INDEX IF NOT EXISTS idx_tasks_driver_created_at
  ON public.tasks (driver_id, created_at);

CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_created_at
  ON public.alerts (vehicle_id, created_at);

COMMIT;