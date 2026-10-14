// Tek seferlik düzeltme betiği — FEAT-020 Phase 1.1 patch'inin server.js'te
// reddedilen 2 hunk'ını (require satırı + POST /api/vehicles validasyonu)
// güvenli şekilde ekler. Çalıştır: node fix-server-capacity.js
const fs = require("fs");
const path = "server.js";
let content = fs.readFileSync(path, "utf8");
let changed = false;

// 1) require satırı
const REQUIRE_LINE =
  'const { parseVehicleCapacityFields } = require("./routes/vehicleCapacityHelpers");';
if (!content.includes(REQUIRE_LINE)) {
  const anchor = 'const { fetchVehicleTrack } = require("./routes/vehicleTrackHelpers");';
  const idx = content.indexOf(anchor);
  if (idx === -1) {
    console.error("HATA: require ekleme noktası bulunamadı (fetchVehicleTrack require satırı yok). Elle eklenmeli.");
    process.exit(1);
  }
  const insertAt = idx + anchor.length;
  content = content.slice(0, insertAt) + "\n" + REQUIRE_LINE + content.slice(insertAt);
  changed = true;
  console.log("1) require satırı eklendi.");
} else {
  console.log("1) require satırı zaten var, atlandı.");
}

// 2) POST /api/vehicles icindeki capacity validasyonu
const VALIDATION_BLOCK = `
    // FEAT-020 Phase 1.1 (2026-10-12): kargo kapasite alanlari opsiyonel,
    // DI'siz saf validasyon (routes/vehicleCapacityHelpers.js).
    const capacity = parseVehicleCapacityFields(request.body);
    if (!capacity.ok) {
      return reply.code(400).send({ error: capacity.error });
    }
`;
if (content.includes("const capacity = parseVehicleCapacityFields(request.body);")) {
  console.log("2) POST validasyon bloğu zaten var, atlandı.");
} else {
  const postAnchor = 'fastify.post(\n  "/api/vehicles",';
  const postIdx = content.indexOf(postAnchor);
  if (postIdx === -1) {
    console.error('HATA: fastify.post("/api/vehicles", ...) bulunamadı. Elle eklenmeli.');
    process.exit(1);
  }
  // Bu noktadan sonraki ILK "const client = await fastify.pg.connect();" POST handler'ın kendisidir.
  const clientAnchor = "const client = await fastify.pg.connect();";
  const clientIdx = content.indexOf(clientAnchor, postIdx);
  if (clientIdx === -1) {
    console.error("HATA: POST handler içinde client.connect() bulunamadı. Elle eklenmeli.");
    process.exit(1);
  }
  content = content.slice(0, clientIdx) + VALIDATION_BLOCK + "\n    " + content.slice(clientIdx);
  changed = true;
  console.log("2) POST validasyon bloğu eklendi.");
}

if (changed) {
  fs.writeFileSync(path, content, "utf8");
  console.log("server.js güncellendi.");
} else {
  console.log("Değişiklik gerekmedi.");
}
