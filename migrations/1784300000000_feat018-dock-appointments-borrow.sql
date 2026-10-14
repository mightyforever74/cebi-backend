-- FEAT-018 FN-09 processCustomerPickupWindow — FEAT-006'dan odunc alinan sema.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §1.3, §8
--       (FN-09 processCustomerPickupWindow, alt-paradigma A: customer pickup).
-- Kaynak: docs/functions/FEAT-006-automated-appointment-scheduling.md §8.1.
--
-- Cem 2026-10-14: FEAT-006'nin henuz kodlanmamis gercek semasindan
-- enterprise.dock_appointments'i oldugu gibi aliyoruz — sadece facility_id'nin
-- FK'si, enterprise.facility_metadata henuz var olmadigi icin simdilik
-- KALDIRILDI (FK-deferral paterni, warehouse_id ile ayni mantik). FEAT-006
-- gercekten kodlandiginda facility_metadata tablosu + bu FK ayri bir additive
-- migration'la baglanacak.
--
-- FN-09 kullanimi: musteri-adresi pickup senaryosunda (alt-paradigma A)
-- facility_id ve dock_number hep NULL kalir (zaten nullable) — appointment bir
-- tesis degil, musteri adresi icin.

CREATE TABLE IF NOT EXISTS enterprise.dock_appointments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dispatch_task_id    UUID NOT NULL REFERENCES enterprise.dispatch_tasks(id) ON DELETE CASCADE,
  facility_id         UUID,  -- FK-deferral: enterprise.facility_metadata henuz yok (Cem onayi 2026-10-14)
  dock_number         TEXT,
  appointment_start   TIMESTAMPTZ NOT NULL,
  appointment_end     TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  source              TEXT NOT NULL DEFAULT 'manual',
  source_metadata     JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE enterprise.dock_appointments
  DROP CONSTRAINT IF EXISTS dock_appointments_status_check;
ALTER TABLE enterprise.dock_appointments
  ADD CONSTRAINT dock_appointments_status_check
  CHECK (status IN ('pending', 'confirmed', 'arrived', 'completed', 'no_show', 'cancelled'));

ALTER TABLE enterprise.dock_appointments
  DROP CONSTRAINT IF EXISTS dock_appointments_source_check;
ALTER TABLE enterprise.dock_appointments
  ADD CONSTRAINT dock_appointments_source_check
  CHECK (source IN ('manual', 'ai_parsed', 'wms_auto'));

ALTER TABLE enterprise.dock_appointments
  DROP CONSTRAINT IF EXISTS dock_appointments_window_check;
ALTER TABLE enterprise.dock_appointments
  ADD CONSTRAINT dock_appointments_window_check
  CHECK (appointment_end > appointment_start);

CREATE INDEX IF NOT EXISTS idx_dock_appointments_task
  ON enterprise.dock_appointments (dispatch_task_id);
CREATE INDEX IF NOT EXISTS idx_dock_appointments_facility
  ON enterprise.dock_appointments (facility_id, appointment_start);
CREATE INDEX IF NOT EXISTS idx_dock_appointments_company
  ON enterprise.dock_appointments (company_id, status);

COMMENT ON COLUMN enterprise.dock_appointments.facility_id IS
  'FEAT-018 FN-09 (2026-10-14). FEAT-006 semasindan odunc alindi (Cem onayi) — FK KASITLI OLARAK EKSIK, enterprise.facility_metadata henuz yok. FEAT-006 kodlandiginda REFERENCES enterprise.facility_metadata(id) ayri migration ile baglanacak. Musteri-adresi pickup senaryosunda (FN-09) hep NULL.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-018 FN-09 migration tamamlandi: enterprise.dock_appointments olusturuldu (facility_id FK-deferred)';
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS enterprise.dock_appointments;