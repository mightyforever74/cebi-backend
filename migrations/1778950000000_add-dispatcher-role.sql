-- Migration: Add 'dispatcher' value to public.users.role CHECK constraint
--
-- Purpose:
-- Adds 'dispatcher' as a valid value for the public.users.role column,
-- enabling user accounts for the Enterprise Dispatcher application.
-- Per ADR-0004 v3 §6.1 and ADR-0009 §5.1.
--
-- Compatibility:
-- Existing rows (super_admin, company_admin, driver) unaffected.
-- This is an additive change to the CHECK constraint.

-- Drop existing role CHECK constraint (idempotent)
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

-- Add new CHECK constraint with 'dispatcher' included
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'company_admin', 'driver', 'dispatcher'));

-- Sanity check
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_role_check'
  ) THEN
    RAISE EXCEPTION 'users_role_check constraint not created';
  END IF;
END $$;