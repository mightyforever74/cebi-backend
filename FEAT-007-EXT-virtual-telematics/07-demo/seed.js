/**
 * FEAT-007-EXT-virtual-telematics / 07-demo/seed.js
 * Sanal Telemetri Temel Seed Jeneratörü - v1.2 (Database Authority Approved)
 *
 * Sorumluluk: Dobbe firması için 180 günlük kronolojik locations,
 * fuel_records (fuel.js formülüyle dolu) ve driver_behavior agregat
 * sayaçlarını üretir.
 *
 * KANITLANMIŞ GERÇEKLER (bu betik bunlara dayanır):
 *  - locations/driver_behavior: ts_insert_blocker yetim trigger'ı staging'de
 *    KALDIRILDI (schema-only kopya artığı). Düz tablo gibi yazılır.
 *  - fleetadmin yetkisi ŞART (public tablolar, enterprise_backend yazamaz).
 *  - eco_score/safety_score = numeric(3,2) => MAX 9.99. Skorlar 0.00-1.00 ölçek.
 *  - driver_behavior'da company_id YOK; izolasyon driver_id üzerinden.
 *  - locations.device_id = vehicles.esp32_device_id.
 *  - Üç zaman kolonu (time, timestamp, created_at) senkron yazılır.
 *  - fuel_records consumption fuel.js formülüyle: (liters/km)*100, 1-30 aralığı.
 *
 * ÇALIŞTIRMA: sunucuda, /opt/fleet/backend-staging/FEAT-.../07-demo/ altında
 *   cd /opt/fleet/backend-staging/FEAT-007-EXT-virtual-telematics/07-demo
 *   node seed.js
 */

const { Client } = require("pg");
const path = require("path");

