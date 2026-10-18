-- Migration: public.users.role CHECK'ine 'weighbridge_operator' (Tartı Memuru) ekler
--
-- Kaynak: Faz 1 raporu §9.6 — mevcut 4 rolün (super_admin, company_admin,
-- driver, dispatcher) hiçbiri düşmüyor, Tartı Memuru 5. rol olarak ekleniyor.
-- Aynı desen: 1778950000000_add-dispatcher-role.sql (dispatcher eklenmesi).
--
-- Not: Rol adı İngilizce/snake_case tutuldu ("weighbridge_operator"), koddaki
-- diğer role değerleriyle (super_admin, company_admin, driver, dispatcher)
-- tutarlı olsun diye — ekranlarda "Tartı Memuru" olarak gösterilebilir,
-- bu sadece DB/API seviyesinde rol kimliği.

-- Drop existing role CHECK constraint (idempotent)
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

-- Add new CHECK constraint with 'weighbridge_operator' included
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'company_admin', 'driver', 'dispatcher', 'weighbridge_operator'));

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
