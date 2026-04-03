// /opt/fleet/backend/routes/trips.js
// ============================================================
// TulipFleet Trip Engine  v1.2
// Mart 2026
//
// Frontend'teki deriveTrips + idleClusters mantığının backend karşılığı.
// SQL bazlı trip segmentation — locations tablosundan doğrudan türetir.
//
// Endpoints:
//   GET /api/vehicles/:id/trips?from=&to=
//     → Araç için trip listesi (start/end coord, mesafe, süre)
//
//   GET /api/vehicles/:id/trips/summary?from=&to=
//     → Günlük özet (toplam sefer, km, sürüş/bekleme süresi)
//
//   GET /api/vehicles/:id/trips/:tripNumber/points?from=&to=
//     → Belirli trip'in GPS noktaları
//
//   GET /api/vehicles/:id/trips/export?from=&to=
//     → CSV export — trip raporu (summary + detail)
//
// NOT: Bu endpoint'ler "from/to" param adı kullanır.
// Mevcut /api/vehicles/:id/locations endpoint'i "start/end" kullanır.
// İki farklı convention var — ileride tekleştirilecek.
//
// Join: vehicles.esp32_device_id → locations.device_id
// Auth: preHandler [fastify.authenticate]
// Multi-tenant: company_id kontrolü
// ============================================================

'use strict';

const { generateTripReportPdf } = require('../services/tripPdfExporter');

// ── Trip segmentation constants ─────────────────────────────
// Frontend ile senkron tutulmalı (VehicleTrackScreen.js)
const IDLE_SPEED_THRESHOLD = 4; // km/h altı → idle
const MIN_IDLE_DURATION_MS = 5 * 60 * 1000; // 5 dk → stop boundary
const MAX_IDLE_RADIUS_METERS = 80; // Cluster max yarıçap
const MIN_TRIP_DISTANCE_METERS = 300; // 300m altı trip sayılmaz
const MIN_TRIP_DURATION_MS = 3 * 60 * 1000; // 3 dk altı trip sayılmaz
const MAX_SEGMENT_DISTANCE_METERS = 2000; // GPS outlier filtresi — 2km üstü sıçrama ignore

// ── Haversine mesafe hesaplama (metre) ──────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Dünya yarıçapı (metre)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── Idle cluster çıkarımı ───────────────────────────────────
function deriveIdleClusters(points) {
  if (!points || points.length < 2) return [];

  const clusters = [];
  let currentCluster = null;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const speed = parseFloat(point.speed) || 0;
    const isIdle = speed < IDLE_SPEED_THRESHOLD;
    const lat = parseFloat(point.latitude);
    const lng = parseFloat(point.longitude);
    const pointTime = point.time ? new Date(point.time).getTime() : null;

    if (isNaN(lat) || isNaN(lng) || !pointTime) continue;

    if (!isIdle) {
      if (currentCluster) {
        const durationMs = currentCluster.endTime - currentCluster.startTime;
        if (durationMs >= MIN_IDLE_DURATION_MS) {
          clusters.push({ ...currentCluster, durationMs });
        }
        currentCluster = null;
      }
      continue;
    }

    if (!currentCluster) {
      currentCluster = {
        startIndex: i,
        endIndex: i,
        startTime: pointTime,
        endTime: pointTime,
        anchorLat: lat,
        anchorLng: lng,
        sumLat: lat,
        sumLng: lng,
        count: 1,
      };
      continue;
    }

    const dist = haversineDistance(
      currentCluster.anchorLat,
      currentCluster.anchorLng,
      lat,
      lng
    );

    if (dist <= MAX_IDLE_RADIUS_METERS) {
      currentCluster.endIndex = i;
      currentCluster.endTime = pointTime;
      currentCluster.sumLat += lat;
      currentCluster.sumLng += lng;
      currentCluster.count++;
    } else {
      const durationMs = currentCluster.endTime - currentCluster.startTime;
      if (durationMs >= MIN_IDLE_DURATION_MS) {
        clusters.push({ ...currentCluster, durationMs });
      }
      currentCluster = {
        startIndex: i,
        endIndex: i,
        startTime: pointTime,
        endTime: pointTime,
        anchorLat: lat,
        anchorLng: lng,
        sumLat: lat,
        sumLng: lng,
        count: 1,
      };
    }
  }

  if (currentCluster) {
    const durationMs = currentCluster.endTime - currentCluster.startTime;
    if (durationMs >= MIN_IDLE_DURATION_MS) {
      clusters.push({ ...currentCluster, durationMs });
    }
  }

  return clusters.map((c) => ({
    startIndex: c.startIndex,
    endIndex: c.endIndex,
    startTime: c.startTime,
    endTime: c.endTime,
    durationMs: c.durationMs,
    coordinate: {
      latitude: c.sumLat / c.count,
      longitude: c.sumLng / c.count,
    },
  }));
}

