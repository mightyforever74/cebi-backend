-- FEAT-017 FN-04 updateGeofenceLocationType — partner_provider kolonu.
-- Spec: docs/functions/FEAT-017-locker-pudo-management.md (v1) §2, §6.2.
--
-- Spec §6.2: "Partner API entegrasyonu Phase 2'de aktive edildiğinde gerekir.
-- Schema şimdi eklenir, forward-compatible." FN-04'ün kendisi Phase 1.1
-- fonksiyonu ve input'u olarak `provider?` (opsiyonel) alıyor — bu kolon
-- olmadan o parametreyi hiçbir yere yazamaz. Additive, nullable, geriye
-- dönük uyumlu (ADR-0004 v3 §6).

ALTER TABLE public.geofences
  ADD COLUMN IF NOT EXISTS partner_provider TEXT;

COMMENT ON COLUMN public.geofences.partner_provider IS
  'FEAT-017 FN-04 (2026-10-14). Partner locker saglayicisi (postnl/bpost/amazon), Phase 2 entegrasyonu icin. NULL = TulipFleet kendi (partner yok). Schema simdi eklendi, aktivasyon Phase 2''de.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-017 FN-04 migration tamamlandi: geofences.partner_provider eklendi';
END $$;