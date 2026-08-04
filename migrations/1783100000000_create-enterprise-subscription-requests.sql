-- FEAT-SaaS Self-Service (05.08.2026, Cem onayli D-S1):
-- Musteri talepleri (arac kota artirimi / B2B API paketi) dispatcher'dan
-- enterprise.subscription_requests'e PENDING_APPROVAL olarak yazilir
-- (enterprise_backend'in enterprise.* yazma hakki — yetki modeli korunur).
-- Onay ani ana fleet backend SuperAdmin endpoint'inde: public.companies
-- kotasi guncellenir + public.subscription_audit_logs'a mevcut sozlesmeyle
-- muhur dusulur. Kota paydasi = companies.max_vehicles (MEVCUT kolon).
CREATE TABLE IF NOT EXISTS enterprise.subscription_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  requested_by   uuid REFERENCES public.users(id),
  request_type   text NOT NULL CHECK (request_type IN ('vehicle_increase','api_package')),
  requested_amount integer NOT NULL CHECK (requested_amount > 0),
  payment_note   text,            -- dekont no / odeme bildirimi (musteri beyani)
  status         text NOT NULL DEFAULT 'PENDING_APPROVAL'
                 CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
  decided_by     uuid REFERENCES public.users(id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subreq_company_status
  ON enterprise.subscription_requests (company_id, status);
CREATE INDEX IF NOT EXISTS idx_subreq_pending
  ON enterprise.subscription_requests (created_at DESC) WHERE status = 'PENDING_APPROVAL';
GRANT SELECT, INSERT, UPDATE ON enterprise.subscription_requests TO enterprise_backend;
\echo '=== enterprise.subscription_requests OK ==='
