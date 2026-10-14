-- FEAT-017 Phase 1.1 — geofences.location_type CHECK genisletme.
-- Spec: docs/functions/FEAT-017-locker-pudo-management.md (v1) §1.5, §6.1.
--
-- FEAT-018'in 1784200000000_feat018-locker-fallback-borrow.sql migration'inda
-- birakilan soz tutuluyor: o migration'in kendi yorumu su sekildeydi:
--   "FEAT-017'nin kendi §6.1'i location_type'a FEAT-019/FEAT-103'un de
--    degerlerini ekliyor... FEAT-017 gercekten kodlandiginda CHECK
--    constraint'i kendi tam listesiyle genisletecek."
-- Bu migration o genisletmeyi yapiyor. Additive, geriye donuk uyumlu: mevcut
-- 'customer_site'/'locker' degerleri yeni listenin alt kumesi, hicbir
-- satir degismez.

ALTER TABLE public.geofences
  DROP CONSTRAINT IF EXISTS geofences_location_type_check;
ALTER TABLE public.geofences
  ADD CONSTRAINT geofences_location_type_check
  CHECK (location_type IN ('customer_site', 'locker', 'pudo', 'parcel_shop', 'return_point'));

COMMENT ON COLUMN public.geofences.location_type IS
  'FEAT-017 Phase 1.1 (2026-10-14). FEAT-018 FN-06/FN-08''in biraktigi geciciyi genisletiyor. Tam liste: customer_site/locker/pudo/parcel_shop/return_point. FN-01 findNearbyLockers, location_type != ''customer_site'' olanlari tarar.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-017 Phase 1.1 migration tamamlandi: geofences.location_type_check genisletildi (locker/pudo/parcel_shop/return_point eklendi)';
END $$;

-- Down migration (elle calistirilmali — DIKKAT: mevcut genisletilmis
-- degerleri kullanan satirlar varsa bu rollback onlari bozar):
-- ALTER TABLE public.geofences DROP CONSTRAINT IF EXISTS geofences_location_type_check;
-- ALTER TABLE public.geofences ADD CONSTRAINT geofences_location_type_check
--   CHECK (location_type IN ('customer_site', 'locker'));