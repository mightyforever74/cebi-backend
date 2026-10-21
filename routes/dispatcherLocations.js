"use strict";

/**
 * Dispatcher canlı harita ilk-durum görüntüsü — Faz A (Çekirdek Operasyon) portu.
 *
 * GET /api/dispatcher/locations/latest
 * GET /api/dispatcher/routes/active
 *
 * Kaynak: tulipfleet-enterprise-backend/routes/locations.js. Sorgular
 * BİREBİR port edildi; rota geometrisi alımı ise cebi-backend'de ZATEN
 * var olan services/routing/factory.js + HereRoutingProvider.computeRoute()
 * soyutlamasını kullanır (axios + utils/herePolyline ayrı bir kopyası
 * YAZILMADI — cebi-backend'in kendi HERE entegrasyonu, driver trafik/rota
 * özelliği için zaten üretimde, native fetch tabanlı, test edilmiş).
 * Bu yüzden "geometry" alanı artık computeRoute()'un döndürdüğü
 * {geometry: [[lat,lng],...]} şeklinden gelir (kaynaktaki özel decoder
 * yerine); davranış eşdeğeri: HERE_API_KEY yoksa / hata / timeout olursa
 * geometry undefined/null döner, frontend zaten bunu null olarak bekliyor
 * (Graceful Degradation — kaynaktaki JSDoc ile aynı sözleşme).
 *
 * DÜZELTME (porttan önce yakalandı): kaynak dosya `l.timestamp` kolonunu
 * kullanıyordu, ama cebi-backend'in GERÇEK public.locations tablosunda bu
 * kolonun adı `time`dır (bkz. server.js saveLocationData() INSERT'i ve
 * routes/vehicleTrackHelpers.js'in ZATEN ÇALIŞAN sorgusu — aynı repo, aynı
 * tablo, `l.time` kullanıyor). Bu fark fark edilmeden canlıya çıksaydı
 * "column l.timestamp does not exist" ile 500 verirdi; SELECT/ORDER BY
 * burada `l.time` olarak düzeltildi, yanıt alanı adı yine de `timestamp`
 * olarak dışa verilir (frontend sözleşmesi bozulmasın diye `AS timestamp`).
 *
 * Company-scoped (ADR-0009 §4.4).
 */
const { createProvider } = require("../services/routing/factory");

const routingProvider = createProvider();

// task_no -> { coords: [[lat,lng],...] | null, ts: epochMs }
const geometryCache = new Map();
const NEGATIVE_CACHE_MS = 60 * 1000;

async function fetchRouteGeometry(taskNo, pickup, dropoff, log) {
  const cached = geometryCache.get(taskNo);
  if (cached && (cached.coords || Date.now() - cached.ts < NEGATIVE_CACHE_MS)) {
    return cached.coords;
  }
  try {
    const result = await routingProvider.computeRoute({
      origin: { lat: pickup.lat, lon: pickup.lng },
      destination: { lat: dropoff.lat, lon: dropoff.lng },
      transportMode: "truck",
    });
    const coords = Array.isArray(result.geometry) && result.geometry.length > 1
      ? result.geometry
      : null;
    geometryCache.set(taskNo, { coords, ts: Date.now() });
    if (log) log.info({ taskNo, points: coords ? coords.length : 0 }, "HERE geometri cache'lendi");
    return coords;
  } catch (err) {
    geometryCache.set(taskNo, { coords: null, ts: Date.now() });
    if (log) log.warn({ taskNo, err: err.message }, "HERE geometri alınamadı - fallback");
    return null;
  }
}

