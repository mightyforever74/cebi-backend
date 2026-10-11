"use strict";

/**
 * Geofence Editor — Validasyon ve Güvenlik Notları (Harita Dokümanı v2 §9.5):
 *   - Polygon en az 3 nokta olmadan kaydedilemez.
 *   - Circle radius: min 10m, max 5km.
 *   - Self-intersecting polygon engellenmeli (MVP'de en azından backend
 *     validation şart).
 *   - Backend doğrulama hataları UI'da kullanıcıya gösterilmeli (bu modül
 *     {ok:false, error} şeklinde insan-okunur Türkçe mesaj döndürür;
 *     routes/geofences.js bunu doğrudan reply.status(400).send({error})
 *     ile iletir — mevcut 400 deseniyle birebir uyumlu).
 *
 * Tamamen saf fonksiyonlar — DB/network bağımsız, node:test ile doğrudan
 * test edilir. routes/geofences.js POST ve PUT handler'ları bu modülü
 * kullanır.
 */

const MIN_RADIUS_METERS = 10;
const MAX_RADIUS_METERS = 5000;
const MIN_POLYGON_POINTS = 3;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidLatLng(point) {
  if (!point || typeof point !== "object") return false;
  const lat = typeof point.lat === "string" ? parseFloat(point.lat) : point.lat;
  const lng = typeof point.lng === "string" ? parseFloat(point.lng) : point.lng;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

/**
 * coordinates yapısal doğrulaması:
 *   - circle: { lat, lng } tek nokta.
 *   - polygon: en az 3 nokta içeren dizi, her nokta geçerli {lat,lng}.
 */
function validateCoordinatesShape(fence_type, coordinates) {
  if (fence_type === "circle") {
    if (!isValidLatLng(coordinates)) {
      return {
        ok: false,
        error: "Circle için coordinates geçerli bir {lat,lng} noktası olmalı",
      };
    }
    return { ok: true };
  }

  if (fence_type === "polygon") {
    if (!Array.isArray(coordinates)) {
      return {
        ok: false,
        error: "Polygon için coordinates bir nokta dizisi olmalı",
      };
    }
    if (coordinates.length < MIN_POLYGON_POINTS) {
      return {
        ok: false,
        error: `Polygon en az ${MIN_POLYGON_POINTS} nokta içermeli (şu an ${coordinates.length})`,
      };
    }
    for (let i = 0; i < coordinates.length; i++) {
      if (!isValidLatLng(coordinates[i])) {
        return {
          ok: false,
          error: `Polygon noktası #${i + 1} geçerli bir {lat,lng} değil`,
        };
      }
    }
    return { ok: true };
  }

  return { ok: false, error: `Tanınmayan fence_type: ${fence_type}` };
}

/**
 * Circle radius sınırları: 10m - 5km.
 */
function validateRadius(fence_type, radius) {
  if (fence_type !== "circle") return { ok: true };

  const r = typeof radius === "string" ? parseFloat(radius) : radius;
  if (!isFiniteNumber(r)) {
    return {
      ok: false,
      error: "Circle tipi için radius zorunludur ve sayısal olmalı",
    };
  }
  if (r < MIN_RADIUS_METERS) {
    return {
      ok: false,
      error: `Radius en az ${MIN_RADIUS_METERS}m olmalı (şu an ${r}m)`,
    };
  }
  if (r > MAX_RADIUS_METERS) {
    return {
      ok: false,
      error: `Radius en fazla ${MAX_RADIUS_METERS}m olmalı (şu an ${r}m)`,
    };
  }
  return { ok: true };
}

/**
 * İki doğru parçasının (p1-p2 ve p3-p4) kesişip kesişmediğini kontrol eder.
 * Standart orientation-based segment-intersection testi.
 */
function orientation(p, q, r) {
  const val =
    (q.lat - p.lat) * (r.lng - q.lng) - (q.lng - p.lng) * (r.lat - q.lat);
  if (Math.abs(val) < 1e-12) return 0; // collinear
  return val > 0 ? 1 : 2;
}

function onSegment(p, q, r) {
  return (
    q.lat <= Math.max(p.lat, r.lat) &&
    q.lat >= Math.min(p.lat, r.lat) &&
    q.lng <= Math.max(p.lng, r.lng) &&
    q.lng >= Math.min(p.lng, r.lng)
  );
}

function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);

  if (o1 !== o2 && o3 !== o4) return true;

  if (o1 === 0 && onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment(p3, p2, p4)) return true;

  return false;
}

function normalizePoint(p) {
  return {
    lat: typeof p.lat === "string" ? parseFloat(p.lat) : p.lat,
    lng: typeof p.lng === "string" ? parseFloat(p.lng) : p.lng,
  };
}

/**
 * Basit (simple) polygon kontrolü: ardışık olmayan kenarlar kesişmemeli.
 * points.length < 3 ise anlamsız -> false döner (ayrı kuralda zaten reddedilir).
 */
function isSelfIntersectingPolygon(points) {
  const n = points.length;
  if (n < 4) return false; // 3 noktalı kapalı üçgen kendi kendini kesemez

  const pts = points.map(normalizePoint);
  const edges = [];
  for (let i = 0; i < n; i++) {
    edges.push([pts[i], pts[(i + 1) % n]]);
  }

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      // Komşu kenarlar (ortak köşe paylaşanlar) atlanır — paylaşılan köşe
      // "kesişim" sayılmaz.
      const shareVertex = j === i + 1 || (i === 0 && j === edges.length - 1);
      if (shareVertex) continue;

      if (
        segmentsIntersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1])
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Tüm §9.5 kurallarını tek seferde uygular. routes/geofences.js'in
 * POST/PUT handler'larından çağrılır.
 */
function validateGeofencePayload({ fence_type, coordinates, radius }) {
  const shapeCheck = validateCoordinatesShape(fence_type, coordinates);
  if (!shapeCheck.ok) return shapeCheck;

  const radiusCheck = validateRadius(fence_type, radius);
  if (!radiusCheck.ok) return radiusCheck;

  if (fence_type === "polygon" && isSelfIntersectingPolygon(coordinates)) {
    return {
      ok: false,
      error:
        "Polygon kendi kendini kesiyor (self-intersecting) — geçerli bir şekil çizin",
    };
  }

  return { ok: true };
}

module.exports = {
  MIN_RADIUS_METERS,
  MAX_RADIUS_METERS,
  MIN_POLYGON_POINTS,
  isValidLatLng,
  validateCoordinatesShape,
  validateRadius,
  segmentsIntersect,
  isSelfIntersectingPolygon,
  validateGeofencePayload,
};
