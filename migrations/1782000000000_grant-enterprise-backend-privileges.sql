-- ============================================================================
-- Migration: 1782000000000_grant-enterprise-backend-privileges.sql
-- ============================================================================
-- Brings PROD enterprise_backend role grants up to the contract spec.
--
-- PROBLEM discovered 2026-06-02 (Adım 3 pre-coding smoke-write proof):
--   PROD enterprise_backend was missing grants that STAGING had:
--     - has_schema_privilege(enterprise, USAGE) = FALSE  (the actual blocker:
--       without USAGE, even table grants are unusable -> "permission denied for
--       schema enterprise")
--     - public.{vehicles,companies,users,drivers,tasks} SELECT = absent
--     - enterprise.* table grants existed on ONLY 2 tables (nl_compliance_zones,
--       nl_vrachtwagenheffing_tariffs); the new ontheffing tables had NONE.
--   STAGING had the full set (enterprise+public USAGE; 8 enterprise tables ALL;
--   5 public tables SELECT). The grants were simply never applied to prod.
--
-- CONTRACT (INTEGRATION_BOUNDARIES line 71): enterprise_backend gets
--   SELECT on public.{vehicles,companies,users,drivers,tasks};
--   ALL on enterprise.*; statement_timeout 10s (role-level, not set here).
--
-- This migration makes prod match that contract, idempotently, least-privilege:
--   public.* = SELECT only (never write — INTEGRATION_BOUNDARIES §5.2);
--   enterprise.* = ALL (the dispatcher owns this schema, ADR-0009 §4.5.1).
--
-- ALTER DEFAULT PRIVILEGES ensures FUTURE enterprise.* tables auto-grant to the
--   role, so we never rediscover this gap when a new table is added.
--
-- Schema authority / executor: tulipfleet-backend / production team
--   (INTEGRATION_BOUNDARIES §5.2 — public.* grants are applied by the prod side).
-- Runs as a superuser (fleetadmin) on prod PostgreSQL. Idempotent (GRANT is
--   additive and repeatable; ALTER DEFAULT PRIVILEGES is idempotent).
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

\echo ''
\echo '=== BEFORE ==='
SELECT has_schema_privilege('enterprise_backend','enterprise','USAGE') AS ent_usage,
       has_schema_privilege('enterprise_backend','public','USAGE')     AS pub_usage,
       has_table_privilege('enterprise_backend','public.vehicles','SELECT') AS vehicles_select;

-- ── 1. Schema USAGE (the missing blocker) ──────────────────────────────────
GRANT USAGE ON SCHEMA enterprise TO enterprise_backend;
GRANT USAGE ON SCHEMA public     TO enterprise_backend;  -- usually present, idempotent

-- ── 2. enterprise.* = ALL on every existing table (covers the new ontheffing
--      tables + any others); least-privilege within the schema the role owns ──
GRANT ALL ON ALL TABLES    IN SCHEMA enterprise TO enterprise_backend;
GRANT ALL ON ALL SEQUENCES IN SCHEMA enterprise TO enterprise_backend;

-- ── 3. public.* = SELECT only on the 5 contract tables (NOT schema-wide;
--      least-privilege — enterprise side must never write public.*) ──────────
GRANT SELECT ON public.vehicles  TO enterprise_backend;
GRANT SELECT ON public.companies TO enterprise_backend;
GRANT SELECT ON public.users     TO enterprise_backend;
GRANT SELECT ON public.drivers   TO enterprise_backend;
GRANT SELECT ON public.tasks     TO enterprise_backend;

-- ── 4. Future-proofing: auto-grant on NEW enterprise.* objects ─────────────
--      (so the next table created in enterprise never repeats this gap).
--      Applies to objects created by the role that runs migrations here.
ALTER DEFAULT PRIVILEGES IN SCHEMA enterprise
  GRANT ALL ON TABLES TO enterprise_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA enterprise
  GRANT ALL ON SEQUENCES TO enterprise_backend;

\echo ''
\echo '=== AFTER (expect all t / SELECT present) ==='
SELECT has_schema_privilege('enterprise_backend','enterprise','USAGE') AS ent_usage,
       has_schema_privilege('enterprise_backend','public','USAGE')     AS pub_usage,
       has_table_privilege('enterprise_backend','public.vehicles','SELECT')  AS vehicles_sel,
       has_table_privilege('enterprise_backend','enterprise.nl_dagontheffing_counters','INSERT') AS counters_ins,
       has_table_privilege('enterprise_backend','enterprise.nl_compliance_vehicle_ontheffings','INSERT') AS onth_ins;

\echo ''
\echo '=== enterprise.* table grant coverage (expect all enterprise tables listed) ==='
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE grantee='enterprise_backend' AND table_schema='enterprise'
GROUP BY table_name ORDER BY table_name;

INSERT INTO public.pgmigrations (name, run_on)
SELECT '1782000000000_grant-enterprise-backend-privileges', NOW()
WHERE NOT EXISTS (SELECT 1 FROM public.pgmigrations WHERE name='1782000000000_grant-enterprise-backend-privileges');

COMMIT;
\echo ''
\echo '=== enterprise_backend privileges GRANTED ==='
