-- FEAT-018 FN-06/FN-08 — FEAT-017'den ödünç alınan şema parçaları.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §1.3, §8
--       (FN-06 triggerReturnToSender, FN-08 resolveRtsDestination).
-- Kaynak: docs/functions/FEAT-017-locker-pudo-management.md §6.1, §UNCERTAINTIES.
--
-- Cem 2026-10-14: FEAT-017'nin henüz kodlanmamış gerçek şemasından, sadece
-- FN-06/FN-08'in ihtiyacı kadarını ödünç alıyoruz — sıfırdan icat DEĞİL.
-- FEAT-017 tam kodlandığında bu CHECK constraint'i genişletecek (ADR-0004 v3
-- §6 additive pattern) — DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT paterni
-- bu genişlemeyi çakışmasız yapar.
--
-- Not: FEAT-017'nin kendi §6.1'i location_type'a FEAT-019/FEAT-103'ün de
-- değerlerini ekliyor (truck_parking, charging_station, vb.) — onlar bu
-- FEAT-018 kapsamının dışında, burada eklenmiyor. FEAT-017 gerçekten
-- kodlandığında CHECK constraint'i kendi tam listesiyle genişletecek.

ALTER TABLE public.geofences
  ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'customer_site';

ALTER TABLE public.geofences
  DROP CONSTRAINT IF EXISTS geofences_location_type_check;
ALTER TABLE public.geofences
  ADD CONSTRAINT geofences_location_type_check
  CHECK (location_type IN ('customer_site', 'locker'));

CREATE INDEX IF NOT EXISTS idx_geofences_location_type
  ON public.geofences (company_id, location_type)
  WHERE location_type != 'customer_site';

ALTER TABLE enterprise.dispatch_tasks
  ADD COLUMN IF NOT EXISTS allow_locker_fallback BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.geofences.location_type IS
  'FEAT-018 FN-06/FN-08 (2026-10-14). FEAT-017''in henüz kodlanmamış şemasından ödünç alındı (Cem onayı) — sadece ''customer_site''/''locker''. FEAT-017 kodlandığında CHECK genişleyecek.';
COMMENT ON COLUMN enterprise.dispatch_tasks.allow_locker_fallback IS
  'FEAT-018 FN-08 (2026-10-14). RTS akisinda locker fallback secenegi gorev bazinda acik mi - FEAT-017''den odunc.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-018 FN-06/FN-08 migration tamamlandi: geofences.location_type + dispatch_tasks.allow_locker_fallback eklendi';
END $$;

-- Down migration (elle calistirilmali):
-- ALTER TABLE public.geofences DROP CONSTRAINT IF EXISTS geofences_location_type_check;
-- ALTER TABLE public.geofences DROP COLUMN IF EXISTS location_type;
-- ALTER TABLE enterprise.dispatch_tasks DROP COLUMN IF EXISTS allow_locker_fallback;