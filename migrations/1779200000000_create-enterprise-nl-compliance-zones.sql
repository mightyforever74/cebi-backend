-- Migration: 1779200000000_create-enterprise-nl-compliance-zones
-- Purpose : Create enterprise.nl_compliance_zones table for NL ZE-Zones and related
--           compliance polygons (per ADR-0012 §5).
-- Phase   : 1 — Internal use only (manual seed).
-- Authors : Cem Bakir
-- Related : ADR-0012 (NL Compliance Layer Strategy)
--           ADR-0004 v3 (schema authority — tulipfleet-backend)
--           ADR-0009 §4.5 (Compliance Engine inheritance)
-- Depends : 1778687553584_enterprise-schema-init   (creates enterprise schema + update_timestamp())
--           1778900000000_enable-postgis           (PostGIS extension)
--
-- Notes:
--   - Human-readable TEXT primary key (e.g. "amsterdam_central_ze_zone_2026")
--     chosen over UUID for audit trail readability per Phase 3 standalone
--     product requirements (ADR-0012 §4.6 data versioning).
--   - GIST index on polygon for point-in-polygon queries at scale.
--   - effective_to NULL = currently valid. effective_to NOT NULL implies superseded.
--   - GRANT block at end is defense-in-depth; default privileges set during
--     Sıra 1 should already cover this.

-- Up Migration

-- Pre-condition guards (idempotency + readability)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'PostGIS extension missing — apply 1778900000000_enable-postgis first';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'update_timestamp'
  ) THEN
    RAISE EXCEPTION 'update_timestamp() function missing — defined in enterprise-schema-init';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'enterprise') THEN
    RAISE EXCEPTION 'enterprise schema missing — apply 1778687553584_enterprise-schema-init first';
  END IF;
END $$;

CREATE TABLE enterprise.nl_compliance_zones (
  zone_id            TEXT PRIMARY KEY,
  city               TEXT NOT NULL,
  zone_type          TEXT NOT NULL
                       CHECK (zone_type IN ('ze_zone', 'weight_restriction',
                                            'time_window', 'tolling_corridor',
                                            'environmental')),
  polygon            GEOMETRY(POLYGON, 4326) NOT NULL,
  rules              JSONB NOT NULL,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  source             TEXT NOT NULL,
  source_url         TEXT,
  last_verified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_compliance_zones_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE  enterprise.nl_compliance_zones IS
  'NL compliance zones (ZE-Zones, weight restrictions, time windows, tolling corridors). '
  'ADR-0012 §5. Phase 1 manual seed; Phase 2 API ingestion; Phase 3 standalone CaaS.';

COMMENT ON COLUMN enterprise.nl_compliance_zones.zone_id IS
  'Human-readable PK (e.g. "amsterdam_central_ze_zone_2026"). Audit trail friendly.';
COMMENT ON COLUMN enterprise.nl_compliance_zones.zone_type IS
  'One of: ze_zone | weight_restriction | time_window | tolling_corridor | environmental.';
COMMENT ON COLUMN enterprise.nl_compliance_zones.polygon IS
  'POLYGON in WGS84 (SRID 4326). Used with GIST index for point-in-polygon queries.';
COMMENT ON COLUMN enterprise.nl_compliance_zones.rules IS
  'JSONB rules per ADR-0012 §5 example: min_emission_class, max_weight_kg, '
  'time_windows[], exempt_categories[], exemption_process, exemption_url.';
COMMENT ON COLUMN enterprise.nl_compliance_zones.effective_to IS
  'NULL = currently in effect. Set when zone superseded by newer version.';
COMMENT ON COLUMN enterprise.nl_compliance_zones.source IS
  'Provenance reference, e.g. "amsterdam_toegangsbeleid_v2026.05".';
COMMENT ON COLUMN enterprise.nl_compliance_zones.last_verified_at IS
  'Last time the rule was manually re-checked against the source. UI shows staleness.';

CREATE INDEX idx_compliance_zones_city
  ON enterprise.nl_compliance_zones (city);

CREATE INDEX idx_compliance_zones_polygon
  ON enterprise.nl_compliance_zones USING GIST (polygon);

CREATE INDEX idx_compliance_zones_effective
  ON enterprise.nl_compliance_zones (effective_from, effective_to);

CREATE TRIGGER trg_compliance_zones_updated_at
  BEFORE UPDATE ON enterprise.nl_compliance_zones
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Defense in depth: explicit grants (default privileges should already cover this
-- via Sıra 1 ALTER DEFAULT PRIVILEGES IN SCHEMA enterprise GRANT ALL ON TABLES TO enterprise_backend).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON enterprise.nl_compliance_zones TO enterprise_backend;

-- Down Migration

DROP TABLE IF EXISTS enterprise.nl_compliance_zones;
