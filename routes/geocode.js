// /opt/fleet/backend/routes/geocode.js
// ============================================================
// TulipFleet Geocoding Routes  v1.0
// Mart 2026
//
// Endpoints:
//   GET /api/geocode/reverse?lat=...&lng=...
//     → Google Maps Geocoding API üzerinden coord → adres
//     → In-memory cache (1 saat TTL)
//     → Auth zorunlu (multi-tenant güvenlik)
//
// Kullanım:
//   - VehicleTrackScreen idle stop popup adresi
//   - İleride: DriverRouteMap, FleetMap vb.
//
// Gereksinimler:
//   - .env: GOOGLE_MAPS_API_KEY
// ============================================================

'use strict';

// ── fetch garantisi ────────────────────────────────────────
// Node 18+ global fetch destekler. Eski runtime'larda undici veya
// node-fetch gerekir. Sunucudaki mevcut server.js task waypoint
// geocoding'de (satır 2808) zaten global fetch kullanıyor —
// dolayısıyla runtime destekliyor. Yine de güvenlik için kontrol:
if (typeof globalThis.fetch !== 'function') {
  throw new Error(
    '[geocode.js] Global fetch bulunamadı. Node 18+ gerekli veya "npm install undici" yapın.'
  );
}

// ── In-memory cache ────────────────────────────────────────
// Key: "lat,lng" (6 ondalık hassasiyet)
// Value: { address, cached_at }
// TTL: 1 saat
const geocodeCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 saat
const MAX_CACHE_SIZE = 5000;

function getCacheKey(lat, lng) {
  return `${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}`;
}

function getCached(key) {
  const entry = geocodeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cached_at > CACHE_TTL_MS) {
    geocodeCache.delete(key);
    return null;
  }
  return entry.address;
}

function setCache(key, address) {
  // Basit LRU: max boyuta ulaşınca en eski %20'yi sil
  if (geocodeCache.size >= MAX_CACHE_SIZE) {
    const deleteCount = Math.floor(MAX_CACHE_SIZE * 0.2);
    const keys = geocodeCache.keys();
    for (let i = 0; i < deleteCount; i++) {
      const k = keys.next().value;
      if (k) geocodeCache.delete(k);
    }
  }
  geocodeCache.set(key, { address, cached_at: Date.now() });
}

// ── Rate limit (basit per-company) ─────────────────────────
// Her company_id için dakikada max 30 istek
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

function checkRateLimit(companyId) {
  const now = Date.now();
  let entry = rateLimitMap.get(companyId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(companyId, entry);
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

module.exports = async function (fastify) {

  // ── GET /api/geocode/reverse ──────────────────────────────
  fastify.get('/api/geocode/reverse', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const { lat, lng } = req.query;

    // ── Validation ──────────────────────────────────────────
    if (!lat || !lng) {
      return reply.status(400).send({ error: 'lat ve lng parametreleri zorunlu' });
    }

    const latF = parseFloat(lat);
    const lngF = parseFloat(lng);

    if (isNaN(latF) || isNaN(lngF)) {
      return reply.status(400).send({ error: 'lat ve lng sayısal olmalı' });
    }

    if (latF < -90 || latF > 90 || lngF < -180 || lngF > 180) {
      return reply.status(400).send({ error: 'Geçersiz koordinat aralığı' });
    }

    // ── Rate limit ──────────────────────────────────────────
    const companyId = req.user.company_id || req.user.id;
    if (!checkRateLimit(companyId)) {
      return reply.status(429).send({ error: 'Çok fazla istek. Lütfen bekleyin.' });
    }

    // ── Cache check ─────────────────────────────────────────
    const cacheKey = getCacheKey(latF, lngF);
    const cached = getCached(cacheKey);
    if (cached) {
      return reply.send({ address: cached, source: 'cache' });
    }

    // ── Google Maps API ─────────────────────────────────────
    const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GMAPS_KEY) {
      fastify.log.warn('GOOGLE_MAPS_API_KEY tanımlı değil');
      return reply.status(503).send({ error: 'Geocoding servisi yapılandırılmamış' });
    }

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latF},${lngF}&key=${GMAPS_KEY}&language=tr&region=tr`;

      const geoRes = await fetch(url);
      const geoData = await geoRes.json();

      if (geoData.status !== 'OK' || !geoData.results || geoData.results.length === 0) {
        fastify.log.warn({ status: geoData.status, lat: latF, lng: lngF }, 'Geocode no results');
        return reply.send({ address: null, source: 'google', status: geoData.status });
      }

      // İlk sonuç en spesifik adres
      const address = geoData.results[0].formatted_address;

      // Cache'e kaydet
      setCache(cacheKey, address);

      return reply.send({ address, source: 'google' });

    } catch (err) {
      fastify.log.error({ err }, 'Reverse geocode API hatası');
      return reply.status(502).send({ error: 'Geocoding servisi şu an erişilemez' });
    }
  });

  // ── GET /api/geocode/reverse/batch ────────────────────────
  // Birden fazla koordinat için toplu reverse geocode
  // Body: { points: [{ lat, lng }, ...] }  (max 10)
  fastify.post('/api/geocode/reverse/batch', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const { points } = req.body || {};

    if (!Array.isArray(points) || points.length === 0) {
      return reply.status(400).send({ error: 'points dizisi zorunlu' });
    }

    if (points.length > 10) {
      return reply.status(400).send({ error: 'Tek seferde en fazla 10 nokta' });
    }

    const companyId = req.user.company_id || req.user.id; // company_id yoksa user_id fallback
    if (!checkRateLimit(companyId)) {
      return reply.status(429).send({ error: 'Çok fazla istek. Lütfen bekleyin.' });
    }

    const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GMAPS_KEY) {
      return reply.status(503).send({ error: 'Geocoding servisi yapılandırılmamış' });
    }

    const results = [];

    for (const point of points) {
      const latF = parseFloat(point.lat);
      const lngF = parseFloat(point.lng);

      if (isNaN(latF) || isNaN(lngF)) {
        results.push({ lat: point.lat, lng: point.lng, address: null, error: 'Geçersiz koordinat' });
        continue;
      }

      if (latF < -90 || latF > 90 || lngF < -180 || lngF > 180) {
        results.push({ lat: latF, lng: lngF, address: null, error: 'Koordinat aralık dışı' });
        continue;
      }

      // Cache check
      const cacheKey = getCacheKey(latF, lngF);
      const cached = getCached(cacheKey);
      if (cached) {
        results.push({ lat: latF, lng: lngF, address: cached, source: 'cache' });
        continue;
      }

      // Google API
      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latF},${lngF}&key=${GMAPS_KEY}&language=tr&region=tr`;
        const geoRes = await fetch(url);
        const geoData = await geoRes.json();

        if (geoData.status === 'OK' && geoData.results && geoData.results.length > 0) {
          const address = geoData.results[0].formatted_address;
          setCache(cacheKey, address);
          results.push({ lat: latF, lng: lngF, address, source: 'google' });
        } else {
          results.push({ lat: latF, lng: lngF, address: null, source: 'google', status: geoData.status });
        }
      } catch (err) {
        fastify.log.error({ err, lat: latF, lng: lngF }, 'Batch geocode item failed');
        results.push({ lat: latF, lng: lngF, address: null, error: 'API hatası' });
      }
    }

    return reply.send({ results });
  });

};