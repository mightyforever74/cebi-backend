-- =============================================================================
-- BUG-1 Spec v3 Faz C — Karar Loguna Çakışma Mührü
-- Migration: 1782900000000_bug1-decision-log-conflict-metadata
-- Staging'de uygulandı: 2026-08-02 (kolon-varlık kanıtı 1/1)
-- Prod aynası: savunmacı — dispatch_decision_log yoksa NOTICE ile atlar.
-- Tasarım: çakışma override'ı, araç-seçimi override'ından (is_override
--   GENERATED) BAĞIMSIZ; işareti conflict_metadata IS NOT NULL. Serbest
--   gerekçe override_comment'te taşınır — §6.4 override_reason enum'una
--   dokunulmaz.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('enterprise.dispatch_decision_log') IS NULL THEN
    RAISE NOTICE 'enterprise.dispatch_decision_log yok - kolon eklenmesi ATLANDI';
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE enterprise.dispatch_decision_log ADD COLUMN IF NOT EXISTS conflict_metadata jsonb';
END $$;

INSERT INTO pgmigrations (name, run_on)
SELECT '1782900000000_bug1-decision-log-conflict-metadata', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1782900000000_bug1-decision-log-conflict-metadata');

COMMIT;
