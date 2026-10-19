"use strict";

/**
 * hydrateVehiclesForRouting, Faz A-3 (Gerçek HERE Tour Planning Entegrasyonu)
 * portu. Kaynak: tulipfleet-enterprise-backend/lib/routing/
 * hydrateVehiclesForRouting.js, BİREBİR (saf fonksiyon, DB şeması cebi-backend'de
 * de aynı: public.vehicles.cargo_capacity_volume_m3/cargo_capacity_weight_kg/
 * hazmat_certified_classes, migrations/1783400000000_feat020-vehicle-cargo-
 * capacity.sql; public.vehicles.esp32_device_id + public.locations(device_id,
 * latitude, longitude, "time"), routes/dispatcherLocations.js'in ZATEN
 * ÇALIŞAN sorgusuyla doğrulandı, kod okunarak port öncesi kontrol edildi).
 *
 * Gerçek üretim kontratı (cebi-dispatcher src/hooks/useTaskOptimization.ts)
 * `vehicles: string[]`, yalnızca araç ID string'leri gönderiyor,
 * konum/kapasite/vardiya hiç yok. Aracın güncel konumu esp32_device_id
 * üzerinden public.locations'taki en güncel pinge bakılarak türetiliyor.
 *
 * Graceful Degradation: hiç telemetri pingi olmayan veya company'ye ait
 * olmayan/bulunamayan araçlar sessizce routing dışı bırakılır, sahte/
 * varsayılan konum asla uydurulmaz. Çağıran, skippedVehicleIds ile hangi
 * araçların dışarıda kaldığını görür.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * @param {{query: Function}} db
 * @param {string} companyId
 * @param {string[]} vehicleIds
 * @returns {Promise<{vehicles: Array<Object>, skippedVehicleIds: string[]}>}
 */
async function hydrateVehiclesForRouting(db, companyId, vehicleIds) {
  if (!companyId) {
    throw new ValidationError("companyId is required.");
  }
  if (!Array.isArray(vehicleIds)) {
    throw new ValidationError("vehicleIds must be an array.");
  }
  if (vehicleIds.length === 0) {
    return { vehicles: [], skippedVehicleIds: [] };
  }

  const result = await db.query(
    `SELECT v.id, v.cargo_capacity_volume_m3, v.cargo_capacity_weight_kg,
            v.hazmat_certified_classes, loc.latitude, loc.longitude
       FROM public.vehicles v
       LEFT JOIN LATERAL (
         SELECT latitude, longitude FROM public.locations
          WHERE device_id = v.esp32_device_id
          ORDER BY "time" DESC
          LIMIT 1
       ) loc ON true
      WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`,
    [companyId, vehicleIds]
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));

  const vehicles = [];
  const skippedVehicleIds = [];

  for (const vehicleId of vehicleIds) {
    const row = byId.get(vehicleId);

    if (!row || row.latitude == null || row.longitude == null) {
      skippedVehicleIds.push(vehicleId);
      continue;
    }

    vehicles.push({
      id: row.id,
      start_location: { lat: Number(row.latitude), lng: Number(row.longitude) },
      capacity_volume_m3:
        row.cargo_capacity_volume_m3 != null ? Number(row.cargo_capacity_volume_m3) : 0,
      capacity_weight_kg:
        row.cargo_capacity_weight_kg != null ? Number(row.cargo_capacity_weight_kg) : 0,
      hazmat_classes: Array.isArray(row.hazmat_certified_classes)
        ? row.hazmat_certified_classes
        : [],
    });
  }

  return { vehicles, skippedVehicleIds };
}

module.exports = { hydrateVehiclesForRouting, ValidationError };
