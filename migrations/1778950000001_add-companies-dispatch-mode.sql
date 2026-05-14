-- Migration: Add dispatch_mode column to public.companies
--
-- Purpose:
-- Per ADR-0004 v3 §6.3 and ADR-0005, companies can select their dispatcher
-- workflow maturity mode independently. Phase 1 default is 'advisory';
-- Phase 2 opt-in customers can switch to 'exception'; Phase 3 to 'agentic'.
--
-- Compatibility:
-- NOT NULL with DEFAULT 'advisory' — existing rows automatically get
-- 'advisory'. PostgreSQL 11+ ADD COLUMN with constant DEFAULT is fast
-- metadata-only, no table rewrite. No existing code reads this column.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS dispatch_mode text NOT NULL DEFAULT 'advisory';

ALTER TABLE public.companies
  ADD CONSTRAINT companies_dispatch_mode_check
  CHECK (dispatch_mode IN ('advisory', 'exception', 'agentic'));

-- Sanity check
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'companies'
      AND column_name = 'dispatch_mode'
  ) THEN
    RAISE EXCEPTION 'dispatch_mode column not added to public.companies';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.companies'::regclass
      AND conname = 'companies_dispatch_mode_check'
  ) THEN
    RAISE EXCEPTION 'companies_dispatch_mode_check constraint not created';
  END IF;
END $$;