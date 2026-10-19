-- Migration: public.daily_trip_reconciliation — ADR-CE-04 §2-B/§B.1/§B.2/§B.3
--
-- Kaynak: docs/adr/ADR-CE-04-sefer-kapanis-reconciliation.md (v3, Onaylandı).
-- Gün-seviyesi otomatik reconciliation: bir sürücü için o gün planlanmış
-- sefer sayısı ile o gün tamamlanmış sefer sayısı otomatik karşılaştırılır.
-- tamamlanan >= planlanan ise gün sistem tarafından otomatik kapatılır
-- (status='closed_auto'); aksi halde gün kapanmaz ve mevcut
-- enterprise.exception_events hypertable'ına bir istisna kaydı düşülür
-- (status='exception_raised', bkz. 1785400000000_exception-events-add-
-- trip-reconciliation-type.sql — 'trip_count_reconciliation_mismatch' tipi
-- zaten eklenmişti, bu migration o altyapıyı ilk kez gerçekten kullanan
-- koddur).
--
-- Tasarım kararları:
-- 1) Anahtar: (driver_id, reconciliation_date) — ADR §B.1 "bir araç/sürücü
--    için" ifadesini sürücü-bazlı okudu: caydırıcılık amacı (§9.5/§9.4)
--    kaçak/atlanan seferi sürücü hesap verebilirliğine bağlıyor, araç
--    bir günde birden fazla sürücü tarafından kullanılabiliyor (tasks
--    tablosunda driver_id ve vehicle_id ayrı kolonlar).
-- 2) planned_count_override NULL ise otomatik türetilen sayı geçerli
--    (ADR §B.1 "Varsayılan"); dolu değer override'ı aktive eder. Override
--    yalnızca company_admin/super_admin yapabilir — bu kısıt DB seviyesinde
--    DEĞİL, application (routes/reconciliation.js) seviyesinde uygulanır
--    (weighbridge_readings'in append-only trigger'ının aksine, ADR'nin
--    kendisi "tartım kaydının değişmezliği kadar katı olmasa da loglanır"
--    diyor — bu yüzden burada DB-seviyesi mutation-block triggeri YOK,
--    sadece bir audit-log tablosu var, aşağıda).
-- 3) status: 'pending' (gün henüz kapanmadı/değerlendirilmeyi bekliyor),
--    'closed_auto' (otomatik kapandı), 'exception_raised' (uyuşmazlık,
--    exception_events'e düşüldü). Bir satır closed_auto/exception_raised'a
--    geçtikten sonra yeniden işlenmez (idempotency — hem sefer-tamamlama
--    tetikleyicisi hem gece yarısı cron'u aynı satırı güvenle tekrar
--    değerlendirebilir, bkz. services/reconciliation/tripReconciliation.js).
-- 4) exception_event_id: FK DEĞİL (enterprise.exception_events bir
--    hypertable, PK (id, occurred_at) kompozit — tek bir UUID FK ile
--    referans verilemez, aynı weighbridge/exception_events ilişkisinde
--    izlenen desen). Sadece izlenebilirlik için saklanır.

CREATE TABLE IF NOT EXISTS public.daily_trip_reconciliation (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  driver_id              UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  reconciliation_date    DATE NOT NULL,
  -- Override (ADR §B.1) — NULL = otomatik türetilen sayı kullanılır.
  planned_count_override INT CHECK (planned_count_override IS NULL OR planned_count_override >= 0),
  override_set_by        UUID REFERENCES public.users(id),
  override_set_at        TIMESTAMPTZ,
  override_reason        TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'closed_auto', 'exception_raised')),
  -- planned_count/completed_count: son değerlendirmede KULLANILAN
  -- (override varsa onu yansıtan) ve HESAPLANAN anlık değerler — her
  -- değerlendirmede güncellenir, sadece status terminal olunca donar.
  planned_count          INT,
  completed_count        INT,
  closed_at              TIMESTAMPTZ,
  exception_event_id     UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (driver_id, reconciliation_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_trip_reconciliation_pending
  ON public.daily_trip_reconciliation (reconciliation_date)
  WHERE status = 'pending';

COMMENT ON TABLE public.daily_trip_reconciliation IS
  'ADR-CE-04 §2-B gün-seviyesi otomatik sefer kapanış reconciliation''ı. Bir satır = bir (driver_id, reconciliation_date) çifti. status terminal olunca (closed_auto/exception_raised) yeniden işlenmez.';

-- ── Override audit log (ADR §B.1 "loglanır — kim, ne zaman, hangi
--    gerekçeyle") — append-only KULLANIM KONVANSİYONUYLA (weighbridge'deki
--    gibi DB-seviyesi trigger engeliyle DEĞİL, ADR'nin kendi "tartım kaydı
--    kadar katı değil" kalibrasyonuna uygun): her override denemesi (yeni
--    değer VEYA override'ı kaldırmak için NULL) burada ayrı bir satır
--    olarak birikir, daily_trip_reconciliation'daki alanlar sadece EN SON
--    override'ı yansıtır. ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_trip_reconciliation_override_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id       UUID NOT NULL REFERENCES public.daily_trip_reconciliation(id) ON DELETE CASCADE,
  planned_count_override  INT, -- NULL = bu islemde override kaldirildi
  set_by                  UUID NOT NULL REFERENCES public.users(id),
  reason                  TEXT NOT NULL,
  set_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_trip_reconciliation_override_log_recon
  ON public.daily_trip_reconciliation_override_log (reconciliation_id, set_at DESC);

COMMENT ON TABLE public.daily_trip_reconciliation_override_log IS
  'ADR-CE-04 §B.1 override audit gecmisi — her override denemesi (set veya kaldirma) ayri bir satir, en son durumu daily_trip_reconciliation yansitir.';

DO $$
BEGIN
  RAISE NOTICE 'daily_trip_reconciliation + override_log migration tamamlandi (ADR-CE-04)';
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS public.daily_trip_reconciliation_override_log;
-- DROP TABLE IF EXISTS public.daily_trip_reconciliation;
