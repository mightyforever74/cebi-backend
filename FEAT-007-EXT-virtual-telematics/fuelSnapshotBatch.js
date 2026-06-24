/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/fuelSnapshotBatch.js
 * Sanal Şamandıra — Reconciled Snapshot Batch (Yol A geliştirilmiş)
 *
 * KARAR (bu oturumda mühürlendi): Demo/pilot için STATİK snapshot.
 * Canlı MQTT akışı (Yol B) yok (seed bitti, fleet-sim daemon stopped).
 * "Son dolum anı illüzyonu" kör-günler mesafesiyle aşılır: en son dolumdan
 * bugüne geçen günlerde araç yol yaptı; bu gizli mesafeyi yazılımsal düşeriz.
 *
 * MANTIK:
 *  - L_start = vehicles.fuel_capacity (seed son dolum is_full_tank=true → depo full)
 *  - günlük_ort_km = (son_odo − ilk_odo) / gün_aralığı   [aracın gerçek seed verisi]
 *  - kör_mesafe = günlük_ort_km × (bugün − son_dolum_tarihi)
 *  - calculateVirtualFuelLevel(...) → currentFuelLiters
 *  - UPDATE vehicles.current_fuel_level (litre) + total_km
 *
 * Pure fonksiyon (03-logic) DEĞİŞMEDEN beslenir (Seçenek A — Odometer Core).
 * Yarın canlı MQTT gelince: bu batch yerine MQTT hook, pure fonksiyon aynı kalır.
 *
 * ÇALIŞTIRMA: sunucuda, fleetadmin .env ile
 *   cd /opt/fleet/backend-staging/FEAT-007-EXT-virtual-telematics/05-integration
 *   node fuelSnapshotBatch.js
 */

const { Client } = require("pg");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const {
  calculateVirtualFuelLevel,
} = require("../03-logic/calculateVirtualFuelLevel");

const DOBBE_COMPANY_ID = "efbaa346-cde9-489a-b3e9-6fd61df0c121";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env] DATABASE_URL bulunamadı.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("🚀 [Snapshot] Fleetadmin ile bağlanıldı.");

  try {
    // Her Dobbe aracı için snapshot girdileri (gerçek seed verisinden)
    const { rows } = await client.query(
      `SELECT
         v.id,
         v.plate_no,
         v.fuel_capacity,
         MAX(fr.record_date)                       AS son_dolum,
         (CURRENT_DATE - MAX(fr.record_date))      AS kor_gun,
         AVG(fr.consumption_per_100km)             AS ort_tuketim,
         MAX(fr.odometer_km)                       AS son_odo,
         MIN(fr.odometer_km)                       AS ilk_odo,
         NULLIF((MAX(fr.record_date) - MIN(fr.record_date)), 0) AS gun_araligi
       FROM public.fuel_records fr
       JOIN public.vehicles v ON v.id = fr.vehicle_id
       WHERE v.company_id = $1
       GROUP BY v.id, v.plate_no, v.fuel_capacity`,
      [DOBBE_COMPANY_ID]
    );

    if (rows.length === 0) {
      console.log("⚠️  Dobbe için yakıt kaydı yok, snapshot atlandı.");
      return;
    }

    console.log(`\n📊 ${rows.length} araç için sanal şamandıra hesaplanıyor:\n`);

    for (const v of rows) {
      const capacity = parseFloat(v.fuel_capacity);
      const korGun = parseInt(v.kor_gun, 10) || 0;
      const avgConsumption = parseFloat(v.ort_tuketim) || 30;
      const sonOdo = parseFloat(v.son_odo);
      const ilkOdo = parseFloat(v.ilk_odo);
      const gunAraligi = parseInt(v.gun_araligi, 10) || 1;

      // Aracın gerçek günlük ortalama km'si (seed odometer aralığından)
      const gunlukOrtKM = (sonOdo - ilkOdo) / gunAraligi;

      // Kör günler mesafesi (son dolumdan bugüne)
      const korMesafe = gunlukOrtKM * korGun;

      // Pure fonksiyon (Seçenek A): L_start = kapasite (is_full_tank)
      const { currentFuelLiters, percentage } = calculateVirtualFuelLevel({
        litersAtLastFill: capacity,
        kmSinceLastFill: korMesafe,
        avgConsumption: avgConsumption,
        fuelCapacity: capacity,
      });

      // Sanal güncel odometer = son dolum odometer + kör mesafe
      const virtualTotalKM = Math.round(sonOdo + korMesafe);

      await client.query(
        `UPDATE public.vehicles
         SET current_fuel_level = $1, total_km = $2, updated_at = NOW()
         WHERE id = $3`,
        [currentFuelLiters, virtualTotalKM, v.id]
      );

      console.log(
        `  ${v.plate_no.padEnd(10)} | kör ${korGun}g × ${gunlukOrtKM.toFixed(
          0
        )}km/g = ${korMesafe.toFixed(0)}km | ` +
          `tüketim ${avgConsumption.toFixed(1)} | → ${currentFuelLiters}L (%${percentage}) | total_km ${virtualTotalKM}`
      );
    }

    console.log("\n🏁 [Success] Sanal şamandıra snapshot'ı mühürlendi.");
  } catch (err) {
    console.error("❌ [Snapshot Crashed]:", err.message);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
