-- FEAT-017 FN-11 onCustomerLockerDropoff + FN-12 monitorLockerPickupExpiry —
-- enterprise.dispatch_tasks.metadata kolonu.
-- Spec: docs/functions/FEAT-017-locker-pudo-management.md (v1) §5, §6.4.
--
-- Spec §6.4 "mevcut JSONB kolonu, yeni key'ler additive" diyor, ama gercek
-- semada (1778687553584_enterprise-schema-init.sql) boyle bir kolon hic yok
-- -- FN-12'nin sorgusu (t.metadata->>'locker_dropoff_at' vb.) bu kolon
-- olmadan calisamaz. Additive, NOT NULL DEFAULT '{}'::jsonb (mevcut
-- satirlar bos obje alir, eski davranis bozulmaz).

ALTER TABLE enterprise.dispatch_tasks
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN enterprise.dispatch_tasks.metadata IS
  'FEAT-017 FN-11/FN-12 (2026-10-14). Locker teslimat/dropoff payload''i: is_locker_delivery, locker_geofence_id, locker_dropoff_at, pickup_deadline_hours, customer_ref, partner_ref (Phase 2). Additive JSONB, spec sec 6.4.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-017 FN-11/FN-12 migration tamamlandi: dispatch_tasks.metadata eklendi';
END $$;