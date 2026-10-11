-- FEAT-020 Phase 1.1 (Cem, 2026-10-12): public.vehicles kargo kapasite
-- kolonlari — supply-side mirror of enterprise.dispatch_tasks.capacity_required
-- jsonb'nin icerigi (dispatcher src/types/metadata.ts CapacityRequired:
-- volume_m3 / weight_kg / hazmat_classes). Bu olmadan cargoScorer
-- (dispatcher src/services/dispatch/scoring/scorers/cargoScorer.ts) INACTIVE
-- kalir: "arac kapasite ve yuk verisi toplanmaya baslayinca bu siralama
-- aktiflesecek" diyor, cunku eslesecek veri yoktu.
--
-- vehicle_weight_class (migration 1783000000000) ile KARISTIRILMAMALI — o,
-- Vrachtwagenheffing toll tarife kategorisidir (12_18t/18_32t/32_plus_t),
-- kargo tasima kapasitesi degildir. Bu ikisi ayni aracta BAGIMSIZ, farkli
-- amacli kolonlardir.
--
-- Nullable + additive, CHECK ile negatif deger engellenir (yoksa cargoScorer
-- sahte/eksik veriyle uydurma skor uretir — Graceful Degradation ilkesi,
-- ADR-0010 / vehicle_weight_class presedenti). Matching logic (scorer'in bu
-- veriyi gercekten kullanmasi) bu migration'in kapsami DEGIL — ayri, sonraki
-- bir FEAT-020 artimi (spec hala yazilmadi).
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS cargo_capacity_volume_m3 numeric
    CHECK (cargo_capacity_volume_m3 IS NULL OR cargo_capacity_volume_m3 >= 0),
  ADD COLUMN IF NOT EXISTS cargo_capacity_weight_kg numeric
    CHECK (cargo_capacity_weight_kg IS NULL OR cargo_capacity_weight_kg >= 0),
  ADD COLUMN IF NOT EXISTS hazmat_certified_classes text[] NOT NULL DEFAULT '{}';
