/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/fuelSnapshotBatch.js
 * Sanal Şamandıra — Reconciled Snapshot Batch (Yol A geliştirilmiş)
 *
 * 11 Ekim 2026 — Multi-tenant genelleştirme: Bu script başlangıçta TEK bir
 * demo/pilot şirkete (Dobbe, DOBBE_COMPANY_ID) sabitlenmişti ("Demo/pilot
 * için STATİK snapshot" kararı). Cem'in kararıyla artık TÜM şirketler için
 * çalışan, cron ile periyodik tetiklenen gerçek bir production feature'a
 * dönüştürüldü: company_id filtresi kaldırıldı, sorgu tüm fuel_records'u
 * (hangi şirkete ait olursa olsun) tarar.
 *
 * MANTIK (değişmedi):
 *  - L_start = vehicles.fuel_capacity (son dolum is_full_tank=true → depo full)
 *  - günlük_ort_km = (son_odo − ilk_odo) / gün_aralığı   [aracın gerçek seed verisi]
 *  - kör_mesafe = günlük_ort_km(capli) × kör_gün(capli)
 *  - calculateVirtualFuelLevel(...) → currentFuelLiters
 *  - UPDATE vehicles.current_fuel_level (litre)  [total_km BİLEREK yazılmaz]
 *
 * KALİBRASYON: Seed odometer aralıkları küçük olduğundan ham günlük km
 * anomalik çıkabiliyor (örn. 3000+ km/gün). İki cap ile makul lojistik
 * sınırına çekilir. Cap'ler .env'den ayarlanabilir (default 450 km/gün, 5 gün):
 *   FUEL_CAP_KM_PER_DAY, FUEL_CAP_BLIND_DAYS
 * total_km YAZILMAZ: capli kör mesafe yine odometre'yi saptıracağından, km
 * mevcut değerinde dürüstçe sabit bırakılır.
 *
 * Test edilebilirlik için `runFuelSnapshotBatch(client, options)` DB client'ı
 * dışarıdan enjekte eder (routes/alertsHelpers.js presedenti). `main()` gerçek
 * pg.Client + .env ile bu fonksiyonu çağıran ince bir CLI/cron sarmalayıcıdır.
 *
 * ÇALIŞTIRMA (manuel, tek seferlik): sunucuda, fleetadmin .env ile
 *   cd .../FEAT-007-EXT-virtual-telematics/05-integration
 *   node fuelSnapshotBatch.js
 * Üretimde artık server.js içindeki günlük 02:00 zamanlayıcısı üzerinden
 * otomatik tetikleniyor (bkz. FEAT-007-EXT-virtual-telematics/06-cron).
 */

const {
  calculateVirtualFuelLevel,
} = require("../03-logic/calculateVirtualFuelLevel");

const DEFAULT_CAP_KM_PER_DAY = 450;
const DEFAULT_CAP_BLIND_DAYS = 5;

const FUEL_SNAPSHOT_QUERY = `
  SELECT
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
   GROUP BY v.id, v.plate_no, v.fuel_capacity
`;

/**
 * Tüm şirketlerin araçları için sanal şamandıra snapshot'ını hesaplar ve
 * vehicles.current_fuel_level'ı günceller. company_id filtresi YOK —
 * fuel_records'u olan her araç (hangi şirkete ait olursa olsun) işlenir.
 *
 * @param {Object} client - pg client (dışarıdan enjekte edilir, testability)
 * @param {Object} [options]
 * @param {number} [options.capKmPerDay] - Günlük km tavanı (default 450)
 * @param {number} [options.capBlindDays] - Kör gün tavanı (default 5)
 * @returns {Promise<{processed:number, results:Array}>}
 */
async function runFuelSnapshotBatch(client, options = {}) {
  const capKmPerDay = Number(options.capKmPerDay) || DEFAULT_CAP_KM_PER_DAY;
  const capBlindDays = Number(options.capBlindDays) || DEFAULT_CAP_BLIND_DAYS;

  const { rows } = await client.query(FUEL_SNAPSHOT_QUERY);

  const results = [];

  for (const v of rows) {
    const capacity = parseFloat(v.fuel_capacity);
    const korGun = parseInt(v.kor_gun, 10) || 0;
    const avgConsumption = parseFloat(v.ort_tuketim) || 30;
    const sonOdo = parseFloat(v.son_odo);
    const ilkOdo = parseFloat(v.ilk_odo);
    const gunAraligi = parseInt(v.gun_araligi, 10) || 1;

    const gunlukOrtKMRaw = (sonOdo - ilkOdo) / gunAraligi;
    const gunlukOrtKM = Math.min(capKmPerDay, gunlukOrtKMRaw || 200);

    const korGunCapped = Math.min(capBlindDays, korGun);
    const korMesafe = gunlukOrtKM * korGunCapped;

    const { currentFuelLiters, percentage } = calculateVirtualFuelLevel({
      litersAtLastFill: capacity,
      kmSinceLastFill: korMesafe,
      avgConsumption,
      fuelCapacity: capacity,
    });

    // total_km BİLEREK yazılmaz (capli mesafe yine odometre'yi saptırır).
    await client.query(
      `UPDATE public.vehicles
       SET current_fuel_level = $1, updated_at = NOW()
       WHERE id = $2`,
      [currentFuelLiters, v.id]
    );

    results.push({
      vehicleId: v.id,
      plateNo: v.plate_no,
      korGunCapped,
      gunlukOrtKM,
      korMesafe,
      currentFuelLiters,
      percentage,
    });
  }

  return { processed: results.length, results };
}

async function main() {
  const { Client } = require("pg");
  const path = require("path");
  require("dotenv").config({ path: path.join(__dirname, "../../.env") });

  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env] DATABASE_URL bulunamadı.");
    process.exit(1);
  }

  const capKmPerDay =
    parseInt(process.env.FUEL_CAP_KM_PER_DAY, 10) || DEFAULT_CAP_KM_PER_DAY;
  const capBlindDays =
    parseInt(process.env.FUEL_CAP_BLIND_DAYS, 10) || DEFAULT_CAP_BLIND_DAYS;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("🚀 [Snapshot] Fleetadmin ile bağlanıldı (tüm şirketler).");
  console.log(
    `⚙️  Cap: ${capKmPerDay} km/gün, ${capBlindDays} kör gün (.env ile ayarlanabilir)`
  );

  try {
    const { processed, results } = await runFuelSnapshotBatch(client, {
      capKmPerDay,
      capBlindDays,
    });

    if (processed === 0) {
      console.log("⚠️  Hiçbir araç için yakıt kaydı yok, snapshot atlandı.");
      return;
    }

    console.log(`\n📊 ${processed} araç için sanal şamandıra hesaplandı:\n`);
    for (const r of results) {
      console.log(
        `  ${r.plateNo.padEnd(10)} | kör ${
          r.korGunCapped
        }g × ${r.gunlukOrtKM.toFixed(0)}km/g = ${r.korMesafe.toFixed(
          0
        )}km | → ${r.currentFuelLiters}L (%${r.percentage})`
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

module.exports = {
  runFuelSnapshotBatch,
  DEFAULT_CAP_KM_PER_DAY,
  DEFAULT_CAP_BLIND_DAYS,
  FUEL_SNAPSHOT_QUERY,
};

if (require.main === module) {
  main();
}
