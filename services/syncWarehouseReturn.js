"use strict";

/**
 * services/syncWarehouseReturn.js
 *
 * FEAT-018 FN-14 syncWarehouseReturn — "in_transit -> warehouse_received"
 * state transition (spec: docs/functions/FEAT-018-reverse-logistics-handling.md
 * (v2) §2 durum geçiş tablosu, §5.1 WMS adapter prensibi).
 *
 * Tetikleyici: araç bir depo geofence'ine girer ("Otomatik, geofence-tetikli").
 * Spec'in kendi notu: "11 Ekim'de kapanan v2-contract geofenceService.js
 * paterniyle aynı disiplin (tek yetkili merci, legacy path yok)" — bu yüzden
 * bu fonksiyon services/geofenceService.js'in handleGeofenceEvent'inden,
 * "9b. Waypoint auto-visit" adımıyla aynı yerde/disiplinde (entry-only,
 * best-effort, try/catch) çağrılır; ayrı bir legacy/duplicate tetikleyici yok.
 *
 * Mimari not (cross-repo): enterprise.rma_requests, enterprise-backend
 * deployment'ının şeması ama aynı fiziksel Postgres DB'de (27 Eylül cutover'dan
 * beri) — iki backend ayrı Docker container olduğu için enterprise-backend'in
 * lib/ dosyaları buradan require() edilemez. Core'un "tasks" tablosu zaten
 * enterprise.dispatch_tasks'a FK'li olduğundan cross-schema SQL kanıtlı bir
 * desen; bu fonksiyon da aynı şekilde doğrudan SQL ile çalışır.
 *
 * Kapsam (YAGNI, spec §5.1): TulipFleet kendi WMS'ini yazmaz, sadece
 * enterprise.rma_requests.status günceller — gerçek WMS'e (SAP EWM vb.)
 * bildirim, FEAT-108 (ayrı, customer-funded, henüz spec yok) adapter
 * katmanının işi. Bu fonksiyon o adapter'ı çağırmaz/simüle etmez.
 *
 * appendAuditEntry burada KASITLI OLARAK kopyalanmıştır (enterprise-backend'in
 * lib/auditLog.js'inin aynısı, spec §5.3 append-only sözleşmesi) — iki ayrı
 * deployment arasında bir node_modules paketi paylaşılamadığı için. Tek
 * satırlık saf bir fonksiyon olduğundan drift riski düşük.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function appendAuditEntry(existingLog, entry) {
  const safeLog = Array.isArray(existingLog) ? existingLog : [];
  return [...safeLog, entry]; // asla mutate etme, asla eski entry silme
}

/**
 * @param {{query: Function}} client - zaten baglanti kurulmus pg client/pool
 * @param {string} companyId
 * @param {string} vehicleId
 * @param {string} geofenceId - girilen bolgenin public.geofences.id'si
 * @returns {Promise<{id: string, status: string}|null>}
 */
async function syncWarehouseReturn(client, companyId, vehicleId, geofenceId) {
  if (!companyId || !vehicleId || !geofenceId) {
    throw new ValidationError("companyId, vehicleId and geofenceId are all required.");
  }

  // 1. Bu geofence gercekten bir depoya mi ait? (her geofence-entry bir
  // depo donusu degil — Graceful Degradation: eslesme yoksa sessizce no-op)
  const warehouseRes = await client.query(
    `SELECT id FROM public.warehouses
      WHERE geofence_id = $1 AND company_id = $2 AND is_active = true
      LIMIT 1`,
    [geofenceId, companyId]
  );
  if (warehouseRes.rows.length === 0) {
    return null;
  }
  const warehouseId = warehouseRes.rows[0].id;

  // 2. Bu aracin tasidigi, hala yolda (in_transit) olan bir RMA var mi?
  const rmaRes = await client.query(
    `SELECT r.id, r.audit_log
       FROM enterprise.rma_requests r
       JOIN enterprise.dispatch_tasks t ON t.id = r.task_id
      WHERE r.company_id = $1
        AND r.status = 'in_transit'
        AND t.assigned_vehicle_id = $2
      LIMIT 1`,
    [companyId, vehicleId]
  );
  if (rmaRes.rows.length === 0) {
    return null;
  }
  const rmaId = rmaRes.rows[0].id;
  const updatedAuditLog = appendAuditEntry(rmaRes.rows[0].audit_log, {
    event: "warehouse_received",
    warehouse_id: warehouseId,
    vehicle_id: vehicleId,
    at: new Date().toISOString(),
  });

  // 3. Gecis — optimistic guard (WHERE status = 'in_transit'): araya baska
  // bir tetikleyici girip durumu degistirmisse (race condition), 0 satir
  // etkilenir ve bu fonksiyon sessizce null doner (yeniden deneme yok —
  // cagiran log'lamak isterse rmaId zaten elinde degil, bu kasitli: bir
  // sonraki geofence-entry veya manuel dispatcher aksiyonu devreye girer).
  const updateRes = await client.query(
    `UPDATE enterprise.rma_requests
        SET status = 'warehouse_received',
            warehouse_id = $1,
            audit_log = $2::jsonb,
            updated_at = NOW()
      WHERE id = $3 AND status = 'in_transit'
      RETURNING id, status`,
    [warehouseId, JSON.stringify(updatedAuditLog), rmaId]
  );
  if (updateRes.rows.length === 0) {
    return null;
  }

  return { id: updateRes.rows[0].id, status: updateRes.rows[0].status };
}

module.exports = { syncWarehouseReturn, ValidationError };
