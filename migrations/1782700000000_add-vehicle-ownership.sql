-- 3PL/kiralık araç özelliği (Cem talebi, 2026-07-31). Idempotent.
-- ownership_type: owned (özmal, varsayılan) | rented (kiralık) | leased (leasing)
-- owner_name: kiralık/leasing ise kimden (şirket ya da şahıs, serbest metin)
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS ownership_type TEXT NOT NULL DEFAULT 'owned';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS owner_name TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_vehicles_ownership_type') THEN
    ALTER TABLE public.vehicles ADD CONSTRAINT chk_vehicles_ownership_type
      CHECK (ownership_type IN ('owned','rented','leased'));
  END IF;
END $$;
\echo '=== vehicles ownership kolonlari OK ==='
