-- FEAT-018 Phase 2.5 — public.warehouses'a iletişim bilgisi kolonları.
-- Cem 2026-10-14: depo/lokasyon noktaları için standart alan seti (Seçenek A
-- — public.warehouses'ı genişlet, ayrı global locations tablosu YOK).
--
-- company_id, name, latitude/longitude, address zaten vardı (§3.3, FN-17).
-- Eksik olan 2 alan: iletişim kişisinin telefonu ve e-postası.

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS contact_phone TEXT;

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS contact_email TEXT;

COMMENT ON COLUMN public.warehouses.contact_phone IS
  'FEAT-018 Phase 2.5 (2026-10-14). Lokasyon iletişim kişisinin telefonu — Cem onayı, Secenek A.';
COMMENT ON COLUMN public.warehouses.contact_email IS
  'FEAT-018 Phase 2.5 (2026-10-14). Lokasyon iletişim kişisinin e-postası — Cem onayı, Secenek A.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-018 Phase 2.5 migration tamamlandi: public.warehouses.contact_phone + contact_email eklendi';
END $$;

-- Down migration (elle calistirilmali):
-- ALTER TABLE public.warehouses DROP COLUMN IF EXISTS contact_phone;
-- ALTER TABLE public.warehouses DROP COLUMN IF EXISTS contact_email;