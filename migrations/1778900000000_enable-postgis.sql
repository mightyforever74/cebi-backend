-- Migration: Enable PostGIS extension
--
-- Purpose:
-- Activates PostGIS 3.3.2 extension for geometric/spatial data support.
-- Required by ADR-0012 (NL Compliance Layer Strategy) §4.7 for the
-- enterprise.nl_compliance_zones table polygon storage
-- (GEOMETRY(POLYGON, 4326) type).
--
-- Coexistence:
-- PostGIS coexists with TimescaleDB extension. Verified on staging
-- 2026-05-15: both extensions function correctly side by side, hypertables
-- (public.alerts, enterprise.locations_3p) remain operational, simple
-- geometry test (ST_GeomFromText) successful. No impact on existing tables.
--
-- Reversibility:
-- DROP EXTENSION postgis; works ONLY if no tables/columns depend on PostGIS
-- types. Once enterprise.nl_compliance_zones is created with a GEOMETRY
-- column, this drop will fail. This is acceptable — PostGIS adoption is a
-- one-way decision per ADR-0012 architectural constraint.

-- Up Migration
CREATE EXTENSION IF NOT EXISTS postgis;

-- Sanity check: extension must be loaded
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'PostGIS extension not loaded after CREATE EXTENSION';
  END IF;
END $$;

-- Down Migration
-- Drop is intentionally commented out. Uncomment only after verifying
-- no schema or column depends on PostGIS types (e.g., GEOMETRY, GEOGRAPHY).
-- DROP EXTENSION postgis;