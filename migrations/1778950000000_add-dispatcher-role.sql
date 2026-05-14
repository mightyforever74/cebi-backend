-- Migration: Add 'dispatcher' value to public.users.role CHECK constraint
--
-- Purpose:
-- Adds 'dispatcher' as a valid value for the public.users.role column,
-- enabling user accounts for the Enterprise Dispatcher application.
-- Per ADR-0004 v3 v6.1 and ADR-0009 v5.1.
--
-- Compatibility:
-- Existing rows (super_admin, company_admin, driver) unaffected.
-- This is an additive change to the CHECK constraint.

-- Drop existing role CHECK constraint (any name) if present
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'users'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%role%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', cname);
    RAISE NOTICE 'Dropped existing constraint: %', cname;
  ELSE
    RAISE NOTICE 'No existing role CHECK constraint found, creating fresh';
  END IF;
END $$;

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