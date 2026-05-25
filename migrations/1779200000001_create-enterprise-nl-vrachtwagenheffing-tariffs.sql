-- Migration: 1779200000001_create-enterprise-nl-vrachtwagenheffing-tariffs
-- Purpose : Create enterprise.nl_vrachtwagenheffing_tariffs table for NL HGV
--           mileage-based tolling tariffs (Vrachtwagenheffing, in force Temmuz 2026).
-- Phase   : 1 — Internal use only (manual seed of published tariff schedule).
-- Authors : Cem Bakir
-- Related : ADR-0012 §3.1 (Phase 1: Vrachtwagenheffing statik tarife tablosu)
--           ADR-0011 FEAT-008 (Vrachtwagenheffing route cost optimization)
--           ADR-0009 §4.5 (Compliance Engine inheritance)
-- Depends : 1778687553584_enterprise-schema-init   (creates enterprise schema + update_timestamp())
--           1779200000000_create-enterprise-nl-compliance-zones (sibling, for ordering)
--
-- Tariff categorization (per NL Vrachtwagenheffing categorization, aligned with
--   EU Eurovignette/Viapass conventions):
--   - vehicle_weight_class: 12_18t | 18_32t | 32_plus_t
--   - emission_class:       euro_0 .. euro_6 | zero_emission
--   - road_type:            motorway | n_road | all_other
--
-- Tasarım notları:
--   - Aynı TEXT PK pattern'ı (audit-friendly) compliance_zones ile tutarlı.
--   - UNIQUE INDEX (weight, emission, road, effective_from) — aynı kategori için
--     iki çakışan tarife olamaz; veri bütünlüğü DB seviyesinde garanti.
--   - rate_eur_per_km NUMERIC(6,4) — reel değerler ~0.05–0.25 €/km, 4 decimal yeter.
--   - Tariffs published in PDF/CSV by vrachtwagenheffing.nl; manual seed.

-- Up Migration

DO $$
BEGIN
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

CREATE TABLE enterprise.nl_vrachtwagenheffing_tariffs (
  tariff_id              TEXT PRIMARY KEY,
  vehicle_weight_class   TEXT NOT NULL
                           CHECK (vehicle_weight_class IN
                                  ('12_18t', '18_32t', '32_plus_t')),
  emission_class         TEXT NOT NULL
                           CHECK (emission_class IN
                                  ('euro_0', 'euro_1', 'euro_2', 'euro_3',
                                   'euro_4', 'euro_5', 'euro_6', 'zero_emission')),
  road_type              TEXT NOT NULL
                           CHECK (road_type IN
                                  ('motorway', 'n_road', 'all_other')),
  rate_eur_per_km        NUMERIC(6,4) NOT NULL
                           CHECK (rate_eur_per_km >= 0),
  effective_from         DATE NOT NULL,
  effective_to           DATE,
  source                 TEXT NOT NULL,
  source_url             TEXT,
  last_verified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_vrachtwagenheffing_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE  enterprise.nl_vrachtwagenheffing_tariffs IS
  'NL HGV mileage-based tolling tariffs (Vrachtwagenheffing, in force Temmuz 2026). '
  'ADR-0012 §3.1; ADR-0011 FEAT-008. Phase 1 manual seed.';

COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.tariff_id IS
  'Human-readable PK, e.g. "vh_2026_07_18_32t_euro6_motorway". Audit trail friendly.';
COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.vehicle_weight_class IS
  'Vehicle gross weight category. NL Vrachtwagenheffing applies to 12+ ton vehicles.';
COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.emission_class IS
  'EURO emission class. Lower-emission vehicles receive reduced tariffs.';
COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.road_type IS
  'NL tolling applies to motorways and select N-roads. all_other = no toll (0 €/km).';
COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.rate_eur_per_km IS
  'EUR per km, NUMERIC(6,4). Supports up to 99.9999 €/km; real values ~0.05–0.25.';
COMMENT ON COLUMN enterprise.nl_vrachtwagenheffing_tariffs.effective_to IS
  'NULL = currently in effect. Set when tariff superseded by newer published schedule.';

-- Lookup index — every routing query reads by (weight, emission, road, date).
CREATE UNIQUE INDEX uq_vrachtwagenheffing_lookup
  ON enterprise.nl_vrachtwagenheffing_tariffs
  (vehicle_weight_class, emission_class, road_type, effective_from);

CREATE INDEX idx_vrachtwagenheffing_effective
  ON enterprise.nl_vrachtwagenheffing_tariffs (effective_from, effective_to);

CREATE TRIGGER trg_vrachtwagenheffing_updated_at
  BEFORE UPDATE ON enterprise.nl_vrachtwagenheffing_tariffs
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON enterprise.nl_vrachtwagenheffing_tariffs TO enterprise_backend;

-- Down Migration

DROP TABLE IF EXISTS enterprise.nl_vrachtwagenheffing_tariffs;