// Güvenli mutlak .env (betiğin kendi konumuna göre, cwd'den bağımsız)
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Dobbe Gerçek Kimlik Matrisi (DB'den kanıtlanmış, FK-uyumlu) ──
// İlk 3: düzenli demo-seed araçları (driver→vehicle→device zinciri net).
// 4.: gerçek-rastgele UUID'li araç (GV-082-B), kendi gerçek eşleşmesiyle.
const DOBBE_FLEET_MATRIX = [
  {
    driver_id: "d1d2d3d4-e5f6-7890-abcd-ef0000000001",
    vehicle_id: "b1b2b3b4-e5f6-7890-abcd-ef0000000001",
    device_id: "DEMO-ESP-002",
    style: "aggressive",
  },
  {
    driver_id: "d1d2d3d4-e5f6-7890-abcd-ef0000000002",
    vehicle_id: "b1b2b3b4-e5f6-7890-abcd-ef0000000002",
    device_id: "DEMO-ESP-003",
    style: "eco-friendly",
  },
  {
    driver_id: "d1d2d3d4-e5f6-7890-abcd-ef0000000003",
    vehicle_id: "b1b2b3b4-e5f6-7890-abcd-ef0000000003",
    device_id: "DEMO-ESP-004",
    style: "balanced",
  },
  {
    driver_id: "29504754-0ab6-4e5a-b71d-fe4558369c88",
    vehicle_id: "5ad2dd21-d0ad-4b4a-a48b-b04fb6e3e4a5",
    device_id: "14C046D4DB1C",
    style: "standard",
  },
];

// Benelüks bounding box (mantıklı koordinat kafesi)
const NL_BOUNDS = { latMin: 51.5, latMax: 53.0, lngMin: 4.5, lngMax: 6.5 };

const DAYS_BACK = 180;
const FUEL_PRICE_PER_LITER = 1.75; // EUR, staging sabit

// Stile göre temel tüketim (L/100km), fuel.js sağlık aralığı 1-30 İÇİNDE kalmalı
const CONSUMPTION_BY_STYLE = {
  aggressive: 29.5, // savurgan ama <30 (fuel.js reddetmesin)
  "eco-friendly": 24.0,
  balanced: 27.0,
  standard: 28.0,
};

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env] DATABASE_URL bulunamadı (mutlak yol denetimi).");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("🚀 [Seed] Fleetadmin ile staging DB'ye bağlanıldı.");

  // Her aracın zaman tünelindeki durumu (kronolojik state)
  const fleetState = DOBBE_FLEET_MATRIX.map((node) => ({
    ...node,
    currentOdometer: 120000 + randInt(0, 50000),
    lastFuelOdometer: null, // ilk dolumda set edilir
    daysSinceLastFuel: randInt(0, 3),
    currentLat: rand(NL_BOUNDS.latMin, NL_BOUNDS.latMax),
    currentLng: rand(NL_BOUNDS.lngMin, NL_BOUNDS.lngMax),
  }));

  let locCount = 0,
    fuelCount = 0,
    behCount = 0;

  try {
    await client.query("BEGIN;");
    console.log("📝 [Trx] Veri göçü transaksiyonu başladı.");

    // 180 gün geriden bugüne (kronoloji fuel consumption hesabı İÇİN; Timescale değil)
    for (let day = DAYS_BACK; day >= 0; day--) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - day);
      const dateString = targetDate.toISOString().split("T")[0];

      for (const v of fleetState) {
        // ── 1. Günlük GPS breadcrumb serisi + mesafe ──
        const dailyTrips = randInt(2, 4);
        let dailyKM = 0;

        for (let t = 0; t < dailyTrips; t++) {
          // Mantıklı koordinat kayması, kafes taşma koruması
          v.currentLat += (Math.random() - 0.5) * 0.08;
          v.currentLng += (Math.random() - 0.5) * 0.08;
          if (v.currentLat < NL_BOUNDS.latMin) v.currentLat = NL_BOUNDS.latMin + 0.1;
          if (v.currentLat > NL_BOUNDS.latMax) v.currentLat = NL_BOUNDS.latMax - 0.1;
          if (v.currentLng < NL_BOUNDS.lngMin) v.currentLng = NL_BOUNDS.lngMin + 0.1;
          if (v.currentLng > NL_BOUNDS.lngMax) v.currentLng = NL_BOUNDS.lngMax - 0.1;

          const speed = randInt(55, 90);
          const tripKM = randInt(30, 100);
          dailyKM += tripKM;
          v.currentOdometer += tripKM;

          // Breadcrumb'ı gün içine yay (saat farkıyla, sıralı görünsün)
          const ts = new Date(targetDate);
          ts.setHours(8 + t * 3, randInt(0, 59), randInt(0, 59), 0);

          await client.query(
            `INSERT INTO public.locations
               (device_id, latitude, longitude, speed, "time", "timestamp", created_at)
             VALUES ($1, $2, $3, $4, $5, $5, $5)`,
            [
              v.device_id,
              v.currentLat.toFixed(7),
              v.currentLng.toFixed(7),
              speed,
              ts,
            ]
          );
          locCount++;
        }

        // ── 2. Günlük davranış agregat sayaçları (stile göre) ──
        let harshBrakes = 0,
          harshAccels = 0,
          overSpeeds = 0,
          idleMinutes = randInt(5, 20);

        if (v.style === "aggressive") {
          harshBrakes = randInt(2, 6);
          harshAccels = randInt(2, 7);
          overSpeeds = randInt(1, 4);
          idleMinutes += randInt(10, 30);
        } else if (v.style === "eco-friendly") {
          harshBrakes = Math.random() < 0.15 ? 1 : 0;
          harshAccels = Math.random() < 0.15 ? 1 : 0;
          overSpeeds = 0;
          idleMinutes = randInt(2, 8);
        } else {
          // balanced / standard
          harshBrakes = Math.random() < 0.4 ? randInt(0, 2) : 0;
          harshAccels = Math.random() < 0.5 ? randInt(0, 2) : 0;
          overSpeeds = Math.random() < 0.2 ? 1 : 0;
        }

        // KRİTİK: eco_score/safety_score numeric(3,2) => MAX 9.99. 0.00-1.00 ölçek.
        // İhlal arttıkça skor düşer (1.00 mükemmel, 0.00 kötü).
        const penalty = harshBrakes * 0.06 + harshAccels * 0.05 + overSpeeds * 0.08;
        const safetyScore = Math.max(0, Math.min(1, 1 - penalty)).toFixed(2);
        const ecoPenalty = idleMinutes * 0.008 + harshAccels * 0.04;
        const ecoScore = Math.max(0, Math.min(1, 1 - ecoPenalty)).toFixed(2);

        await client.query(
          `INSERT INTO public.driver_behavior
             (driver_id, harsh_brake_count, harsh_accel_count, over_speed_count,
              idle_time_minutes, safety_score, eco_score, analysis_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            v.driver_id,
            harshBrakes,
            harshAccels,
            overSpeeds,
            idleMinutes,
            safetyScore,
            ecoScore,
            dateString,
          ]
        );
        behCount++;

        // ── 3. Periyodik yakıt dolumu (fuel.js formülüyle DOLU) ──
        v.daysSinceLastFuel++;

        if (v.lastFuelOdometer === null) {
          // İlk dolum: sadece state başlat, consumption hesaplanamaz (önceki kayıt yok)
          // fuel.js ilk kayıtta consumption null bırakır; biz de öyle.
          if (v.daysSinceLastFuel >= 3) {
            const liters = parseFloat(rand(300, 500).toFixed(2));
            const cost = parseFloat((liters * FUEL_PRICE_PER_LITER).toFixed(2));
            await client.query(
              `INSERT INTO public.fuel_records
                 (vehicle_id, odometer_km, liters_filled, total_cost,
                  consumption_per_100km, cost_per_km, record_date, is_full_tank, currency)
               VALUES ($1, $2, $3, $4, NULL, NULL, $5, true, 'EUR')`,
              [v.vehicle_id, v.currentOdometer, liters, cost, dateString]
            );
            fuelCount++;
            v.lastFuelOdometer = v.currentOdometer;
            v.daysSinceLastFuel = 0;
          }
          continue;
        }

        const rangeSinceLastFill = v.currentOdometer - v.lastFuelOdometer;

        // Depo ~450-600 km menzilde ya da 4 günde bir dolum
        if (rangeSinceLastFill >= 450 || v.daysSinceLastFuel >= 4) {
          if (rangeSinceLastFill <= 0) continue; // güvenlik (km artmadıysa atla)

          const baseRate = CONSUMPTION_BY_STYLE[v.style] || 28;
          // Günlük dalgalanma (STDDEV>0 olsun, tutarlılık analizi anlamlı çıksın)
          const rate = baseRate + rand(-1.5, 1.5);
          const liters = parseFloat(((rangeSinceLastFill * rate) / 100).toFixed(2));
          const cost = parseFloat((liters * FUEL_PRICE_PER_LITER).toFixed(2));

          // fuel.js formülü (tek kaynak doğruluk): consumption = liters/km*100
          const consumption = parseFloat(
            ((liters / rangeSinceLastFill) * 100).toFixed(2)
          );
          const costPerKm = parseFloat((cost / rangeSinceLastFill).toFixed(4));

          // fuel.js sağlık kontrolü: 1-30 dışı reddedilir. Üretimde garanti edelim.
          if (consumption < 1 || consumption > 30) {
            // bu dolumu atla (mantıksız), state bozulmasın
            v.daysSinceLastFuel = 0;
            v.lastFuelOdometer = v.currentOdometer;
            continue;
          }

          await client.query(
            `INSERT INTO public.fuel_records
               (vehicle_id, odometer_km, liters_filled, total_cost,
                consumption_per_100km, cost_per_km, record_date, is_full_tank, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'EUR')`,
            [
              v.vehicle_id,
              v.currentOdometer,
              liters,
              cost,
              consumption,
              costPerKm,
              dateString,
            ]
          );
          fuelCount++;
          v.lastFuelOdometer = v.currentOdometer;
          v.daysSinceLastFuel = 0;
        }
      }
    }

    await client.query("COMMIT;");
    console.log("\n🏁 [Success] Temel seed mühürlendi.");
    console.log(`   locations: ${locCount} breadcrumb`);
    console.log(`   driver_behavior: ${behCount} günlük agregat`);
    console.log(`   fuel_records: ${fuelCount} dolum`);
  } catch (err) {
    await client.query("ROLLBACK;");
    console.error("❌ [Crashed] Transaksiyon geri alındı:", err.message);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
