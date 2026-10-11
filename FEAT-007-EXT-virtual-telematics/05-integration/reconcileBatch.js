/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/reconcileBatch.js
 * GPS ve Sayaç Mutabakatı Otomatik Batch Motoru (Idempotent)
 *
 * Sorumluluk: TÜM şirketlerin, cihazı bağlı araçlarının son iki dolum
 * periyodunu PostGIS ile tarar, sapma %5'i aşarsa mükerrer kontrolü yaparak
 * alerts hipertablosuna yazar.
 *
 * 11 Ekim 2026 — Multi-tenant genelleştirme: Cihaz listesi başlangıçta
 * hardcoded `DOBBE_DEVICES = ["DEMO-ESP-002", ...]` idi (tek demo/pilot
 * şirkete sabitlenmişti). Artık `listActiveDeviceIds()` ile cihazı bağlı
 * TÜM araçlar (hangi şirkete ait olursa olsun) dinamik olarak taranıyor.
 * Alert insert zaten her araç için kendi gerçek company_id'sini DB'den
 * okuyup yazıyordu (bu kısım hiç hardcoded değildi) — değişmedi.
 *
 * Test edilebilirlik için `runReconcileBatch(client, options)` DB client'ı
 * dışarıdan enjekte eder. `main()` gerçek pg.Client + .env ile bu fonksiyonu
 * çağıran ince bir CLI/cron sarmalayıcıdır.
 *
 * ÇALIŞTIRMA (manuel, tek seferlik):
 *   cd .../FEAT-007-EXT-virtual-telematics/05-integration
 *   node reconcileBatch.js
 * Üretimde server.js içindeki günlük 02:00 zamanlayıcısı üzerinden otomatik
 * tetikleniyor (bkz. FEAT-007-EXT-virtual-telematics/06-cron).
 */

const { reconcileGpsMeters } = require("../03-logic/reconcileGpsMeters");

const DEFAULT_DEVIATION_THRESHOLD = 0.05;

/**
 * Cihazı (esp32_device_id) bağlı TÜM araçların cihaz ID'lerini döner.
 * company_id filtresi YOK — hangi şirkete ait olursa olsun, telemetri
 * bağlı her araç mutabakat taramasına girer.
 */
async function listActiveDeviceIds(client) {
  const { rows } = await client.query(
    `SELECT esp32_device_id FROM public.vehicles
     WHERE esp32_device_id IS NOT NULL
     ORDER BY esp32_device_id`
  );
  return rows.map((r) => r.esp32_device_id);
}

/**
 * Tek bir cihaz için GPS/odometer mutabakatını işler (sorgu + karar +
 * idempotency + alert insert). Dönen değer sadece loglama/test amaçlı özet.
 */
