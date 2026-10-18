-- Migration: public.mobile_location_pings — sefer-döngüsü bazlı mobil GPS
--
-- Kaynak: ADR-CE-01 (Mobil Konum Takibi, onaylı — konum toplama sefer
-- başlayınca açılır, sefer boyunca sürer, kapanınca durur) + ADR-CE-02
-- (Mobil Telemetri İletimi — HTTPS toplu senkronizasyon, local queue +
-- sunucu tarafı idempotency/dedup, bu migration'la netleşiyor).
--
-- Bilinçli olarak public.locations (ESP32 cihaz telemetrisi, device_id
-- bazlı, §2.1 Faz 1) ile AYNI tabloya YAZILMIYOR — farklı bir veri kaynağı
-- (telefon GPS'i, device_id'siz) farklı bir tabloda tutuluyor; iki kaynağı
-- karıştırmak (ör. sahte bir device_id uydurmak) ileride ayrıştırmayı
-- zorlaştırırdı.
--
-- Dedup/idempotency tasarımı (ADR-CE-02 §5'in açık sorusuna cevap):
-- client_ping_id, mobil uygulamanın HER GPS okuması için ürettiği bir UUID.
-- Toplu senkronizasyon tekrar denendiğinde (ağ kopması, retry) aynı
-- client_ping_id'li satır UNIQUE constraint + ON CONFLICT DO NOTHING ile
-- sessizce atlanır — sunucu tarafında ekstra bir "son görülen id" state'i
-- tutmaya gerek kalmaz, her istek doğal olarak idempotent olur.

CREATE TABLE IF NOT EXISTS public.mobile_location_pings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ping_id UUID NOT NULL,
  task_id        UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  driver_id      UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  latitude       NUMERIC(10,7) NOT NULL,
  longitude      NUMERIC(10,7) NOT NULL,
  speed          NUMERIC(6,2),
  heading        NUMERIC(6,2),
  accuracy       NUMERIC(8,2),
  -- recorded_at: cihazın kendi saatiyle damgaladığı an (offline kuyrukta
  -- bekleyip sonradan senkronize edilebileceği için received_at'tan farklı
  -- olabilir — reconciliation/analiz recorded_at üzerinden yapılmalı).
  recorded_at    TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mobile_location_pings_client_ping_id_key UNIQUE (client_ping_id)
);

CREATE INDEX IF NOT EXISTS idx_mobile_location_pings_task
  ON public.mobile_location_pings (task_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_mobile_location_pings_driver
  ON public.mobile_location_pings (driver_id, recorded_at);

COMMENT ON TABLE public.mobile_location_pings IS
  'ADR-CE-01/ADR-CE-02 — sefer-döngüsü bazlı mobil GPS, HTTPS toplu senkronizasyon. client_ping_id UNIQUE ile idempotent (yinelenen senkronizasyon denemeleri güvenli).';

-- BİLİNÇLİ OLARAK HYPERTABLE YAPILMADI (ilk denemede canlıda bulunan hata,
-- bu turda düzeltildi):
--
-- TimescaleDB, bir hypertable üzerindeki HER UNIQUE/PRIMARY KEY constraint'in
-- partitioning (zaman) kolonunu içermesini zorunlu kılıyor
-- ("cannot create a unique index without the column 'recorded_at' (used in
-- partitioning)"). Bizim idempotency tasarımımız ise `ON CONFLICT
-- (client_ping_id) DO NOTHING` için `client_ping_id` ÜZERİNDE TEK BAŞINA
-- bir UNIQUE constraint gerektiriyor (Postgres'in ON CONFLICT hedef
-- eşlemesi, unique index'in kolon kümesiyle TAM eşleşme ister — ör.
-- `(client_ping_id, recorded_at)` composite unique, `ON CONFLICT
-- (client_ping_id)` ile eşleşmez). Bu iki gereksinim birbiriyle çatışıyor.
--
-- Karar: idempotency (iş kuralı, dedup garantisi) hypertable'ın
-- performans avantajından (büyük ölçekte zaman-bazlı partitioning) daha
-- öncelikli. V1 kapsamı (foreground-only, sefer-başına sınırlı süre GPS
-- toplama) zaten `public.locations` (7/24 çok-araçlı ESP32 telemetrisi)
-- ile kıyaslanamayacak kadar düşük hacimli — hypertable'ın getirisi bu
-- ölçekte önemsiz. Retention (eski kayıtların silinmesi) hacim gerçek
-- bir sorun haline gelirse ayrı bir cron/scheduled job ile ele alınabilir
-- — bu migration'ın kapsamı dışında bırakıldı.

DO $$
BEGIN
  RAISE NOTICE 'mobile_location_pings migration tamamlandi: tablo + indexler hazir (duz tablo, hypertable degil)';
END $$;

-- Down migration (elle calistirilmali):
-- DROP TABLE IF EXISTS public.mobile_location_pings;
