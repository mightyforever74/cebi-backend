-- FEAT-018 FN-18 submitCustomerFeedback + FN-19 evaluateSlaBreach — enterprise.customer_feedback.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §5.2.
--
-- GATEKEEPING NOTU (2026-10-14): Bu tablonun da (warehouses gibi) hiçbir
-- migration taslağı bulunamadı — staging'de elle oluşturulmuş. Şema,
-- staging'deki gerçek `\d enterprise.customer_feedback` çıktısına ve
-- lib/submitCustomerFeedback.js'in gerçek kullandığı kolonlara (company_id,
-- task_id, rma_request_id, feedback_type, csat_score, complaint_events)
-- birebir göre yazıldı. `sla_breach` kolonu FN-19 evaluateSlaBreach
-- (henüz kodlanmadı) için önceden var — additive, varsayılan false.
--
-- `enterprise.customer_feedback` bir CRM değil (spec §5.2) — CSAT puanı,
-- şikayet metni ve SLA ihlali bayrağının minimal özeti.

CREATE TABLE IF NOT EXISTS enterprise.customer_feedback (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    task_id          UUID REFERENCES enterprise.dispatch_tasks(id),
    rma_request_id   UUID REFERENCES enterprise.rma_requests(id),
    feedback_type    TEXT NOT NULL,
    csat_score       SMALLINT,
    complaint_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    sla_breach       BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  CHECK (csat_score IS NULL OR (csat_score >= 1 AND csat_score <= 5));

CREATE INDEX IF NOT EXISTS idx_customer_feedback_task
  ON enterprise.customer_feedback (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_feedback_rma
  ON enterprise.customer_feedback (rma_request_id) WHERE rma_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_feedback_breach
  ON enterprise.customer_feedback (company_id, sla_breach) WHERE sla_breach = true;

COMMENT ON TABLE enterprise.customer_feedback IS
  'FEAT-018 FN-18/FN-19 (2026-10-14). Minimal CSAT/şikayet/SLA-ihlali özeti — bir CRM değil (spec §5.2). Staging''de elle oluşturulmuştu, bu dosya prod + repo kaydı için.';

DO $$
DECLARE
  row_count INT;
BEGIN
  SELECT count(*) INTO row_count FROM enterprise.customer_feedback;
  RAISE NOTICE 'FEAT-018 FN-18 migration tamamlandi: enterprise.customer_feedback hazir, % satir mevcut', row_count;
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS enterprise.customer_feedback;