// ── Trip segmentation ───────────────────────────────────────
function deriveTrips(points, idleClusters) {
  if (!points || points.length < 2) return [];

  const sortedClusters = [...idleClusters].sort(
    (a, b) => a.startIndex - b.startIndex
  );

  const boundaries = [];
  let currentStart = 0;

  for (const cluster of sortedClusters) {
    // Trip: currentStart → cluster başlangıcının 1 öncesi
    if (cluster.startIndex - 1 > currentStart) {
      boundaries.push({
        startIndex: currentStart,
        endIndex: cluster.startIndex - 1,
      });
    }
    // Cluster sonrasından devam
    currentStart = cluster.endIndex + 1;
  }

  // Son cluster'dan track sonuna kadar
  if (currentStart < points.length - 1) {
    boundaries.push({
      startIndex: currentStart,
      endIndex: points.length - 1,
    });
  }

  const trips = [];
  let tripNum = 0;

  for (const b of boundaries) {
    const tripPoints = points.slice(b.startIndex, b.endIndex + 1);
    if (tripPoints.length < 2) continue;

    const startTime = tripPoints[0]?.time
      ? new Date(tripPoints[0].time).getTime()
      : null;
    const endTime = tripPoints[tripPoints.length - 1]?.time
      ? new Date(tripPoints[tripPoints.length - 1].time).getTime()
      : null;

    const durationMs = startTime && endTime ? endTime - startTime : 0;

    let distanceMeters = 0;
    for (let i = 1; i < tripPoints.length; i++) {
      const segDist = haversineDistance(
        parseFloat(tripPoints[i - 1].latitude),
        parseFloat(tripPoints[i - 1].longitude),
        parseFloat(tripPoints[i].latitude),
        parseFloat(tripPoints[i].longitude)
      );
      // GPS outlier filtresi — tek sıçrama tüm mesafeyi patlatmasın
      if (segDist <= MAX_SEGMENT_DISTANCE_METERS) {
        distanceMeters += segDist;
      }
    }

    if (distanceMeters < MIN_TRIP_DISTANCE_METERS) continue;
    if (durationMs < MIN_TRIP_DURATION_MS) continue;

    tripNum++;
    const first = tripPoints[0];
    const last = tripPoints[tripPoints.length - 1];

    trips.push({
      tripNumber: tripNum,
      startIndex: b.startIndex,
      endIndex: b.endIndex,
      startTime: first.time,
      endTime: last.time,
      durationMs,
      distanceMeters: Math.round(distanceMeters),
      startCoordinate: {
        latitude: parseFloat(first.latitude),
        longitude: parseFloat(first.longitude),
      },
      endCoordinate: {
        latitude: parseFloat(last.latitude),
        longitude: parseFloat(last.longitude),
      },
      pointCount: tripPoints.length,
    });
  }

  return trips;
}

// ── Araç ownership doğrulama ────────────────────────────────
async function validateVehicleAccess(client, vehicleId, user, log) {
  const { rows } = await client.query(
    `SELECT v.id, v.esp32_device_id, v.plate_no, v.company_id
     FROM vehicles v
     WHERE v.id = $1`,
    [vehicleId]
  );

  if (rows.length === 0) return null;

  const vehicle = rows[0];

  // Multi-tenant guard — super_admin hariç
  if (user.role !== 'super_admin' && user.company_id !== vehicle.company_id) {
    return null;
  }

  // Polish: esp32_device_id yoksa logla
  if (!vehicle.esp32_device_id && log) {
    log.warn({ vehicleId, plate: vehicle.plate_no }, 'Araçta esp32_device_id tanımlı değil');
  }

  return vehicle;
}

