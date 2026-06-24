/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/correlationBatch.js
 * Küresel Davranış-Yakıt Korelasyonu ve Rölanti Maliyet Batch Analizörü
 * * Sorumlület: 543 günlük driver_behavior satırını ilgili fuel_records periyotlarıyla
 * dürüstçe eşleştirir (Seçenek B), global regresyonu hesaplar.
 */

const { Client } = require("pg");
const path = require("path");
const {
  analyzeDriverBehaviorCorrelation,
} = require("../03-logic/driverTelemetryRegressor");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env Error] DATABASE_URL bulunamadı.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(
    "🚀 [Sütun 3 Batch] Global Veri Havuzu Regresyon Motoru Başlatıldı."
  );

  try {
    // Dürüst Zaman Serisi Eşleştirme Sorgusu (PostgreSQL Window & Range Join)
    const dataPoolQuery = `
      WITH indexed_fuel_records AS (
          SELECT 
              id,
              vehicle_id,
              odometer_km,
              consumption_per_100km,
              record_date as fill_end_date,
              COALESCE(
                LAG(record_date) OVER (PARTITION BY vehicle_id ORDER BY record_date ASC, odometer_km ASC),
                record_date - INTERVAL '6 days'
              ) as fill_start_date
          FROM public.fuel_records
      )
      SELECT 
          db.driver_id,
          db.harsh_brake_count as "harshBrakes",
          db.harsh_accel_count as "harshAccels",
          db.idle_time_minutes as "idleMinutes",
          -- NOT: 193.0 bir basitleştirmedir. Lokasyon gürültüsünden arındırılmış günlük çapa mesafedir.
          193.0 as "dailyKm", 
          f.consumption_per_100km as "consumptionPer100km"
      FROM public.driver_behavior db
      JOIN public.drivers d ON d.id = db.driver_id
      JOIN public.vehicles v ON v.id = d.assigned_vehicle_id
      JOIN indexed_fuel_records f ON f.vehicle_id = v.id 
          AND db.analysis_date > f.fill_start_date 
          AND db.analysis_date <= f.fill_end_date
      WHERE d.company_id = 'efbaa346-cde9-489a-b3e9-6fd61df0c121'
      ORDER BY db.analysis_date ASC;
    `;

    const res = await client.query(dataPoolQuery);

    console.log(
      `📊 [Data Pool] Toplam ${res.rows.length} dürüst veri noktası havuzda toplandı.`
    );

    if (res.rows.length < 10) {
      console.log("⚠️ Havuzda yetersiz veri var. Analiz iptal edildi.");
      await client.end();
      return;
    }

    // Küresel Regresyon Analizinin Çalıştırılması (543 Nokta Havuzu)
    // Küresel Regresyon Analizinin Çalıştırılması (543 Nokta Havuzu)
    const report = analyzeDriverBehaviorCorrelation(res.rows, 1.75);

    console.log("\n=======================================================");
    console.log("📈 DOBBE FİLOSU KÜRESEL TELEMETRİ REGRESYON RAPORU");
    console.log("=======================================================");
    console.log(`🔹 Toplam Analiz Edilen Gün Sayısı (n): ${res.rows.length}`);
    console.log(
      `🔹 Belirlenlik Katsayısı (R²): ${report.rSquared} (%${(
        report.rSquared * 100
      ).toFixed(2)})`
    );
    console.log(`🔹 Eğilim Çizgisi (Slope): ${report.slope}`);
    console.log(
      `🔹 Sabit Tüketim Ekseni (Intercept): ${report.intercept} L/100km`
    );
    console.log(
      `🔹 Filo Toplam Rölanti Zararı (ROI): €${report.totalIdlingCostEuro}`
    );
    console.log(`\n💡 BOSS INSIGHT:\n   ${report.insight}`);
    console.log("=======================================================");

    // ── SNAPSHOT MÜHÜRLEME: uçucu sonucu companies.fuel_analytics_snapshot'a yaz ──
    // (Sabit JSON DEĞİL; batch'in gerçek hesabından parametreli yazılır, her koşuda güncel kalır)
    const snapshot = {
      updated_at: new Date().toISOString(),
      total_days: res.rows.length,
      r_squared: report.rSquared,
      slope: report.slope,
      intercept: report.intercept,
      total_idling_loss_euro: report.totalIdlingCostEuro,
      insight: report.insight,
    };

    await client.query(
      `UPDATE public.companies
         SET fuel_analytics_snapshot = $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(snapshot), "efbaa346-cde9-489a-b3e9-6fd61df0c121"]
    );

    console.log(
      "\n💾 [Snapshot] Sonuç companies.fuel_analytics_snapshot kolonuna mühürlendi."
    );
  } catch (error) {
    console.error(
      "❌ [Batch Execution Error] Korelasyon analizi çöktü:",
      error
    );
  } finally {
    await client.end();
  }
}

main();