async function reconcileOneDevice(client, deviceId, deviationThreshold) {
  const postGisQuery = `
    WITH last_two_fuel_records AS (
        SELECT
            vehicle_id,
            odometer_km,
            record_date::timestamp with time zone as fill_time,
            LAG(odometer_km) OVER (PARTITION BY vehicle_id ORDER BY record_date ASC, odometer_km ASC) as prev_odometer_km,
            LAG(record_date::timestamp with time zone) OVER (PARTITION BY vehicle_id ORDER BY record_date ASC, odometer_km ASC) as prev_fill_time
        FROM public.fuel_records
        WHERE vehicle_id = (SELECT id FROM public.vehicles WHERE esp32_device_id = $1 LIMIT 1)
        ORDER BY record_date DESC, odometer_km DESC
        LIMIT 1
    ),
    ordered_locations AS (
        SELECT
            l.device_id,
            l."time",
            ST_SetSRID(ST_MakePoint(l.longitude, l.latitude), 4326) as geom,
            LAG(ST_SetSRID(ST_MakePoint(l.longitude, l.latitude), 4326)) OVER (PARTITION BY l.device_id ORDER BY l."time") as prev_geom,
            f.odometer_km - f.prev_odometer_km as odo_actual_km,
            f.fill_time,
            f.vehicle_id
        FROM public.locations l
        JOIN public.vehicles v ON v.esp32_device_id = l.device_id
        JOIN last_two_fuel_records f ON f.vehicle_id = v.id
        WHERE l.device_id = $1
          AND l."time" >= f.prev_fill_time
          AND l."time" <= f.fill_time
    )
        SELECT
        device_id,
        vehicle_id,
        COUNT(*) as total_breadcrumbs,
        MAX(fill_time) as last_fill_time,
        ROUND((SUM(ST_DistanceSphere(geom, prev_geom)) / 1000.0)::numeric, 2)::float as gps_haversine_km,
        ROUND(MAX(odo_actual_km)::numeric, 2)::float as odo_actual_km
    FROM ordered_locations
    WHERE prev_geom IS NOT NULL
    GROUP BY device_id, vehicle_id;
  `;

  const geoRes = await client.query(postGisQuery, [deviceId]);
  if (geoRes.rows.length === 0) {
    return { deviceId, status: "skipped_no_data" };
  }

  const { vehicle_id, gps_haversine_km, odo_actual_km, last_fill_time } =
    geoRes.rows[0];

  const rec = reconcileGpsMeters({
    odometerDelta: odo_actual_km,
    gpsHaversineDistance: gps_haversine_km,
    allowedDeviationThreshold: deviationThreshold,
  });

  if (!rec.triggerAlert) {
    return { deviceId, status: "clean", deviationRate: rec.deviationRate };
  }

  const duplicateCheckQuery = `
    SELECT id FROM public.alerts
    WHERE alert_type = 'gps_odometer_deviation'
      AND vehicle_id = $1
      AND (metadata->>'last_fill_time') = $2
    LIMIT 1;
  `;
  const dupRes = await client.query(duplicateCheckQuery, [
    vehicle_id,
    last_fill_time.toISOString(),
  ]);

  if (dupRes.rows.length > 0) {
    return { deviceId, status: "duplicate_skipped" };
  }

  const vehicleInfo = await client.query(
    "SELECT company_id, plate_no FROM public.vehicles WHERE id = $1",
    [vehicle_id]
  );
  const { company_id, plate_no } = vehicleInfo.rows[0];
  const deviationPercent = (rec.deviationRate * 100).toFixed(2);

  const title = "GPS Sayaç Sapma Uyarısı";
  const description = `${plate_no} plakalı aracın GPS mesafesi ${gps_haversine_km} km, odometer mesafesi ${odo_actual_km} km ölçülmüştür. Sapma %${deviationPercent} olduğundan Odometer baz alınmıştır.`;

  const metadata = JSON.stringify({
    gps_km: gps_haversine_km,
    odo_km: odo_actual_km,
    deviation_rate: rec.deviationRate,
    reconciled_km: rec.reconciledDistanceKm,
    last_fill_time: last_fill_time.toISOString(),
  });

  const insertAlert = `
    INSERT INTO public.alerts (
      alert_type, severity, device_id, vehicle_id, company_id,
      title, description, metadata, is_resolved, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW())
    RETURNING id;
  `;

  const alertRes = await client.query(insertAlert, [
    "gps_odometer_deviation",
    "warning",
    deviceId,
    vehicle_id,
    company_id,
    title,
    description,
    metadata,
  ]);

  return {
    deviceId,
    status: "alert_created",
    alertId: alertRes.rows[0].id,
    plateNo: plate_no,
    deviationRate: rec.deviationRate,
  };
}

/**
 * Tüm aktif cihazlar için GPS/odometer mutabakat taramasını çalıştırır.
 * Tek bir transaction içinde (idempotent — mükerrer alert korumalı).
 *
 * @param {Object} client - pg client (dışarıdan enjekte edilir, testability)
 * @param {Object} [options]
 * @param {number} [options.deviationThreshold] - İzin verilen max sapma (default 0.05)
 * @returns {Promise<{processed:number, results:Array}>}
 */
async function runReconcileBatch(client, options = {}) {
  const deviationThreshold =
    options.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD;

  const deviceIds = await listActiveDeviceIds(client);

  await client.query("BEGIN;");
  const results = [];
  try {
    for (const deviceId of deviceIds) {
      const result = await reconcileOneDevice(
        client,
        deviceId,
        deviationThreshold
      );
      results.push(result);
    }
    await client.query("COMMIT;");
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  }

  return { processed: results.length, results };
}

async function main() {
  const { Client } = require("pg");
  const path = require("path");
  require("dotenv").config({ path: path.join(__dirname, "../../.env") });

  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env Error] DATABASE_URL bulunamadı.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(
    "🚀 [Sütun 2 Batch] Fleetadmin yetkisiyle mutabakat motoru başlatıldı (tüm şirketler)."
  );

  try {
    const { processed, results } = await runReconcileBatch(client);
    console.log(`\n🔍 ${processed} cihaz tarandı:\n`);
    for (const r of results) {
      if (r.status === "alert_created") {
        console.log(
          `  ⚠️  ${r.deviceId} (${r.plateNo}) — yeni sapma uyarısı. ID: ${r.alertId}`
        );
      } else if (r.status === "clean") {
        console.log(`  ✅ ${r.deviceId} — mutabakat temiz.`);
      } else if (r.status === "duplicate_skipped") {
        console.log(
          `  🛡️  ${r.deviceId} — bu periyodun uyarısı zaten mevcut, mükerrer engellendi.`
        );
      } else {
        console.log(
          `  ℹ️  ${r.deviceId} — yeterli lokasyon/dolum periyodu yok, pas geçildi.`
        );
      }
    }
    console.log(
      "\n🏁 [Batch Done] Tüm araçların mutabakat taraması başarıyla mühürlendi!"
    );
  } catch (error) {
    console.error("❌ [Batch Crashed] İşlemler geri alındı:", error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

module.exports = {
  runReconcileBatch,
  listActiveDeviceIds,
  reconcileOneDevice,
  DEFAULT_DEVIATION_THRESHOLD,
};

if (require.main === module) {
  main();
}
