// /opt/fleet/backend/plugins/etag-cache.js
// TulipFleet - S6: ETag/304 Cache Plugin
// AdminDashboard 30s polling var - bu plugin network maliyetini dramatik dusurur
//
// KULLANIM:
// 1. Bu dosyayi /opt/fleet/backend/plugins/ altina koy
// 2. server.js'de register et:
//    fastify.register(require('./plugins/etag-cache'));
// 3. Endpoint'lerde onSend hook otomatik calisir
//
// NASIL CALISIR:
// - Response JSON hash'lenir -> ETag header eklenir
// - Client If-None-Match gonderirse -> hash eslesirse 304 doner
// - 304 = bos body, bandwidth sifir
// - AdminDashboard 30s'de bir polliyor -> veri degismediyse 304

"use strict";
const crypto = require("crypto");
const fp = require("fastify-plugin");

// Hangi path'ler icin ETag uretilecek
const ETAG_PATHS = [
  "/api/admin/fleet-stats",
  "/api/admin/activities",
  "/api/company/plan",
];

function generateETag(body) {
  const str = typeof body === "string" ? body : JSON.stringify(body);
  const hash = crypto.createHash("md5").update(str).digest("hex");
  return `"${hash}"`;
}

async function etagCachePlugin(fastify) {
  fastify.addHook("onSend", async (request, reply, payload) => {
    // Sadece belirlenmis path'ler icin
    const url = request.url.split("?")[0];
    if (!ETAG_PATHS.some((p) => url === p)) {
      return payload;
    }

    // Sadece 200 OK GET response'lar icin
    if (reply.statusCode !== 200 || request.method !== "GET") {
      return payload;
    }

    // ETag uret
    const etag = generateETag(payload);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "no-cache");

    // Client If-None-Match gonderdi mi?
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch === etag) {
      reply.code(304);
      reply.removeHeader("Content-Type");
      return "";
    }

    return payload;
  });
  
  fastify.log.info("[ETag] Cache plugin registered for: " + ETAG_PATHS.join(", "));
}

module.exports = fp(etagCachePlugin);