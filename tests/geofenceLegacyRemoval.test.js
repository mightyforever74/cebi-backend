/**
 * tests/geofenceLegacyRemoval.test.js
 *
 * 11 Ekim 2026 — Legacy checkGeofences() kaldırma kararı.
 *
 * Arka plan: `routes/geofenceCheckHelpers.js`'in SQL sorgusu `geofences`
 * tablosunda var olmayan kolonları (`type`, `center_lat`, `center_lon`,
 * `radius_meters`) okuyordu; her çağrıda PostgreSQL hatası fırlatıyor,
 * server.js'teki sessiz catch (`catch (geoErr) { console.error(...) }`)
 * bunu yutuyordu. Doğrulama: prod'da `geofence_events` tablosu 7 gündür
 * 0 satır — fonksiyon hiçbir zaman başarıyla çalışmamış (ne v2-contract
 * cihazlar ne de 1 legacy-firmware cihaz için).
 *
 * Karar (Cem onayı, 11 Ekim 2026): 1 legacy-firmware cihaz v4.7.0+'a
 * güncellenecek/elenecek; sunucu tarafında TEK yetkili geofence tespit
 * mercii `services/geofenceService.js` (v2-contract, device-side detection
 * + server-side doğrulama/dedup) olacak. Bozuk ve ölü legacy kod tabanından
 * tamamen kaldırılır.
 *
 * Bu test, kaldırmanın gerçekten yapıldığını ve regresyonla geri
 * sızmadığını doğrular (statik kaynak taraması).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const serverSrc = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

test("server.js artik checkGeofences'i import etmiyor", () => {
  assert.equal(
    /require\((['"]).*geofenceCheckHelpers\1\)/.test(serverSrc),
    false,
    "server.js hala './routes/geofenceCheckHelpers' require ediyor"
  );
});

test("server.js artik checkGeofences(...) cagirmiyor", () => {
  assert.equal(
    serverSrc.includes("checkGeofences("),
    false,
    "server.js hala checkGeofences(...) cagirisi iceriyor"
  );
});

test("routes/geofenceCheckHelpers.js dosyasi silinmis olmali", () => {
  const legacyPath = path.join(
    __dirname,
    "..",
    "routes",
    "geofenceCheckHelpers.js"
  );
  assert.equal(
    fs.existsSync(legacyPath),
    false,
    "routes/geofenceCheckHelpers.js hala mevcut"
  );
});

test("services/geofenceService.js TEK yetkili geofence tespit mercii olarak mevcut", () => {
  const v2Path = path.join(__dirname, "..", "services", "geofenceService.js");
  assert.equal(
    fs.existsSync(v2Path),
    true,
    "services/geofenceService.js bulunamadi — v2-contract sistemi de kaybolmus olabilir"
  );
  const v2Src = fs.readFileSync(v2Path, "utf8");
  assert.match(
    v2Src,
    /handleGeofenceEvent/,
    "services/geofenceService.js icinde handleGeofenceEvent bulunamadi"
  );
});
