/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/correlationBatch.js
 * Küresel Davranış-Yakıt Korelasyonu ve Rölanti Maliyet Batch Analizörü
 *
 * Sorumluluk: Her şirket için kendi driver_behavior satırlarını ilgili
 * fuel_records periyotlarıyla eşleştirir, şirket-bazlı regresyonu hesaplar
 * ve sonucu companies.fuel_analytics_snapshot'a yazar.
 *
 * 11 Ekim 2026 — Multi-tenant genelleştirme: Script başlangıçta TEK bir
 * demo/pilot şirkete (`company_id = 'efbaa346-...'`, Dobbe) sabitlenmişti —
 * hem okuma sorgusunda hem de snapshot UPDATE'inde. Artık `listCompanyIds()`
 * ile TÜM şirketler için ayrı ayrı korelasyon hesaplanıp kendi
 * fuel_analytics_snapshot'larına yazılıyor.
 *
 * BİLİNEN SINIRLAMA (devralındı, bu refactor'ın kapsamı dışında — Cem'e
 * ayrıca raporlandı): `dailyKm` sütunu sorguda `193.0` sabit değer olarak
 * basitleştirilmiş ("lokasyon gürültüsünden arındırılmış günlük çapa
 * mesafe" yorumuyla). Gerçek per-vehicle günlük km hesaplamasına
 * geçirilmesi ayrı bir iş kalemi (regresyon doğruluğunu etkiler, multi-
 * tenant mimariyi etkilemez).
 *
 * Test edilebilirlik için `runCorrelationBatch(client, options)` DB
 * client'ı dışarıdan enjekte eder. `main()` gerçek pg.Client + .env ile bu
 * fonksiyonu çağıran ince bir CLI/cron sarmalayıcıdır.
 *
 * ÇALIŞTIRMA (manuel, tek seferlik):
 *   cd .../FEAT-007-EXT-virtual-telematics/05-integration
 *   node correlationBatch.js
 * Üretimde server.js içindeki günlük 02:00 zamanlayıcısı üzerinden otomatik
 * tetikleniyor (bkz. FEAT-007-EXT-virtual-telematics/06-cron).
 */

const {
  analyzeDriverBehaviorCorrelation,
} = require("../03-logic/driverTelemetryRegressor");

const DEFAULT_MIN_DATA_POINTS = 10;
const DEFAULT_FUEL_COST_PER_LITER = 1.75;

/** Sürücü davranışı + yakıt kaydı olan TÜM şirketlerin id'lerini döner. */
async function listCompanyIds(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT d.company_id
     FROM public.driver_behavior db
     JOIN public.drivers d ON d.id = db.driver_id
     WHERE d.company_id IS NOT NULL
     ORDER BY d.company_id`
  );
  return rows.map((r) => r.company_id);
}

async function fetchDataPool(client, companyId) {
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
        -- NOT: 193.0 bir basitleştirmedir (bkz. dosya başlığı "BİLİNEN SINIRLAMA").
        193.0 as "dailyKm",
        f.consumption_per_100km as "consumptionPer100km"
    FROM public.driver_behavior db
    JOIN public.drivers d ON d.id = db.driver_id
    JOIN public.vehicles v ON v.id = d.assigned_vehicle_id
    JOIN indexed_fuel_records f ON f.vehicle_id = v.id
        AND db.analysis_date > f.fill_start_date
        AND db.analysis_date <= f.fill_end_date
    WHERE d.company_id = $1
    ORDER BY db.analysis_date ASC;
  `;
  const res = await client.query(dataPoolQuery, [companyId]);
  return res.rows;
}

/**
 * Tek bir şirket için korelasyon analizini çalıştırır ve snapshot'ı yazar.
 */
async function runCorrelationForCompany(client, companyId, options = {}) {
  const minDataPoints = options.minDataPoints ?? DEFAULT_MIN_DATA_POINTS;
  const fuelCostPerLiter =
    options.fuelCostPerLiter ?? DEFAULT_FUEL_COST_PER_LITER;

  const dataPool = await fetchDataPool(client, companyId);

  if (dataPool.length < minDataPoints) {
    return {
      companyId,
      status: "insufficient_data",
      dataPoints: dataPool.length,
    };
  }

  const report = analyzeDriverBehaviorCorrelation(dataPool, fuelCostPerLiter);

  const snapshot = {
    updated_at: new Date().toISOString(),
    total_days: dataPool.length,
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
    [JSON.stringify(snapshot), companyId]
  );

  return {
    companyId,
    status: "snapshot_written",
    dataPoints: dataPool.length,
    report,
  };
}

/**
 * Sürücü davranışı + yakıt verisi olan TÜM şirketler için korelasyon
 * batch'ini çalıştırır (her şirket kendi snapshot'ını alır).
 *
 * @param {Object} client - pg client (dışarıdan enjekte edilir, testability)
 * @param {Object} [options]
 * @param {number} [options.minDataPoints] - Analiz için min veri noktası (default 10)
 * @param {number} [options.fuelCostPerLiter] - Euro mazot fiyatı (default 1.75)
 * @returns {Promise<{processed:number, results:Array}>}
 */
async function runCorrelationBatch(client, options = {}) {
  const companyIds = await listCompanyIds(client);
  const results = [];

  for (const companyId of companyIds) {
    const result = await runCorrelationForCompany(client, companyId, options);
    results.push(result);
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
    "🚀 [Sütun 3 Batch] Global Veri Havuzu Regresyon Motoru Başlatıldı (tüm şirketler)."
  );

  try {
    const { processed, results } = await runCorrelationBatch(client);
    console.log(`\n📊 ${processed} şirket değerlendirildi:\n`);
    for (const r of results) {
      if (r.status === "snapshot_written") {
        console.log(
          "\n======================================================="
        );
        console.log(`📈 ŞİRKET ${r.companyId} — TELEMETRİ REGRESYON RAPORU`);
        console.log("=======================================================");
        console.log(`🔹 Toplam Analiz Edilen Gün Sayısı (n): ${r.dataPoints}`);
        console.log(
          `🔹 Belirlenlik Katsayısı (R²): ${r.report.rSquared} (%${(
            r.report.rSquared * 100
          ).toFixed(2)})`
        );
        console.log(`🔹 Eğilim Çizgisi (Slope): ${r.report.slope}`);
        console.log(
          `🔹 Filo Toplam Rölanti Zararı (ROI): €${r.report.totalIdlingCostEuro}`
        );
        console.log(`💡 BOSS INSIGHT:\n   ${r.report.insight}`);
      } else {
        console.log(
          `  ⚠️  Şirket ${r.companyId} — yetersiz veri (${r.dataPoints} nokta), analiz atlandı.`
        );
      }
    }
  } catch (error) {
    console.error(
      "❌ [Batch Execution Error] Korelasyon analizi çöktü:",
      error
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

module.exports = {
  runCorrelationBatch,
  runCorrelationForCompany,
  listCompanyIds,
  DEFAULT_MIN_DATA_POINTS,
  DEFAULT_FUEL_COST_PER_LITER,
};

if (require.main === module) {
  main();
}
