"use strict";

/**
 * Paylaşılan haversine mesafe hesabı — iki coğrafi nokta arası metre
 * cinsinden mesafe. `tulipfleet-enterprise-backend/lib/geoDistance.js`'ten
 * birebir port (Faz A-2, VRP Optimizasyon Portu).
 *
 * cebi-backend'de `services/geofenceService.js` içinde AYNI formülün özel
 * (export edilmemiş) bir kopyası zaten var — ona dokunulmadı (davranış
 * değişikliği riski yok), bu dosya sadece `lib/routing/MockVrpProvider.js`'ın
 * ihtiyaç duyduğu paylaşılabilir/export edilebilir sürüm.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { haversineMeters };
