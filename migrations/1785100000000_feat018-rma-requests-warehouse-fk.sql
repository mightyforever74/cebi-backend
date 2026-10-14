-- FEAT-018 Phase 2.5 — enterprise.rma_requests.warehouse_id'ye public.warehouses FK'si.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §3.2.
--
-- 1783800000000_feat018-phase2-rma-requests.sql'in kendi yorumu bu adımı
-- önceden planlamıştı: "public.warehouses yazıldığında ayrı bir additive
-- migration ile FK constraint eklenecek." public.warehouses artık var
-- (1784900000000_feat018-fn17-warehouses.sql, prod'a uygulandı 2026-10-14) —
-- bu migration o sözü tutuyor. Additive, nullable kolon zaten var,
-- sadece FK constraint ekleniyor; mevcut satırlar (hepsi NULL) etkilenmez.

ALTER TABLE enterprise.rma_requests
  DROP CONSTRAINT IF EXISTS rma_requests_warehouse_id_fkey;
ALTER TABLE enterprise.rma_requests
  ADD CONSTRAINT rma_requests_warehouse_id_fkey
  FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);

COMMENT ON COLUMN enterprise.rma_requests.warehouse_id IS
  'FEAT-018 Phase 2 (2026-10-13), FK eklendi Faz 2.5 (2026-10-14): public.warehouses(id). syncWarehouseReturn (FN-14) opsiyonel olarak set eder.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-018 Phase 2.5 migration tamamlandi: rma_requests.warehouse_id -> public.warehouses FK eklendi';
END $$;

-- Down migration (elle calistirilmali):
-- ALTER TABLE enterprise.rma_requests DROP CONSTRAINT IF EXISTS rma_requests_warehouse_id_fkey;