-- FEAT-018 Phase 2 — Reverse Logistics Handling, alt-paradigma C (RMA lifecycle).
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §3.2.
--
-- GATEKEEP NOTU (2026-10-13): v1 §6.2'nin orijinal `enterprise.rma_requests`
-- CREATE TABLE'i hicbir repoda/backup'ta bulunamadi (sadece "v1'den degismedi"
-- referansi var, asil tablo kaybolmus). Asagidaki sema, dokumanin baska
-- yerlerine serpistirilmis gercek alan referanslarindan (status state machine
-- §2, audit_log §5.3, return_type/resolution_type/estimated_value_eur FN-16
-- kurali §2) + Cem'in onayladigi temel alanlardan (task_id, requested_at,
-- closed_at) yeniden insa edildi ve Cem tarafindan 2026-10-13'te onaylandi.
--
-- warehouse_id: public.warehouses tablosu henuz yok (Faz 2.5, migration'i
-- yazilmadi) - bu yuzden FK'siz, duz UUID olarak ekleniyor. public.warehouses
-- yazildiginda ayri bir additive migration ile FK constraint eklenecek
-- (spec'in kendi §3.2 tasarimi zaten bu sirayi ongoruyordu).

CREATE TABLE IF NOT EXISTS enterprise.rma_requests (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    task_id              UUID REFERENCES enterprise.dispatch_tasks(id) ON DELETE SET NULL,
    warehouse_id         UUID,  -- FK public.warehouses(id) sonradan eklenecek (Faz 2.5)

    status               TEXT NOT NULL DEFAULT 'rma_requested',
    return_type          TEXT NOT NULL,
    resolution_type      TEXT,
    estimated_value_eur  NUMERIC(10, 2),

    audit_log            JSONB NOT NULL DEFAULT '[]'::jsonb,

    requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at            TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE enterprise.rma_requests
  DROP CONSTRAINT IF EXISTS rma_requests_status_check;
ALTER TABLE enterprise.rma_requests
  ADD CONSTRAINT rma_requests_status_check
  CHECK (status IN (
    'rma_requested', 'approved', 'rejected', 'pickup_scheduled',
    'in_transit', 'warehouse_received', 'refund_issued',
    'replacement_dispatched', 'disposed', 'closed'
  ));

ALTER TABLE enterprise.rma_requests
  DROP CONSTRAINT IF EXISTS rma_requests_return_type_check;
ALTER TABLE enterprise.rma_requests
  ADD CONSTRAINT rma_requests_return_type_check
  CHECK (return_type IN ('damaged_goods', 'customer_initiated', 'wrong_item', 'other'));

ALTER TABLE enterprise.rma_requests
  DROP CONSTRAINT IF EXISTS rma_requests_resolution_type_check;
ALTER TABLE enterprise.rma_requests
  ADD CONSTRAINT rma_requests_resolution_type_check
  CHECK (resolution_type IS NULL OR resolution_type IN ('refund', 'returned_to_inventory', 'replacement', 'disposed'));

CREATE INDEX IF NOT EXISTS idx_rma_requests_company_status
  ON enterprise.rma_requests (company_id, status);

CREATE INDEX IF NOT EXISTS idx_rma_requests_task
  ON enterprise.rma_requests (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rma_requests_warehouse
  ON enterprise.rma_requests (warehouse_id) WHERE warehouse_id IS NOT NULL;

COMMENT ON TABLE enterprise.rma_requests IS
  'FEAT-018 Phase 2 (2026-10-13). RMA lifecycle (alt-paradigma C). v1 §6.2 orijinal semasi kaybolmustu, bu tablo dokumandaki gercek alan referanslarindan yeniden insa edildi (bkz. dosya basindaki gatekeep notu) ve Cem tarafindan onaylandi.';

COMMENT ON COLUMN enterprise.rma_requests.warehouse_id IS
  'FEAT-018 Phase 2 (2026-10-13). FK public.warehouses(id) suan YOK - warehouses tablosu (Faz 2.5) yazildiginda ayri bir additive migration ile FK constraint eklenecek. Simdilik duz UUID.';

COMMENT ON COLUMN enterprise.rma_requests.audit_log IS
  'FEAT-018 Phase 2 (2026-10-13). Append-only (bkz. spec §5.3 appendAuditEntry sozlesmesi) - DB seviyesinde zorlanmiyor, uygulama katmani disiplini.';

-- Sanity check: tablo yeni yaratildiysa 0 satir olmali.
DO $$
DECLARE
  row_count INT;
BEGIN
  SELECT count(*) INTO row_count FROM enterprise.rma_requests;
  RAISE NOTICE 'FEAT-018 Phase 2 migration tamamlandi: enterprise.rma_requests hazir, % satir mevcut', row_count;
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS enterprise.rma_requests;
