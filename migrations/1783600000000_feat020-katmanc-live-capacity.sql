-- FEAT-020 Phase 1.3b — Katman C (surucu canli kapasite bildirimi +
-- configurable toggle), backend dilimi, Cem onayli 2026-10-13.
-- Spec: tulipfleet-dispatcher/docs/functions/FEAT-020-capacity-aware-delivery-promising.md §6.
--
-- Bu turun kapsami: migration + backend endpoint + dispatcher cargoScorer
-- entegrasyonu. Argon mobil ekrani (surucu girdi UI'si) sonraki bir tura
-- birakildi — bu kolonlar o gelene kadar hep NULL kalir, graceful
-- degradation ile cargoScorer bloke olmaz (Katman A FN-1 fallback'i
-- degismedi).
--
-- 1) public.companies.cargo_capacity_tracking — ADR-0004 v3 §6.3
-- dispatch_mode kolonuyla AYNI desen (migration 1778950000001). Sirket
-- IoT/dijital olgunluk seviyesine gore kapasite takibini zorunlu/
-- opsiyonel/kapali yapabilir.
--
-- 2) public.vehicles canli kapasite kolonlari — Phase 1.1'in statik
-- cargo_capacity_volume_m3/weight_kg kolonlarindan (migration
-- 1783400000000, aracin TOPLAM/MAX kapasitesi, admin girer) AYRI: bu
-- suruculerin HER SEFER raporunda degisebilen, o anki BOS kapasitesi.
-- hazmat_certified_classes bu kapsamin disinda (hep statik kalir, surucu
-- sertifika bildirmiyor).
--
-- Tasarim karari (Cem onayli, "tek veritabani/ayni satir" ilkesi):
-- canli kapasite de statik kapasite gibi public.vehicles'ta ayni satirda
-- tutulur (ayri bir tablo/row yok) — hem mobil (core backend PATCH
-- endpoint'i) hem dispatcher (enterprise-backend /api/dispatcher/vehicles
-- SELECT'i, FN-3 acik maddesiyle birlikte kapatilacak) ayni satiri okur/
-- yazar, cift basli yonetim olusmaz.
--
-- Staleness (canli veri "bayatlamasi") bu migration'in kapsami DEGIL —
-- live_cargo_reported_at kaydedilir ama henuz hicbir yerde yas kontrolu
-- yapilmiyor; Cem'in talebi uzerine acik birakildi, ileride ayri bir karar.

-- Up Migration

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS cargo_capacity_tracking text NOT NULL DEFAULT 'optional';

ALTER TABLE public.companies
  ADD CONSTRAINT companies_cargo_capacity_tracking_check
  CHECK (cargo_capacity_tracking IN ('required', 'optional', 'off'));

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS live_cargo_volume_m3 numeric,
  ADD COLUMN IF NOT EXISTS live_cargo_weight_kg numeric,
  ADD COLUMN IF NOT EXISTS live_cargo_reported_at timestamptz;

ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_live_cargo_volume_m3_check
  CHECK (live_cargo_volume_m3 IS NULL OR live_cargo_volume_m3 >= 0);

ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_live_cargo_weight_kg_check
  CHECK (live_cargo_weight_kg IS NULL OR live_cargo_weight_kg >= 0);

COMMENT ON COLUMN public.companies.cargo_capacity_tracking IS
  'FEAT-020 Katman C (Phase 1.3b): required|optional|off. off ise canli kapasite dispatcher''da hic kullanilmaz (statik kolonlara geri doner).';
COMMENT ON COLUMN public.vehicles.live_cargo_volume_m3 IS
  'FEAT-020 Katman C: suruculerin mobilden bildirdigi anlik bos hacim (m3). NULL = hic rapor edilmedi.';
COMMENT ON COLUMN public.vehicles.live_cargo_weight_kg IS
  'FEAT-020 Katman C: suruculerin mobilden bildirdigi anlik bos agirlik (kg). NULL = hic rapor edilmedi.';
COMMENT ON COLUMN public.vehicles.live_cargo_reported_at IS
  'FEAT-020 Katman C: son canli kapasite raporunun zamani. NULL = hic rapor edilmedi. Staleness kontrolu henuz yok.';

-- Sanity check

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'companies'
      AND column_name = 'cargo_capacity_tracking'
  ) THEN
    RAISE EXCEPTION 'cargo_capacity_tracking column not added to public.companies';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.companies'::regclass
      AND conname = 'companies_cargo_capacity_tracking_check'
  ) THEN
    RAISE EXCEPTION 'companies_cargo_capacity_tracking_check constraint not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vehicles'
      AND column_name IN ('live_cargo_volume_m3', 'live_cargo_weight_kg', 'live_cargo_reported_at')
    HAVING COUNT(*) = 3
  ) THEN
    RAISE EXCEPTION 'live cargo columns not fully added to public.vehicles';
  END IF;
END $$;

\echo '=== FEAT-020 Katman C (Phase 1.3b) kolonlari eklendi: companies.cargo_capacity_tracking, vehicles.live_cargo_volume_m3/weight_kg/reported_at ==='

-- Down Migration
-- ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_live_cargo_volume_m3_check;
-- ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_live_cargo_weight_kg_check;
-- ALTER TABLE public.vehicles DROP COLUMN IF EXISTS live_cargo_volume_m3;
-- ALTER TABLE public.vehicles DROP COLUMN IF EXISTS live_cargo_weight_kg;
-- ALTER TABLE public.vehicles DROP COLUMN IF EXISTS live_cargo_reported_at;
-- ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_cargo_capacity_tracking_check;
-- ALTER TABLE public.companies DROP COLUMN IF EXISTS cargo_capacity_tracking;
