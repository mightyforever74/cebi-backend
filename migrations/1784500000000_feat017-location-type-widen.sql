-- FEAT-017 Phase 1.1 -- geofences.location_type kolonu + CHECK genisletme.
-- Spec: docs/functions/FEAT-017-locker-pudo-management.md (v1) Sec 1.5, Sec 6.1.
--
-- DUZELTME (2026-10-14, PROD apply denemesi sonrasi): bu migration'in ilk
-- hali location_type kolonunun zaten var oldugunu varsayiyordu (sadece
-- CHECK'i genisletiyordu). Staging'de dogruydu (kolon elle eklenmisti,
-- referans migration 1784200000000_feat018-locker-fallback-borrow.sql hic
-- bulunamadi -- muhtemelen hic yazilmadan dogrudan calistirildi). PROD'da
-- ise kolon hic yoktu -- ilk apply denemesi "column location_type does not
-- exist" hatasi verdi. Bu duzeltilmis surum kolonu + indeksi de (staging'deki
-- gercek \d public.geofences cikisina birebir gore) olusturuyor, boylece
-- hem staging'de (idempotent no-op) hem PROD'da (gercek olusturma) guvenle
-- calisir.

ALTER TABLE public.geofences
  ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'customer_site';

CREATE INDEX IF NOT EXISTS idx_geofences_location_type
  ON public.geofences (company_id, location_type)
  WHERE location_type <> 'customer_site';

ALTER TABLE public.geofences
  DROP CONSTRAINT IF EXISTS geofences_location_type_check;
ALTER TABLE public.geofences
  ADD CONSTRAINT geofences_location_type_check
  CHECK (location_type IN ('customer_site', 'locker', 'pudo', 'parcel_shop', 'return_point'));

COMMENT ON COLUMN public.geofences.location_type IS
  'FEAT-017 Phase 1.1 (2026-10-14). Tam liste: customer_site/locker/pudo/parcel_shop/return_point. FN-01 findNearbyLockers, location_type != ''customer_site'' olanlari tarar.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-017 Phase 1.1 migration tamamlandi: geofences.location_type (kolon+index+check) hazir';
END $$;

-- Down migration (elle calistirilmali -- DIKKAT: genisletilmis degerleri
-- kullanan satirlar varsa rollback onlari bozar):
-- ALTER TABLE public.geofences DROP CONSTRAINT IF EXISTS geofences_location_type_check;
-- DROP INDEX IF EXISTS public.idx_geofences_location_type;
-- ALTER TABLE public.geofences DROP COLUMN IF EXISTS location_type;