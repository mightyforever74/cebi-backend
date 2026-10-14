-- FEAT-018 FN-13 monitorRmaSla — additive migration.
--
-- Gatekeeping bulgusu (Cem onaylı, 2026-10-14): enterprise.exception_events
-- (migrations/1782600000000_create-enterprise-exception-events.sql) sadece
-- task_id (FK dispatch_tasks) tutuyor; RMA SLA ihlallerini güvenilir şekilde
-- dedup etmek için rma_id gerekiyor (task_id RMA akışında opsiyonel/paylaşılan
-- olabilir). Ayrıca exception_type CHECK constraint'inde "rma_sla_breach" yok.
--
-- Bu migration: (1) rma_id UUID kolonu ekler (enterprise.rma_requests'e FK,
-- ON DELETE SET NULL — exception_events bir hypertable, RMA silinse bile
-- geçmiş exception kaydı kaybolmamalı); (2) exception_type CHECK'i
-- 'rma_sla_breach' değerini de kapsayacak şekilde genişletir.
--
-- DÜZELTME (staging'deki ilk deneme sonrası, 2026-10-14): exception_type
-- CHECK'i yalnızca create-migration'daki (1782600000000) 18 değeri temel
-- alınarak yazılmıştı. Ancak migrations/1782800000000_bug1-overlap-foundation.sql
-- bu constraint'i daha sonra 19. bir değerle ('rule_violation', BUG-1
-- cascade-delay monitörü) genişletmiş — bu, aşağıdaki listeye dahil
-- edilmezse, o değeri taşıyan mevcut satırlarda constraint ihlaline yol
-- açıyordu (nitekim staging'de oldu). Liste artık her iki migration'ın
-- birleşimi (19 + rma_sla_breach = 20 değer).

ALTER TABLE enterprise.exception_events
  ADD COLUMN IF NOT EXISTS rma_id UUID REFERENCES enterprise.rma_requests(id) ON DELETE SET NULL;

COMMENT ON COLUMN enterprise.exception_events.rma_id IS
  'FEAT-018 FN-13 monitorRmaSla: RMA SLA ihlali exception''larını enterprise.rma_requests''e bağlar. Nullable — diğer exception_type''lar için kullanılmaz.';

DO $$
BEGIN
  ALTER TABLE enterprise.exception_events DROP CONSTRAINT IF EXISTS exception_events_exception_type_check;
  ALTER TABLE enterprise.exception_events ADD CONSTRAINT exception_events_exception_type_check
    CHECK (exception_type IN (
      'eta_delay','traffic_impact','driver_no_show',
      'driver_offline','driver_location_mismatch',
      'dock_conflict','compliance_zone_breach',
      'locker_pickup_expired','tender_withdrawn','tender_no_quotes',
      'returns_pickup_failed','rts_warehouse_unreachable',
      'invoice_discrepancy','invoice_audit_deadline_expired',
      'rest_violation','border_crossing_compliance_breach',
      'range_anxiety_breach','csrd_data_quality_breach','rule_violation',
      'rma_sla_breach'
    ));
  RAISE NOTICE 'exception_events.exception_type CHECK constraint rma_sla_breach ile genisletildi.';
END $$;