// ── from/to tarih validation ────────────────────────────────
function validateDateRange(from, to, reply) {
  if (!from || !to) {
    reply.status(400).send({ error: 'from ve to parametreleri zorunlu (ISO 8601)' });
    return null;
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    reply.status(400).send({ error: 'from ve to geçerli ISO 8601 tarih olmalı' });
    return null;
  }

  if (fromDate >= toDate) {
    reply.status(400).send({ error: 'from, to değerinden küçük olmalı' });
    return null;
  }

  // Max 31 gün — çok geniş aralık performans ve maliyet riski
  const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
  if (toDate - fromDate > MAX_RANGE_MS) {
    reply.status(400).send({ error: 'Maksimum 31 günlük aralık desteklenir' });
    return null;
  }

  return { fromDate, toDate };
}

// ── Location points çekme (ortak) ───────────────────────────
async function fetchLocationPoints(client, deviceId, from, to, limit = 20000, log = null) {
  const safeLimit = Math.min(parseInt(limit, 10) || 20000, 50000);
  const query = `
    SELECT latitude, longitude, speed, heading, time, accuracy
    FROM locations
    WHERE device_id = $1
      AND time >= $2
      AND time <= $3
    ORDER BY time ASC
    LIMIT $4
  `;
  const { rows } = await client.query(query, [deviceId, from, to, safeLimit]);

  // Cap'e vurduysa logla — trip çıkarımı eksik olabilir
  if (rows.length >= safeLimit && log) {
    log.warn(
      { deviceId, from, to, returned: rows.length, cap: safeLimit },
      'Trip query hit max point cap — results may be incomplete'
    );
  }

  return rows;
}

