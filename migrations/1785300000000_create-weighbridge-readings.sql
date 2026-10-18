-- Migration: public.weighbridge_readings — Weighbridge Operations bounded context
--
-- Kaynak: Faz 1 raporu §8.4 (adapter pattern, onaylı), §9.2 (cihaz marka/model
-- henüz bilinmiyor — kabul edildi, bu tablo cihazdan bağımsız tasarlandı),
-- §9.5 (tartım kaydı zorunlu ve DEĞİŞMEZ — kaçak/kayıp yüklemeyi önleyen bir
-- caydırıcı kontrol, "nice to have" değil çekirdek güvenlik gereksinimi).
--
-- Tasarım kararları:
-- 1) Adapter-agnostic: adapter_type + raw_payload (jsonb) sayesinde cihaz
--    marka/modeli geldiğinde bu tabloya DOKUNULMADAN yeni bir adapter
--    implementasyonu eklenir (services/weighbridge/adapters/).
-- 2) Append-only / değişmez: UPDATE ve DELETE, bu dosyanın sonundaki
--    trigger ile DB seviyesinde tamamen engellenir. Bir düzeltme gerekirse
--    supersedes_id ile eski kaydı işaret eden YENİ bir satır eklenir —
--    düzeltme/iptal geçmişi hiçbir zaman kaybolmaz (§9.5/§4.3).
-- 3) task_id → public.tasks(id): tartım, dispatcher-seviyesi
--    enterprise.dispatch_tasks değil, sürücünün fiilen yürüttüğü
--    public.tasks kaydına bağlanır (tasks.enterprise_dispatch_task_id
--    köprüsü zaten mevcut — 1782100000000_add-tasks-enterprise-dispatch-task-id.sql).
--    ADR-CE-04'ün gün-seviyesi reconciliation'ı bu köprü üzerinden
--    enterprise.dispatch_tasks'a ulaşabilir.
-- 4) "Completed" durumuna geçiş engeli (§9.5, ADR-CE-04 §2-A) bu migration'ın
--    KAPSAMI DIŞINDA — bu sadece veri modeli. Gate'in application-seviyesinde
--    (routes/driver.js waypoint/task completion akışına) nereye bağlanacağı
--    ayrı bir karar/iş; weighbridge_readings_current view'ı (aşağıda) bu
--    kontrolü yazacak koda hazır bir sorgu yüzeyi sağlar.

CREATE TABLE IF NOT EXISTS public.weighbridge_readings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  vehicle_id        UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  weight_kg         NUMERIC(10,2) NOT NULL CHECK (weight_kg >= 0),
  adapter_type      TEXT NOT NULL DEFAULT 'manual'
                     CHECK (adapter_type IN ('manual', 'http', 'tcp', 'serial')),
  -- device_identifier: marka/model/seri no bilgisi geldiğinde doldurulacak
  -- (§9.2 açık madde) — şimdilik nullable, mimariyi bloklamıyor.
  device_identifier TEXT,
  -- raw_payload: cihazdan/adapter'dan gelen ham veri (adapter-agnostic).
  -- Manuel girişte NULL kalabilir; HTTP/TCP/Serial adapter'lar cihazın
  -- orijinal yanıtını buraya kaydeder (ileride denetim/debug için).
  raw_payload       JSONB,
  recorded_by       UUID NOT NULL REFERENCES public.users(id),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Düzeltme zinciri: bu alan doluysa bu satır, supersedes_id'nin işaret
  -- ettiği satırın YERİNE geçen bir düzeltmedir — o satır silinmez/değişmez,
  -- sadece "current" view'ından (aşağıda) düşer.
  supersedes_id     UUID REFERENCES public.weighbridge_readings(id),
  supersede_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT weighbridge_readings_supersede_reason_required
    CHECK (supersedes_id IS NULL OR supersede_reason IS NOT NULL),
  CONSTRAINT weighbridge_readings_no_self_supersede
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_weighbridge_readings_task
  ON public.weighbridge_readings (task_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_weighbridge_readings_supersedes
  ON public.weighbridge_readings (supersedes_id) WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE public.weighbridge_readings IS
  'Weighbridge Operations (Faz 1 §8.4/§9.5). Append-only — UPDATE/DELETE trigger ile engellenir. Düzeltmeler supersedes_id zinciriyle yeni satır olarak eklenir. ADR-CE-04/§9.5: sefer Completed olmadan önce zorunlu.';

-- ── Değişmezlik: UPDATE/DELETE DB seviyesinde tamamen engellenir ──────────
CREATE OR REPLACE FUNCTION public.weighbridge_readings_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'public.weighbridge_readings append-only bir denetim tablosudur (Faz 1 §9.5) — % işlemi yasak. Düzeltme için supersedes_id ile yeni bir satır ekleyin.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weighbridge_readings_no_update ON public.weighbridge_readings;
CREATE TRIGGER trg_weighbridge_readings_no_update
BEFORE UPDATE ON public.weighbridge_readings
FOR EACH ROW EXECUTE FUNCTION public.weighbridge_readings_block_mutation();

DROP TRIGGER IF EXISTS trg_weighbridge_readings_no_delete ON public.weighbridge_readings;
CREATE TRIGGER trg_weighbridge_readings_no_delete
BEFORE DELETE ON public.weighbridge_readings
FOR EACH ROW EXECUTE FUNCTION public.weighbridge_readings_block_mutation();

-- ── "Güncel" (henüz düzeltilmemiş) tartım kayıtları ────────────────────────
-- Gate kontrolü ("bu sefer tartılmış mı?") bu view üzerinden yazılabilir:
--   SELECT EXISTS (SELECT 1 FROM public.weighbridge_readings_current WHERE task_id = $1)
CREATE OR REPLACE VIEW public.weighbridge_readings_current AS
SELECT r.*
FROM public.weighbridge_readings r
WHERE NOT EXISTS (
  SELECT 1 FROM public.weighbridge_readings s WHERE s.supersedes_id = r.id
);

DO $$
BEGIN
  RAISE NOTICE 'weighbridge_readings migration tamamlandi: tablo + append-only trigger + current view hazir';
END $$;

-- Down migration (elle calistirilmali):
-- DROP VIEW IF EXISTS public.weighbridge_readings_current;
-- DROP TRIGGER IF EXISTS trg_weighbridge_readings_no_delete ON public.weighbridge_readings;
-- DROP TRIGGER IF EXISTS trg_weighbridge_readings_no_update ON public.weighbridge_readings;
-- DROP FUNCTION IF EXISTS public.weighbridge_readings_block_mutation();
-- DROP TABLE IF EXISTS public.weighbridge_readings;
