/**
 * routes/geofenceCheckHelpers.js
 * Harita Dokümanı v2 §9 uyumlu geofence kontrol ve helper modülü.
 * Test edilebilirlik için veritabanı client'ı dışarıdan enjekte edilir.
 */

// Haversine formula - mesafe hesaplama (metre cinsinden)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
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

// Çember geofence kontrolü
function isPointInCircle(lat, lon, centerLat, centerLon, radiusMeters) {
  const distance = getDistanceMeters(lat, lon, centerLat, centerLon);
  return distance <= radiusMeters;
}

// Poligon geofence kontrolü (Ray-casting algoritması)
function isPointInPolygon(lat, lon, polygonCoords) {
  if (!Array.isArray(polygonCoords) || polygonCoords.length < 3) return false;
  let inside = false;
  for (
    let i = 0, j = polygonCoords.length - 1;
    i < polygonCoords.length;
    j = i++
  ) {
    const xi = polygonCoords[i].lat || polygonCoords[i][0];
    const yi = polygonCoords[i].lng || polygonCoords[i][1];
    const xj = polygonCoords[j].lat || polygonCoords[j][0];
    const yj = polygonCoords[j].lng || polygonCoords[j][1];

    const intersect =
      yi > lon !== yj > lon && xi < ((xj - xi) * (lon - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Zaman kısıtlaması kontrolü
function isTimeRestrictionActive(restriction) {
  if (!restriction) return true;
  // Basit zaman kısıt kontrol mantığı (varsa kurallara göre işletilir)
  return true;
}

/**
 * Ana geofence kontrol fonksiyonu
 * @param {Object} client - pg client (dışarıdan enjekte edilir, transaction veya pool client)
 * @param {Object} params - { deviceId, companyId, vehicleId, latitude, longitude, speed, previousLat, previousLng, locationTime }
 * @param {Object} logger - fastify.log veya benzeri logger
 */
async function checkGeofences(client, params, logger = console) {
  const {
    deviceId,
    companyId,
    vehicleId,
    latitude,
    longitude,
    speed,
    previousLat,
    previousLng,
    locationTime = new Date(), // §9.6: Fallback olarak verilen veya şimdiki zaman
  } = params;

  if (!deviceId || latitude === undefined || longitude === undefined) {
    return;
  }

  // 1. Şirkete ait aktif geofence'leri çek
  const geofencesQuery = `
    SELECT id, name, type, center_lat, center_lon, radius_meters, coordinates, is_active
    FROM geofences
    WHERE company_id = $1 AND is_active = true
  `;
  const { rows: geofences } = await client.query(geofencesQuery, [companyId]);

  if (!geofences || geofences.length === 0) return;

  for (const gf of geofences) {
    let isInside = false;

    if (gf.type === "circle") {
      isInside = isPointInCircle(
        latitude,
        longitude,
        parseFloat(gf.center_lat),
        parseFloat(gf.center_lon),
        parseFloat(gf.radius_meters)
      );
    } else if (gf.type === "polygon") {
      let coords = gf.coordinates;
      if (typeof coords === "string") {
        try {
          coords = JSON.parse(coords);
        } catch (e) {
          continue;
        }
      }
      isInside = isPointInPolygon(latitude, longitude, coords);
    }

    // Son aktif event durumunu kontrol et (Entry/Exit tespiti için)
    const lastEventQuery = `
      SELECT event_type, created_at 
      FROM geofence_events 
      WHERE geofence_id = $1 AND device_id = $2 
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    const { rows: lastEvents } = await client.query(lastEventQuery, [
      gf.id,
      deviceId,
    ]);
    const lastEvent = lastEvents[0];
    const currentlyInside = lastEvent
      ? lastEvent.event_type === "entry"
      : false;

    // Durum değiştiyse (Entry veya Exit gerçekleştiyse)
    if (isInside !== currentlyInside) {
      const eventType = isInside ? "entry" : "exit";

      // Süre hesaplaması (§9.6 uyumlu: locationTime baz alınarak)
      let durationSeconds = null;
      if (eventType === "exit" && lastEvent && lastEvent.created_at) {
        const lastTime = new Date(lastEvent.created_at).getTime();
        const currTime = new Date(locationTime).getTime();
        durationSeconds = Math.max(0, Math.floor((currTime - lastTime) / 1000));
      }

      // geofence_events tablosuna kayıt (created_at = locationTime)
      const insertEventQuery = `
        INSERT INTO geofence_events (geofence_id, device_id, vehicle_id, event_type, created_at, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await client.query(insertEventQuery, [
        gf.id,
        deviceId,
        vehicleId || null,
        eventType,
        locationTime,
        durationSeconds,
      ]);

      // alerts tablosuna kayıt (created_at = locationTime)
      const alertTitle =
        eventType === "entry"
          ? `Geofence Girişi: ${gf.name}`
          : `Geofence Çıkışı: ${gf.name}`;
      const alertDesc = `Araç ${gf.name} bölgesine ${
        eventType === "entry" ? "girdi" : "çıktı"
      }.`;
      const severity = "warning";

      const insertAlertQuery = `
        INSERT INTO alerts (company_id, alert_type, severity, device_id, vehicle_id, title, description, latitude, longitude, speed, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `;
      await client.query(insertAlertQuery, [
        companyId,
        `geofence_${eventType}`,
        severity,
        deviceId,
        vehicleId || null,
        alertTitle,
        alertDesc,
        latitude,
        longitude,
        speed || 0,
        JSON.stringify({ geofence_id: gf.id, geofence_name: gf.name }),
        locationTime,
      ]);
    }
  }
}

module.exports = {
  getDistanceMeters,
  isPointInCircle,
  isPointInPolygon,
  isTimeRestrictionActive,
  checkGeofences,
};
