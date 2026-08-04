-- FEAT-010 v1.7/v1.8 — ML-analiz veri temeli: dispatcher karar logu
-- Spec: tulipfleet-dispatcher/docs/functions/FEAT-010-automated-exception-handling.md §6.4
-- Karar: normal tablo (hypertable DEĞİL — düşük hacim), retention YOK (#21 ONAYLI)
-- Idempotent: IF NOT EXISTS + additive GRANT

CREATE TABLE IF NOT EXISTS enterprise.dispatch_decision_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL,
  routing_job_id         uuid,
  dispatch_task_id       uuid,
  decided_at             timestamptz NOT NULL DEFAULT now(),
  decided_by             uuid,
  scorer_snapshot        jsonb NOT NULL,
  constraints_snapshot   jsonb,
  recommended_vehicle_id uuid,
  chosen_vehicle_id      uuid,
  is_override            boolean GENERATED ALWAYS AS
                           (recommended_vehicle_id IS DISTINCT FROM chosen_vehicle_id) STORED,
  override_reason        text,
  override_comment       text
);

CREATE INDEX IF NOT EXISTS idx_ddl_company_decided
  ON enterprise.dispatch_decision_log (company_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_ddl_company_override
  ON enterprise.dispatch_decision_log (company_id, is_override) WHERE is_override;

-- Default privileges zaten kapsıyor (1782000000000), açık grant idempotent sigorta:
GRANT ALL ON enterprise.dispatch_decision_log TO enterprise_backend;

\echo '=== enterprise.dispatch_decision_log created ==='