async function dispatcherLocationsRoutes(fastify) {
  fastify.get(
    "/api/dispatcher/locations/latest",
    {
      preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Token missing company_id claim",
        });
      }
      try {
        // DÜZELTME (2026-10-21, aynı gün ikinci tur): ilk denemede
        // `v.esp32_device_id IS NULL` ile iki kaynağı ayırmaya çalışmıştım,
        // ama `\d public.vehicles` ile doğrulandı — bu kolon NOT NULL +
        // UNIQUE (her araç, gerçek donanımı olmasa bile bir esp32_device_id
        // değerine sahip olmak ZORUNDA, ör. `TEST-34-CEBI` aracında eski bir
        // e2e test script'inden kalma `ESP32-CEBI-TEST-01`). Yani o filtre
        // HİÇBİR satırla asla eşleşmiyordu — düzeltme fiilen çalışmıyordu.
        //
        // Doğru tasarım: araç bazında kaynak AYIRMAK yerine, her araç için
        // iki kaynaktan (ESP32 `public.locations` / mobil
        // `mobile_location_pings`) HANGİSİ DAHA GÜNCELSE onu göstermek.
        // device_id: ESP32 kaynaklı satırlarda esp32_device_id string'i
        // KORUNUR (useMqttTelemetry.ts canlı güncellemeleri AYNI anahtarla
        // — gerçek cihazın MQTT topic'inden gelen device_id — eşleştiriyor,
        // değiştirilirse canlı MQTT akışı REST snapshot'ıyla eşleşmez);
        // mobil kaynaklı satırlarda device_id = vehicle_id (UUID) — MQTT
        // ile hiç ilgisi olmayan, route_json tabanlı mobil görevler için
        // routes/active'teki mobil dalla AYNI anahtar (bkz. aşağıda).
        const result = await fastify.pg.query(
          `WITH esp32_latest AS (
             SELECT DISTINCT ON (v.id)
                    v.id AS vehicle_id,
                    l.device_id AS device_id,
                    v.plate_no, v.emission_class, v.vehicle_category,
                    l.latitude, l.longitude, l.speed, l.heading, l.time::timestamptz AS ts
             FROM public.locations l
             JOIN public.vehicles v ON v.esp32_device_id = l.device_id
             WHERE v.company_id = $1
             ORDER BY v.id, l.time DESC
           ),
           mobile_latest AS (
             SELECT DISTINCT ON (v.id)
                    v.id AS vehicle_id,
                    v.id::text AS device_id,
                    v.plate_no, v.emission_class, v.vehicle_category,
                    mp.latitude, mp.longitude, mp.speed, mp.heading, mp.recorded_at AS ts
             FROM public.mobile_location_pings mp
             JOIN public.tasks t ON t.id = mp.task_id
             JOIN public.vehicles v ON v.id = t.vehicle_id
             WHERE t.company_id = $1
             ORDER BY v.id, mp.recorded_at DESC
           )
           SELECT DISTINCT ON (vehicle_id)
                  device_id, plate_no, vehicle_id, latitude, longitude,
                  speed, heading, ts AS timestamp, emission_class, vehicle_category
           FROM (
             SELECT * FROM esp32_latest
             UNION ALL
             SELECT * FROM mobile_latest
           ) combined
           ORDER BY vehicle_id, ts DESC`,
          [companyId]
        );

        return {
          locations: result.rows,
          count: result.rowCount,
        };
      } catch (err) {
        request.log.error({ err }, "Failed to fetch latest dispatcher locations");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch latest locations",
        });
      }
    }
  );

  fastify.get(
    "/api/dispatcher/routes/active",
    {
      preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Token missing company_id claim",
        });
      }
      try {
        const result = await fastify.pg.query(
          `SELECT v.esp32_device_id AS device_id,
                  t.task_no,
                  d.pickup_location,
                  d.dropoff_location
           FROM public.tasks t
           JOIN public.vehicles v ON v.id = t.vehicle_id
           JOIN enterprise.dispatch_tasks d ON d.id = t.enterprise_dispatch_task_id
           WHERE t.company_id = $1
             AND t.status = 'in_progress'
             AND v.esp32_device_id IS NOT NULL`,
          [companyId]
        );

        // Mobil GPS köprüsü (2026-10-21, düzeltme: `esp32_device_id IS NULL`
        // koşulu kaldırıldı — kolon NOT NULL, hiçbir satırla eşleşmiyordu,
        // bkz. yukarıdaki locations/latest'teki aynı düzeltmenin notu).
        // Gerçek ayraç zaten `enterprise_dispatch_task_id IS NULL` — VRP
        // optimize→approve akışından GEÇMEMİŞ (doğrudan oluşturulan veya
        // mobil-öncelikli) görevler için rota, enterprise.dispatch_tasks
        // yerine kendi route_json'undan (DriverRouteMapScreen.js ile aynı
        // sözleşme: {origin:{lat,lng}, destination:{lat,lng}}) alınır.
        // device_id = vehicle_id (UUID) — yukarıdaki locations/latest'in
        // mobil kaynaklı satırlarıyla AYNI anahtar.
        const mobileResult = await fastify.pg.query(
          `SELECT t.vehicle_id::text AS device_id,
                  t.task_no,
                  t.route_json
           FROM public.tasks t
           JOIN public.vehicles v ON v.id = t.vehicle_id
           WHERE t.company_id = $1
             AND t.status IN ('accepted', 'assigned', 'in_progress')
             AND t.enterprise_dispatch_task_id IS NULL
             AND t.route_json IS NOT NULL`,
          [companyId]
        );

        const combinedRows = [
          ...result.rows.map((row) => ({
            device_id: row.device_id,
            task_no: row.task_no,
            pickup_location: row.pickup_location,
            dropoff_location: row.dropoff_location,
          })),
          ...mobileResult.rows.map((row) => {
            const rj = row.route_json || {};
            return {
              device_id: row.device_id,
              task_no: row.task_no,
              pickup_location: rj.origin || null,
              dropoff_location: rj.destination || null,
            };
          }),
        ];

        const routes = [];
        for (const row of combinedRows) {
          const p = row.pickup_location || {};
          const dOff = row.dropoff_location || {};
          const pickup = { lat: Number(p.lat), lng: Number(p.lng) };
          const dropoff = { lat: Number(dOff.lat), lng: Number(dOff.lng) };
          let geometry = null;
          if (
            Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng) &&
            Number.isFinite(dropoff.lat) && Number.isFinite(dropoff.lng)
          ) {
            geometry = await fetchRouteGeometry(row.task_no, pickup, dropoff, request.log);
          }
          routes.push({
            device_id: row.device_id,
            task_no: row.task_no,
            pickup_location: row.pickup_location,
            dropoff_location: row.dropoff_location,
            geometry,
          });
        }
        return {
          routes,
          count: routes.length,
        };
      } catch (err) {
        request.log.error({ err }, "Failed to fetch active dispatcher routes");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch active routes",
        });
      }
    }
  );
}

module.exports = dispatcherLocationsRoutes;
