-- Migration: enterprise.exception_events.exception_type CHECK'ine
-- 'trip_count_reconciliation_mismatch' ekler (ADR-CE-04 §B.2)
--
-- Kaynak: docs/adr/ADR-CE-04-sefer-kapanis-reconciliation.md v2 — gün
-- sonunda tamamlanan < planlanan sefer sayısı ise gün otomatik kapanmaz,
-- bunun yerine bu exception_type ile mevcut enterprise.exception_events
-- hypertable'ına bir kayıt düşülür (yeni bir mekanizma icat edilmedi).
--
-- Desen: 1782800000000_bug1-overlap-foundation.sql'deki 19. tip eklemesiyle
-- (rule_violation) birebir aynı — savunmacı blok (tablo yoksa atla),
-- constraint drop+recreate.

DO $$
DECLARE cname text;
BEGIN
  IF to_regclass('enterprise.exception_events') IS NULL THEN
    RAISE NOTICE 'enterprise.exception_events yok - CHECK genisletmesi ATLANDI';
    RETURN;
  END IF;

  SELECT conname INTO STRICT cname
  FROM pg_constraint
  WHERE conrelid = 'enterprise.exception_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%eta_delay%';

  EXECUTE format('ALTER TABLE enterprise.exception_events DROP CONSTRAINT %I', cname);

  ALTER TABLE enterprise.exception_events ADD CONSTRAINT exception_events_exception_type_check
  CHECK (exception_type = ANY (ARRAY[
    'eta_delay','traffic_impact','driver_no_show','driver_offline',
    'driver_location_mismatch','dock_conflict','compliance_zone_breach',
    'locker_pickup_expired','tender_withdrawn','tender_no_quotes',
    'returns_pickup_failed','rts_warehouse_unreachable','invoice_discrepancy',
    'invoice_audit_deadline_expired','rest_violation',
    'border_crossing_compliance_breach','range_anxiety_breach',
    'csrd_data_quality_breach','rule_violation',
    'trip_count_reconciliation_mismatch'
  ]::text[]));
END $$;

DO $$
BEGIN
  RAISE NOTICE 'exception_events trip_count_reconciliation_mismatch eklendi (ADR-CE-04 B.2)';
END $$;

-- Down migration (elle calistirilmali — tabloda bu tipte satir varsa once onlar temizlenmeli):
-- ALTER TABLE enterprise.exception_events DROP CONSTRAINT exception_events_exception_type_check;
-- ALTER TABLE enterprise.exception_events ADD CONSTRAINT exception_events_exception_type_check
--   CHECK (exception_type = ANY (ARRAY[
--     'eta_delay','traffic_impact','driver_no_show','driver_offline',
--     'driver_location_mismatch','dock_conflict','compliance_zone_breach',
--     'locker_pickup_expired','tender_withdrawn','tender_no_quotes',
--     'returns_pickup_failed','rts_warehouse_unreachable','invoice_discrepancy',
--     'invoice_audit_deadline_expired','rest_violation',
--     'border_crossing_compliance_breach','range_anxiety_breach',
--     'csrd_data_quality_breach','rule_violation']::text[]));
