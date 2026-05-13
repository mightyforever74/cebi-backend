-- ============================================================================
-- Migration: enterprise schema initialization
-- ADR: 0004 v2 (Database Strategy and Telematics-Agnostic Schema)
-- ADR: 0005   (Dispatch Workflow Maturity Model — state machines)
-- ADR: 0007   (Telematics Integration Strategy)
-- Date:   2026-05-13
-- Author: Cem Bakir
--
-- Scope: Phase 1 schema-only, additive.
--   - Creates `enterprise` schema (separate from `public`).
--   - Creates 4 tables: telematics_source, locations_3p (hypertable),
--                       routing_jobs, dispatch_tasks.
--   - Backfills enterprise.telematics_source with one row per existing
--     vehicle (provider=tulipfleet).
--   - Wires updated_at triggers to the existing update_timestamp() function.
--
-- Safety guarantees:
--   - No modification to existing public.* tables.
--   - No INSERT into TimescaleDB hypertables (locations_3p stays empty).
--   - Backfill targets a non-hypertable (enterprise.telematics_source).
--   - All foreign keys reference public.* with explicit ON DELETE behavior.
--   - State-machine values enforced by CHECK constraints (defense in depth).
--
-- Apply order: staging (fleet_tracking_staging) -> smoke test ->
--              production backup -> production (fleet_tracking).
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS enterprise;

-- ----------------------------------------------------------------------------
-- Table 1: enterprise.telematics_source
-- Registry mapping each vehicle to one or more telematics providers.
-- Phase 1: only provider=tulipfleet rows (created by backfill below).
-- Phase 2+: rows for geotab, verizon, samsara added by customer-funded
--           connector ETL jobs (per ADR-0007).
--
-- provider column is intentionally text (not enum or CHECK constrained) so
-- adding a new provider in Phase 2 does not require a schema migration.
-- Canonical values are documented in ADR-0007:
--   tulipfleet | geotab | verizon | samsara | <future>
-- All values MUST be lowercase. The application layer is the authority on
-- accepted providers and normalizes input before insertion.
-- ----------------------------------------------------------------------------
CREATE TABLE enterprise.telematics_source (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_telematics_source_vehicle
  ON enterprise.telematics_source (vehicle_id, is_active);
CREATE INDEX idx_telematics_source_company_provider
  ON enterprise.telematics_source (company_id, provider);

CREATE TRIGGER trg_telematics_source_updated_at
BEFORE UPDATE ON enterprise.telematics_source
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

COMMENT ON TABLE enterprise.telematics_source IS
  'Strategic registry table (ADR-0007). One row per (vehicle, telematics provider). Phase 1 contains only provider=tulipfleet rows. Phase 2+ adds non-TulipFleet providers, customer-funded only. Canonical provider values: tulipfleet, geotab, verizon, samsara (lowercase, app-layer enforced).';

-- ----------------------------------------------------------------------------
-- Table 2: enterprise.locations_3p (TimescaleDB hypertable)
-- Third-party telemetry feeds, ETL-d from external sources.
-- Phase 1: empty. Phase 2+: populated by connectors.
--
-- PRIMARY KEY (vehicle_id, provider, time) enforces ETL idempotency.
-- Connector workers MUST use INSERT ... ON CONFLICT DO NOTHING to safely
-- retry without duplicate-row errors.
--
-- raw_payload is nullable to accommodate Phase 2+ connectors that produce
-- pre-normalized telemetry and do not retain raw blobs.
-- ----------------------------------------------------------------------------
CREATE TABLE enterprise.locations_3p (
  vehicle_id   uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  time         timestamptz NOT NULL,
  latitude     double precision,
  longitude    double precision,
  speed        double precision,
  heading      double precision,
  raw_payload  jsonb,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  PRIMARY KEY (vehicle_id, provider, time)
);
SELECT create_hypertable('enterprise.locations_3p', 'time');
CREATE INDEX idx_locations_3p_vehicle_time
  ON enterprise.locations_3p (vehicle_id, time DESC);

COMMENT ON TABLE enterprise.locations_3p IS
  'Third-party telemetry hypertable (ADR-0004). Empty in Phase 1. INSERTs only through backend ETL workers per DEMO_OLUSTURMA.md hypertable INSERT rules. PRIMARY KEY (vehicle_id, provider, time) enforces idempotency; use ON CONFLICT DO NOTHING in ETL.';

-- ----------------------------------------------------------------------------
-- Table 3: enterprise.routing_jobs
-- VRP solver submissions (HERE Tour Planning per ADR-0002).
-- Persists request/response for retry, audit, and idempotency.
-- status state machine enforced by CHECK constraint (defense in depth).
-- ----------------------------------------------------------------------------
CREATE TABLE enterprise.routing_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'here',
  provider_job_id  text,
  request_hash     text NOT NULL,
  status           text NOT NULL
                   CHECK (status IN ('submitted', 'running', 'completed', 'failed')),
  request_payload  jsonb NOT NULL,
  response_payload jsonb,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  error_message    text
);
CREATE INDEX idx_routing_jobs_company_status
  ON enterprise.routing_jobs (company_id, status);
