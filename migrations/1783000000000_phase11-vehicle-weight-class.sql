-- Phase 1.1 ilk adim (04.08.2026): public.vehicles.vehicle_weight_class
-- Vrachtwagenheffing tarife eslemesi icin (enterprise.nl_vrachtwagenheffing_tariffs
-- deger kumesi kanitli: 12_18t / 18_32t / 32_plus_t). Nullable + CHECK —
-- veri yoksa calculateHeffing durustce matched:false doner, sahte hesap yok.
-- Staging'e 04.08 elle uygulandi (bu dosya kayit+prod aynasi icindir).
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS vehicle_weight_class text
  CHECK (vehicle_weight_class IN ('12_18t','18_32t','32_plus_t') OR vehicle_weight_class IS NULL);
