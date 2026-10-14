-- FEAT-018 Phase 2.5 — enterprise.customer_feedback (CSAT/şikayet özeti, CRM değil).
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §3.4, §5.2.
--
-- §7 madde 2 kapatıldı (Cem 2026-10-14): FN-18 submitCustomerFeedback auth
-- modeli = Seçenek B — müşteri doğrudan dokunmaz, dispatcher/driver adına
-- girer. Yeni bir public/token auth yüzeyi YOK, mevcut fastify.authenticate +
-- requireRole deseni kullanılır. v1'in "customer-facing return portal UI"
-- Phase 3 kapsam-dışı kararı ihlal edilmiyor.

CREATE TABLE IF NOT EXISTS enterprise.customer_feedback (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

    task_id              UUID REFERENCES enterprise.dispatch_tasks(id),
    rma_request_id       UUID REFERENCES enterprise.rma_requests(id),

    feedback_type        TEXT NOT NULL,
    csat_score           SMALLINT,

    complaint_events     JSONB NOT NULL DEFAULT '[]'::jsonb,
    sla_breach           BOOLEAN NOT NULL DEFAULT false,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE enterprise.customer_feedback
  DROP CONSTRAINT IF EXISTS customer_feedback_feedback_type_check;
ALTER TABLE enterprise.customer_feedback
  ADD CONSTRAINT customer_feedback_feedback_type_check
  CHECK (feedback_type IN ('csat', 'complaint', 'sla_breach_ack'));

ALTER TABLE enterprise.customer_feedback
  DROP CONSTRAINT IF EXISTS customer_feedback_csat_score_check;
ALTER TABLE enterprise.customer_feedback
  ADD CONSTRAINT customer_feedback_csat_score_check
  CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5);

CREATE INDEX IF NOT EXISTS idx_customer_feedback_task
  ON enterprise.customer_feedback (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_feedback_rma
  ON enterprise.customer_feedback (rma_request_id) WHERE rma_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_feedback_breach
  ON enterprise.customer_feedback (company_id, sla_breach) WHERE sla_breach = true;

COMMENT ON TABLE enterprise.customer_feedback IS
  'FEAT-018 Phase 2.5 (2026-10-14). CSAT/şikayet/SLA-ihlali özeti — bilinçli olarak CRM DEĞİL (§5.2). FN-18 girişi dispatcher/driver adına (Cem onayı, §7 madde 2: Seçenek B — müşteri-tarafı yüzey yok).';

DO $$
DECLARE
  row_count INT;
BEGIN
  SELECT count(*) INTO row_count FROM enterprise.customer_feedback;
  RAISE NOTICE 'FEAT-018 Phase 2.5 migration tamamlandi: enterprise.customer_feedback hazir, % satir mevcut', row_count;
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS enterprise.customer_feedback;