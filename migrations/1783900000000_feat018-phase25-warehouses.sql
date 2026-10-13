-- FEAT-018 Phase 2.5 — public.warehouses (depo hiyerarşisi, self-referencing, additive).
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §3.3.
--
-- Şema-yeri kararı (§7 madde 1): public şeması — Cem 2026-10-14'te onayladı.
-- Gerekçe (spec'in kendi notu): warehouses fiziksel bir tesis kaydı,
-- public.companies/public.vehicles gibi telematics-agnostic çekirdek veri,
-- sadece dispatcher'a özel değil (ileride mobil app "en yakın depo" için
-- erişebilir).
--
-- Tek-depo şirketler için nötr: warehouse_type='central', parent_warehouse_id
-- NULL ile tek satır yeterli, hiyerarşi zorunlu değil.

CREATE TABLE IF NOT EXISTS public.warehouses (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

    name                 TEXT NOT NULL,
    warehouse_type       TEXT NOT NULL DEFAULT 'central',
    parent_warehouse_id  UUID REFERENCES public.warehouses(id) ON DELETE SET NULL,

    address              TEXT,
    latitude             DOUBLE PRECISION,
    longitude            DOUBLE PRECISION,
    geofence_id          UUID REFERENCES public.geofences(id),

    is_active            BOOLEAN NOT NULL DEFAULT true,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.warehouses
  DROP CONSTRAINT IF EXISTS warehouses_warehouse_type_check;
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_warehouse_type_check
  CHECK (warehouse_type IN ('central', 'cross_dock_hub', 'partner'));

CREATE INDEX IF NOT EXISTS idx_warehouses_company
  ON public.warehouses (company_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_warehouses_parent
  ON public.warehouses (parent_warehouse_id) WHERE parent_warehouse_id IS NOT NULL;

COMMENT ON TABLE public.warehouses IS
  'FEAT-018 Phase 2.5 (2026-10-14). Depo hiyerarşisi, public şeması (Cem onayı, §7 madde 1 kapatıldı) — telematics-agnostic çekirdek tesis verisi.';

DO $$
DECLARE
  row_count INT;
BEGIN
  SELECT count(*) INTO row_count FROM public.warehouses;
  RAISE NOTICE 'FEAT-018 Phase 2.5 migration tamamlandi: public.warehouses hazir, % satir mevcut', row_count;
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS public.warehouses;