CREATE UNIQUE INDEX idx_routing_jobs_request_hash_completed
  ON enterprise.routing_jobs (request_hash)
  WHERE status = 'completed';

COMMENT ON TABLE enterprise.routing_jobs IS
  'HERE Tour Planning submission log (ADR-0002). Idempotency via request_hash unique index on completed jobs. State machine: submitted -> running -> completed | failed.';

-- ----------------------------------------------------------------------------
-- Table 4: enterprise.dispatch_tasks
-- Dispatcher-facing task state machine.
-- Distinct from public.tasks (driver-facing) per ADR-0004 Section 3.5.
-- status state machine enforced by CHECK constraint (defense in depth).
-- ----------------------------------------------------------------------------
CREATE TABLE enterprise.dispatch_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  status              text NOT NULL
                      CHECK (status IN ('draft', 'planned', 'assigned',
                                        'in_progress', 'completed',
                                        'failed', 'cancelled')),
  assigned_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  assigned_driver_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  pickup_location     jsonb NOT NULL,
  dropoff_location    jsonb NOT NULL,
  time_window_start   timestamptz,
  time_window_end     timestamptz,
  capacity_required   jsonb,
  skill_required      text[],
  routing_job_id      uuid REFERENCES enterprise.routing_jobs(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dispatch_tasks_company_status
  ON enterprise.dispatch_tasks (company_id, status);
CREATE INDEX idx_dispatch_tasks_vehicle_status
  ON enterprise.dispatch_tasks (assigned_vehicle_id, status);

CREATE TRIGGER trg_dispatch_tasks_updated_at
BEFORE UPDATE ON enterprise.dispatch_tasks
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

COMMENT ON TABLE enterprise.dispatch_tasks IS
  'Dispatcher-facing task model (ADR-0004 Section 3.5, ADR-0005). Separate from public.tasks (driver-facing). State machine: draft -> planned -> assigned -> in_progress -> completed | failed | cancelled. A dispatch task may produce 0, 1, or many driver tasks over its lifetime.';

-- ----------------------------------------------------------------------------
-- Backfill: one row in enterprise.telematics_source per existing vehicle.
-- All rows get provider=tulipfleet.
-- The config jsonb embeds the primary device reference where one exists.
-- Vehicles without any device row still get a telematics_source row with
-- config = {} so dispatcher logic always has a registry entry to consult.
--
-- The LATERAL subquery picks the most relevant device per vehicle by
-- preferring ACTIVATED > active > ASSIGNED > other statuses, then newest.
-- ----------------------------------------------------------------------------
INSERT INTO enterprise.telematics_source (vehicle_id, company_id, provider, config)
SELECT
  v.id,
  v.company_id,
  'tulipfleet',
  CASE
    WHEN d.id IS NOT NULL THEN
      jsonb_build_object(
        'device_id',     d.id,
        'device_serial', d.serial,
        'device_code',   d.device_code,
        'esp_chip_id',   d.esp_chip_id
      )
    ELSE '{}'::jsonb
  END
FROM public.vehicles v
LEFT JOIN LATERAL (
  SELECT id, serial, device_code, esp_chip_id
  FROM public.devices
  WHERE devices.vehicle_id = v.id
  ORDER BY
    CASE status
      WHEN 'ACTIVATED' THEN 1
      WHEN 'active'    THEN 2
      WHEN 'ASSIGNED'  THEN 3
      ELSE 4
    END,
    created_at DESC
  LIMIT 1
) d ON true
WHERE v.company_id IS NOT NULL;


-- Down Migration

-- Reverse order: drop dependent tables first, then schema.
-- CASCADE on schema drop handles any objects we forgot.
DROP TRIGGER IF EXISTS trg_dispatch_tasks_updated_at ON enterprise.dispatch_tasks;
DROP TABLE IF EXISTS enterprise.dispatch_tasks;
DROP TABLE IF EXISTS enterprise.routing_jobs;
DROP TABLE IF EXISTS enterprise.locations_3p;
DROP TRIGGER IF EXISTS trg_telematics_source_updated_at ON enterprise.telematics_source;
DROP TABLE IF EXISTS enterprise.telematics_source;
DROP SCHEMA IF EXISTS enterprise CASCADE;