// ── CSV helper ──────────────────────────────────────────────
function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── Fastify route registration ──────────────────────────────
module.exports = async function (fastify) {

  // ── GET /api/vehicles/:id/trips ────────────────────────────
  // Araç için trip listesi
  fastify.get('/api/vehicles/:id/trips', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const vehicle = await validateVehicleAccess(client, req.params.id, req.user, fastify.log);
      if (!vehicle) {
        return reply.status(404).send({ error: 'Araç bulunamadı veya yetkisiz' });
      }

      const emptyResponse = {
        vehicleId: vehicle.id,
        plate: vehicle.plate_no,
        from: req.query.from,
        to: req.query.to,
        pointCount: 0,
        trips: [],
        stops: [],
      };

      if (!vehicle.esp32_device_id) {
        return reply.send({ ...emptyResponse, message: 'Araçta cihaz bağlı değil' });
      }

      const dateRange = validateDateRange(req.query.from, req.query.to, reply);
      if (!dateRange) return;

      const points = await fetchLocationPoints(client, vehicle.esp32_device_id, dateRange.fromDate, dateRange.toDate, 20000, fastify.log);

      if (points.length === 0) {
        return reply.send(emptyResponse);
      }

      const idleClusters = deriveIdleClusters(points);
      const trips = deriveTrips(points, idleClusters);

      return reply.send({
        vehicleId: vehicle.id,
        plate: vehicle.plate_no,
        from: req.query.from,
        to: req.query.to,
        pointCount: points.length,
        trips,
        stops: idleClusters.map((c, idx) => ({
          stopNumber: idx + 1,
          startTime: new Date(c.startTime).toISOString(),
          endTime: new Date(c.endTime).toISOString(),
          durationMs: c.durationMs,
          coordinate: c.coordinate,
        })),
      });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/vehicles/:id/trips failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/vehicles/:id/trips/summary ────────────────────
  // Günlük özet
  fastify.get('/api/vehicles/:id/trips/summary', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const vehicle = await validateVehicleAccess(client, req.params.id, req.user, fastify.log);
      if (!vehicle) {
        return reply.status(404).send({ error: 'Araç bulunamadı veya yetkisiz' });
      }

      const emptySummary = {
        totalTrips: 0,
        totalStops: 0,
        totalDistanceMeters: 0,
        totalDriveTimeMs: 0,
        totalIdleTimeMs: 0,
        pointCount: 0,
        avgTripDistanceMeters: 0,
        avgTripDurationMs: 0,
      };

      const baseResponse = {
        vehicleId: vehicle.id,
        plate: vehicle.plate_no,
        from: req.query.from,
        to: req.query.to,
      };

      if (!vehicle.esp32_device_id) {
        return reply.send({
          ...baseResponse,
          summary: emptySummary,
          message: 'Araçta cihaz bağlı değil',
        });
      }

      const dateRange = validateDateRange(req.query.from, req.query.to, reply);
      if (!dateRange) return;

      const points = await fetchLocationPoints(client, vehicle.esp32_device_id, dateRange.fromDate, dateRange.toDate, 20000, fastify.log);

      if (points.length === 0) {
        return reply.send({ ...baseResponse, summary: emptySummary });
      }

      const idleClusters = deriveIdleClusters(points);
      const trips = deriveTrips(points, idleClusters);

      const totalDistanceMeters = trips.reduce((s, t) => s + t.distanceMeters, 0);
      const totalDriveTimeMs = trips.reduce((s, t) => s + t.durationMs, 0);
      const totalIdleTimeMs = idleClusters.reduce((s, c) => s + c.durationMs, 0);

      return reply.send({
        ...baseResponse,
        summary: {
          totalTrips: trips.length,
          totalStops: idleClusters.length,
          totalDistanceMeters,
          totalDriveTimeMs,
          totalIdleTimeMs,
          pointCount: points.length,
          avgTripDistanceMeters: trips.length > 0
            ? Math.round(totalDistanceMeters / trips.length)
            : 0,
          avgTripDurationMs: trips.length > 0
            ? Math.round(totalDriveTimeMs / trips.length)
            : 0,
        },
      });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/vehicles/:id/trips/summary failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/vehicles/:id/trips/:tripNumber/points ─────────
  // Belirli trip'in GPS noktaları
  fastify.get('/api/vehicles/:id/trips/:tripNumber/points', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const vehicle = await validateVehicleAccess(client, req.params.id, req.user, fastify.log);
      if (!vehicle) {
        return reply.status(404).send({ error: 'Araç bulunamadı veya yetkisiz' });
      }

      if (!vehicle.esp32_device_id) {
        return reply.send({ points: [], message: 'Araçta cihaz bağlı değil' });
      }

      const dateRange = validateDateRange(req.query.from, req.query.to, reply);
      if (!dateRange) return;

      const tripNumber = parseInt(req.params.tripNumber);
      if (isNaN(tripNumber) || tripNumber < 1) {
        return reply.status(400).send({ error: 'Geçersiz trip numarası' });
      }

      const points = await fetchLocationPoints(client, vehicle.esp32_device_id, dateRange.fromDate, dateRange.toDate, 20000, fastify.log);

      // Erken return — veri yoksa trip çıkarımına gerek yok
      if (points.length === 0) {
        return reply.status(404).send({ error: `Bu zaman aralığında veri bulunamadı` });
      }

      const idleClusters = deriveIdleClusters(points);
      const trips = deriveTrips(points, idleClusters);

      const trip = trips.find((t) => t.tripNumber === tripNumber);
      if (!trip) {
        return reply.status(404).send({ error: `Trip #${tripNumber} bulunamadı` });
      }

      const tripPoints = points.slice(trip.startIndex, trip.endIndex + 1);

      return reply.send({
        tripNumber: trip.tripNumber,
        startTime: trip.startTime,
        endTime: trip.endTime,
        durationMs: trip.durationMs,
        distanceMeters: trip.distanceMeters,
        points: tripPoints,
      });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/vehicles/:id/trips/:tripNumber/points failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/vehicles/:id/trips/export ─────────────────────
  // CSV export — trip raporu (summary + detail satırları)
  // format param reserved — şimdilik sadece CSV destekleniyor
  fastify.get('/api/vehicles/:id/trips/export', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();

    try {
      const vehicle = await validateVehicleAccess(client, req.params.id, req.user, fastify.log);
      if (!vehicle) {
        return reply.status(404).send({ error: 'Araç bulunamadı veya yetkisiz' });
      }

      if (!vehicle.esp32_device_id) {
        return reply.status(400).send({ error: 'Araçta cihaz bağlı değil' });
      }

      const dateRange = validateDateRange(req.query.from, req.query.to, reply);
      if (!dateRange) return;

      const format = String(req.query.format || 'csv').toLowerCase();
      if (format !== 'csv' && format !== 'pdf') {
        return reply.status(400).send({ error: 'Desteklenen formatlar: csv, pdf' });
      }

      const points = await fetchLocationPoints(
        client,
        vehicle.esp32_device_id,
        dateRange.fromDate,
        dateRange.toDate,
        20000,
        fastify.log
      );

      // ── Filename (sanitized) ───────────────────────────────
      const fromDate = req.query.from ? req.query.from.split('T')[0] : 'unknown';
      const toDate = req.query.to ? req.query.to.split('T')[0] : 'unknown';
      const safePlate = String(vehicle.plate_no || 'vehicle').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `trips_${safePlate}_${fromDate}_${toDate}.csv`;

      const idleClusters = points.length >= 2 ? deriveIdleClusters(points) : [];
      const trips = points.length >= 2 ? deriveTrips(points, idleClusters) : [];

      // ── SUMMARY ──────────────────────────────────────────
      const totalTrips = trips.length;
      const totalDistance = Math.round(trips.reduce((s, t) => s + t.distanceMeters, 0));
      const totalDriveTime = trips.reduce((s, t) => s + t.durationMs, 0);
      // Fix #1: canonical idle — idleClusters ile tutarlı (/trips/summary ile aynı)
      const totalIdleTime = idleClusters.reduce((s, c) => s + c.durationMs, 0);
      // ── PDF EXPORT ────────────────────────────────────────
      if (format === 'pdf') {
        const pdfDoc = generateTripReportPdf({
          vehicle,
          from: req.query.from,
          to: req.query.to,
          summary: {
            totalTrips,
            totalDistanceMeters: totalDistance,
            totalDriveTimeMs: totalDriveTime,
            totalIdleTimeMs: Math.round(totalIdleTime),
            pointCount: points.length,
          },
          trips,
          stops: idleClusters.map((c, i) => ({
            stopNumber: i + 1,
            startTime: new Date(c.startTime).toISOString(),
            endTime: new Date(c.endTime).toISOString(),
            durationMs: c.durationMs,
            centerLat: c.centerLat ?? c.coordinate?.latitude ?? null,
            centerLng: c.centerLng ?? c.coordinate?.longitude ?? null,
          })),
        });

        const pdfFilename = `trips_${safePlate}_${fromDate}_${toDate}.pdf`;

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${pdfFilename}"`,
          'Cache-Control': 'no-cache',
        });

        pdfDoc.pipe(reply.raw);
        pdfDoc.end();
        return;
      }
      const summaryLines = [
        `# TULIPFLEET TRIP REPORT`,
        `# Vehicle: ${vehicle.plate_no}`,
        `# Period: ${fromDate} - ${toDate}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Points analyzed: ${points.length}`,
        `#`,
        `TOTAL_TRIPS,${totalTrips}`,
        `TOTAL_DISTANCE_M,${totalDistance}`,
        `TOTAL_DRIVE_TIME_MS,${totalDriveTime}`,
        `TOTAL_IDLE_TIME_MS,${Math.round(totalIdleTime)}`,
        `AVG_TRIP_DISTANCE_M,${totalTrips > 0 ? Math.round(totalDistance / totalTrips) : 0}`,
        `AVG_TRIP_DURATION_MS,${totalTrips > 0 ? Math.round(totalDriveTime / totalTrips) : 0}`,
        `#`,
      ];

      // ── DETAIL ROWS ──────────────────────────────────────
      const header = [
        'Trip No',
        'Start Time',
        'End Time',
        'Duration (ms)',
        'Distance (m)',
        'Points',
        'Start Lat',
        'Start Lng',
        'End Lat',
        'End Lng',
      ].join(',');

      // Fix #2: csvEscape + Fix: ISO 8601 tarih formatı
      const rows = trips.map(t => [
        csvEscape(t.tripNumber),
        csvEscape(t.startTime ? new Date(t.startTime).toISOString() : ''),
        csvEscape(t.endTime ? new Date(t.endTime).toISOString() : ''),
        csvEscape(t.durationMs),
        csvEscape(t.distanceMeters),
        csvEscape(t.pointCount),
        csvEscape(t.startCoordinate.latitude),
        csvEscape(t.startCoordinate.longitude),
        csvEscape(t.endCoordinate.latitude),
        csvEscape(t.endCoordinate.longitude),
      ].join(','));

      // Fix #4: UTF-8 BOM (Excel Türkçe uyumu)
      const csv = '\uFEFF' + [...summaryLines, header, ...rows].join('\n');

      // Fix #6: Boş veri/trip durumunda da tam format CSV döner
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(csv);

    } catch (err) {
      fastify.log.error({ err }, 'GET /api/vehicles/:id/trips/export failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

};