-- FEAT-018 FN-04 calculateReturnPriority — oncelik formulu icin yeni alanlar.
-- Spec: docs/functions/FEAT-018-reverse-logistics-handling.md (v2) §1.3, §8
--       (FN-04 calculateReturnPriority, alt-paradigma A).
-- Kaynak pattern: FEAT-003 §4.2 weighted-sum (ADR-0010 §2 "tunable, not ML").
--
-- Cem 2026-10-14 onayi: agirlikli toplam SLA %50 + deger %30 + musteri
-- onceligi %20. Bu migration formulun ihtiyac duydugu 2 yeni additive
-- kolonu ekler:
--   - enterprise.rma_requests.sla_deadline: SLA bileseni icin (NULL ->
--     sla_score=0, deadline gecmisse -> sla_score=1).
--   - public.companies.customer_tier: musteri onceligi bileseni icin
--     (enterprise/premium/standard/NULL -> 1.0/0.66/0.33/0.0).
--
-- estimated_value_eur zaten enterprise.rma_requests'te mevcut (deger
-- bileseni icin yeni kolon gerekmiyor).

ALTER TABLE enterprise.rma_requests
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS customer_tier TEXT;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_customer_tier_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_customer_tier_check
  CHECK (customer_tier IS NULL OR customer_tier IN ('enterprise', 'premium', 'standard'));

COMMENT ON COLUMN enterprise.rma_requests.sla_deadline IS
  'FEAT-018 FN-04 (2026-10-14). calculateReturnPriority SLA bileseni (agirlik %50, SLA_WINDOW_HOURS=72). NULL olabilir -> sla_score=0.';

COMMENT ON COLUMN public.companies.customer_tier IS
  'FEAT-018 FN-04 (2026-10-14). calculateReturnPriority musteri onceligi bileseni (agirlik %20). enterprise=1.0, premium=0.66, standard=0.33, NULL=0.0.';

DO $$
BEGIN
  RAISE NOTICE 'FEAT-018 FN-04 migration tamamlandi: rma_requests.sla_deadline + companies.customer_tier eklendi';
END $$;

-- Down migration (elle calistirilmali):
-- ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_customer_tier_check;
-- ALTER TABLE public.companies DROP COLUMN IF EXISTS customer_tier;
-- ALTER TABLE enterprise.rma_requests DROP COLUMN IF EXISTS sla_deadline;