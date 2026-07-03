-- ============================================================================
-- Migration: enterprise.notification_preferences
-- Amac: Dispatcher kullanicisinin e-posta/bildirim tercihlerini kalici tutmak.
-- Ilgili: EmailIntegration frontend bileseni (/system/settings), enterprise
--         backend routes/notificationPreferences.js.
-- Sema sahipligi: enterprise.* -- sadece enterprise backend okur/yazar.
-- Apply order: staging (fleet_tracking_staging) -> smoke test ->
--              production backup -> production (fleet_tracking).
--
-- DUZELTME (2026-07-04): Onceki surumde "Down Migration" bolumu sadece
-- satir yorumuyla (--) baslatilmisti, altindaki DROP komutlari GERCEK SQL
-- olarak kaliyordu. psql dosyayi bastan sona sirali calistirdigi icin
-- migration TABLOYU OLUSTURUP HEMEN ARDINDAN KENDI KENDINI SILIYORDU
-- (staging smoke test'te 0 rows olarak yakalandi, production'a hic
-- uygulanmadan). Down Migration artik blok yoruma (/* */) alindi -
-- rollback gerekirse icindeki komutlar elle disari kopyalanip calistirilir.
-- ============================================================================

-- Up Migration

CREATE TABLE IF NOT EXISTS enterprise.notification_preferences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notification_email    text NOT NULL,
  mail_client           text NOT NULL DEFAULT 'native'
                        CHECK (mail_client IN ('native', 'web')),
  alert_ze_zone         boolean NOT NULL DEFAULT true,
  alert_dispatch_delay  boolean NOT NULL DEFAULT false,
  alert_device_offline  boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_company
  ON enterprise.notification_preferences (company_id);

CREATE TRIGGER trg_notification_preferences_updated_at
BEFORE UPDATE ON enterprise.notification_preferences
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

COMMENT ON TABLE enterprise.notification_preferences IS
  'Dispatcher kullanici e-posta/bildirim tercihleri. user_id UNIQUE - kullanici basina tek satir (upsert deseni). public.*a yazma yok, enterprise sema.';

-- Sanity check
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'enterprise' AND table_name = 'notification_preferences'
  ) THEN
    RAISE EXCEPTION 'enterprise.notification_preferences table not created';
  END IF;
END $$;


-- ============================================================================
-- Down Migration (REFERANS AMACLI - blok yorum icinde, otomatik calismaz)
-- Rollback gerekirse icindeki iki satiri disari kopyalayip elle calistir.
-- ============================================================================
/*
DROP TRIGGER IF EXISTS trg_notification_preferences_updated_at ON enterprise.notification_preferences;
DROP TABLE IF EXISTS enterprise.notification_preferences;
*/
