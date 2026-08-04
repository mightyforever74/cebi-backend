-- FEAT-010 Pipeline Sprint dilim 1 — enterprise.exception_events (hypertable)
-- Kaynak: spec §6.1 (konsolidasyon 2d04768) + v1.3 enum eklemeleri
-- (driver_offline, driver_location_mismatch). SPEC DÜZELTMESİ: orijinalde çift
-- PK tanımı vardı (id PK + kompozit PK) — TimescaleDB kuralı gereği yalnız
-- kompozit PRIMARY KEY (id, occurred_at) kullanıldı. Idempotent.

CREATE TABLE IF NOT EXISTS enterprise.exception_events (
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    task_id             UUID REFERENCES enterprise.dispatch_tasks(id),
    vehicle_id          UUID REFERENCES public.vehicles(id),
    driver_id           UUID REFERENCES public.drivers(id),
    exception_type      TEXT NOT NULL
                        CHECK (exception_type IN (
                          'eta_delay','traffic_impact','driver_no_show',
                          'driver_offline','driver_location_mismatch',
                          'dock_conflict','compliance_zone_breach',
                          'locker_pickup_expired','tender_withdrawn','tender_no_quotes',
                          'returns_pickup_failed','rts_warehouse_unreachable',
                          'invoice_discrepancy','invoice_audit_deadline_expired',
                          'rest_violation','border_crossing_compliance_breach',
                          'range_anxiety_breach','csrd_data_quality_breach'
                        )),
    severity            TEXT NOT NULL
                        CHECK (severity IN ('low','medium','high','critical')),
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','acknowledged','resolved','auto_handled')),
    detection_payload   JSONB NOT NULL,
    resolution_type     TEXT CHECK (resolution_type IN ('manual','auto')),
    resolution_action   TEXT,
    resolved_at         TIMESTAMPTZ,
    resolved_by         UUID REFERENCES public.users(id),
    resolution_comment  TEXT,
    grace_period_ends_at TIMESTAMPTZ,
    occurred_at         TIMESTAMPTZ NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, occurred_at)
);

SELECT create_hypertable('enterprise.exception_events', 'occurred_at',
                         chunk_time_interval => INTERVAL '7 days',
                         if_not_exists => TRUE);

SELECT add_retention_policy('enterprise.exception_events', INTERVAL '90 days',
                            if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_exception_events_open ON enterprise.exception_events
  (company_id, status, occurred_at DESC) WHERE status IN ('open','acknowledged');
CREATE INDEX IF NOT EXISTS idx_exception_events_task ON enterprise.exception_events
  (task_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_events_dedup ON enterprise.exception_events
  (task_id, exception_type, occurred_at DESC) WHERE status IN ('open','acknowledged');

GRANT ALL ON enterprise.exception_events TO enterprise_backend;

\echo '=== enterprise.exception_events hypertable OK ==='
