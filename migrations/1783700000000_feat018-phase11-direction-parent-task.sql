-- FEAT-018 Phase 1.1 — Reverse Logistics Handling, alt-paradigma A/B temel semasi.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §3.1.
--
-- Additive, geriye donuk uyumlu (ADR-0004 v3 §6): mevcut tum enterprise.dispatch_tasks
-- satirlari otomatik direction='outbound' alir, eski davranis bozulmaz.
--
-- direction + parent_task_id, A (customer pickup return) ve B (failed delivery
-- RTS) alt-paradigmalarinin temelini olusturur. FN-01 createReturnTask,
-- FN-02 linkParentTask bu kolonlari kullanir. C (RMA lifecycle, enterprise.rma_requests)
-- ayri bir migration'dir (bu dosyanin kapsami disinda).

ALTER TABLE enterprise.dispatch_tasks
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';

ALTER TABLE enterprise.dispatch_tasks
  DROP CONSTRAINT IF EXISTS dispatch_tasks_direction_check;

ALTER TABLE enterprise.dispatch_tasks
  ADD CONSTRAINT dispatch_tasks_direction_check
  CHECK (direction IN ('outbound', 'inbound'));

ALTER TABLE enterprise.dispatch_tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID
  REFERENCES enterprise.dispatch_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_direction
  ON enterprise.dispatch_tasks (company_id, direction)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_parent
  ON enterprise.dispatch_tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

COMMENT ON COLUMN enterprise.dispatch_tasks.direction IS
  'FEAT-018 Phase 1.1 (2026-10-13). outbound = normal teslimat (varsayilan, geriye donuk uyumlu). inbound = iade/geri alim task''i (alt-paradigma A: customer pickup, alt-paradigma B: failed-delivery RTS).';

COMMENT ON COLUMN enterprise.dispatch_tasks.parent_task_id IS
  'FEAT-018 Phase 1.1 (2026-10-13). inbound task''in hangi orijinal outbound task''a bagli oldugu (RTS/RMA baglaminda). NULL olabilir (bagimsiz/customer-manuel return). Self-referencing FK, ON DELETE SET NULL.';

-- Sanity check: migration sonrasi tum mevcut satirlar direction='outbound',
-- parent_task_id NULL olmali (additive, hicbir mevcut satir degismemeli).
DO $$
DECLARE
  non_outbound_count INT;
  non_null_parent_count INT;
BEGIN
  SELECT count(*) INTO non_outbound_count
    FROM enterprise.dispatch_tasks WHERE direction <> 'outbound';
  SELECT count(*) INTO non_null_parent_count
    FROM enterprise.dispatch_tasks WHERE parent_task_id IS NOT NULL;

  IF non_outbound_count > 0 THEN
    RAISE WARNING 'FEAT-018 Phase 1.1: % mevcut satir direction<>outbound (beklenmiyordu, kontrol et)', non_outbound_count;
  END IF;
  IF non_null_parent_count > 0 THEN
    RAISE WARNING 'FEAT-018 Phase 1.1: % mevcut satirda parent_task_id dolu (beklenmiyordu, kontrol et)', non_null_parent_count;
  END IF;

  RAISE NOTICE 'FEAT-018 Phase 1.1 migration tamamlandi: direction + parent_task_id additive, % satir dogrulandi', non_outbound_count + non_null_parent_count;
END $$;

-- Down migration (elle calistirilmali, node-pg-migrate'in otomatik down'ina guvenilmiyor):
-- DROP INDEX IF EXISTS enterprise.idx_dispatch_tasks_parent;
-- DROP INDEX IF EXISTS enterprise.idx_dispatch_tasks_direction;
-- ALTER TABLE enterprise.dispatch_tasks DROP COLUMN IF EXISTS parent_task_id;
-- ALTER TABLE enterprise.dispatch_tasks DROP COLUMN IF EXISTS direction;
