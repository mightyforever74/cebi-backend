/**
 * FEAT-007-EXT-virtual-telematics / 05-integration/reconcileBatch.js
 * GPS ve Sayaç Mutabakatı Otomatik Batch Motoru (Idempotent)
 * * Sorumluluk: Dobbe tırlarının son iki dolum periyodunu PostGIS ile tarar,
 * sapma %5'i aşarsa mükerrer kontrolü yaparak alerts hipertablosuna yazar.
 */

const { Client } = require("pg");
const path = require("path");
const { reconcileGpsMeters } = require("../03-logic/reconcileGpsMeters");

// Güvenli mutlak .env konfigürasyonu
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// Dobbe Staging Cihaz Listesi
const DOBBE_DEVICES = ["DEMO-ESP-002", "DEMO-ESP-003", "DEMO-ESP-004"];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ [.env Error] DATABASE_URL bulunamadı.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(
    "🚀 [Sütun 2 Batch] Fleetadmin yetkisiyle mutabakat motoru başlatıldı."
  );

  try {
    await client.query("BEGIN;");

    for (const deviceId of DOBBE_DEVICES) {
      console.log(
        `\n🔍 [Processing] Cihaz: ${deviceId} için PostGIS pencereleri taranıyor...`
      );

      // 1. ADIM: İki Dolum Arasına Hizalanmış PostGIS Küresel Mesafe Sorgusu
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
        console.log(
          `ℹ️  Cihaz ${deviceId} için yeterli lokasyon/dolum periyodu bulunamadı. Pas geçiliyor.`
        );
        continue;
      }

      const {
        vehicle_id,
        total_breadcrumbs,
        gps_haversine_km,
        odo_actual_km,
        last_fill_time,
      } = geoRes.rows[0];

      // 2. ADIM: Saf Karar Motorunun Koşturulması
      const rec = reconcileGpsMeters({
        odometerDelta: odo_actual_km,
        gpsHaversineDistance: gps_haversine_km,
        allowedDeviationThreshold: 0.05,
      });

      // 3. ADIM: Sapma Var ve Alarma Geçilecekse Idempotency Denetimi Yap
      if (rec.triggerAlert) {
        // Araç ve Son Dolum Tarihi bazında bu uyarı zaten basılmış mı kontrol et (Düzeltme 2)
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
          console.log(
            `🛡️  [Idempotency Koruma] ${deviceId} için bu periyodun uyarısı zaten mevcut. Mükerrer engellendi.`
          );
          continue;
        }

        // 4. ADIM: MÜKERRER DEĞİLSE ALERTS HİPERTABLOSUNA YAZ
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

        console.log(
          `⚠️  [Alert Triggered] ${plate_no} için yeni sapma uyarısı işlendi. ID: ${alertRes.rows[0].id}`
        );
      } else {
        console.log(
          `✅ [Success] ${deviceId} mutabakatı temiz, sapma sınırların altında.`
        );
      }
    }

    await client.query("COMMIT;");
    console.log(
      "\n🏁 [Batch Done] Tüm araçların mutabakat taraması başarıyla mühürlendi!"
    );
  } catch (error) {
    await client.query("ROLLBACK;");
    console.error("❌ [Batch Crashed] İşlemler geri alındı:", error);
  } finally {
    await client.end();
  }
}

main();
