/**
 * tests/geofenceCheck.test.js
 * Harita Dokümanı v2 §9.6 uyumlu checkGeofences testleri.
 */
const test = require("node:test");
const assert = require("node:assert");
const { checkGeofences } = require("../routes/geofenceCheckHelpers");

// Mock Database Client
class MockPgClient {
  constructor(queriesReturn = {}) {
    this.queriesReturn = queriesReturn;
    this.executedQueries = [];
  }

  async query(text, params) {
    this.executedQueries.push({ text: text.trim(), params });

    // 1. Geofences sorgusu
    if (text.includes("FROM geofences")) {
      return {
        rows: this.queriesReturn.geofences || [
          {
            id: "geo-uuid-1",
            name: "Test Bolgesi",
            type: "circle",
            center_lat: 41.0082,
            center_lon: 28.9784,
            radius_meters: 100,
            is_active: true,
          },
        ],
      };
    }

    // 2. Son event sorgusu (Geçmiş durum)
    if (text.includes("FROM geofence_events")) {
      return {
        rows: this.queriesReturn.lastEvents || [],
      };
    }

    // 3. Insert sorguları (geofence_events veya alerts)
    if (text.includes("INSERT INTO")) {
      return { rows: [] };
    }

    return { rows: [] };
  }
}

test("checkGeofences - geofence_events ve alerts tablosuna locationTime kaydeder (§9.6)", async () => {
  const mockClient = new MockPgClient({
    lastEvents: [], // Önceden içeride değilmiş gibi (giriş tetiklenecek)
  });

  const customLocationTime = new Date("2026-10-11T12:00:00Z");

  await checkGeofences(
    mockClient,
    {
      deviceId: "dev-001",
      companyId: "comp-001",
      vehicleId: "veh-001",
      latitude: 41.0082, // Merkezde (içeride)
      longitude: 28.9784,
      speed: 40,
      locationTime: customLocationTime,
    },
    { log: () => {} }
  );

  // INSERT sorgularını bul
  const insertQueries = mockClient.executedQueries.filter((q) =>
    q.text.includes("INSERT INTO")
  );
  assert.strictEqual(
    insertQueries.length,
    2,
    "Hem geofence_event hem de alert eklenmiş olmalı"
  );

  // geofence_events insert kontrolü ($5 parametresi created_at / locationTime olmalı)
  const eventInsert = insertQueries.find((q) =>
    q.text.includes("geofence_events")
  );
  assert.ok(eventInsert, "geofence_events tablosuna insert atılmalı");
  assert.strictEqual(
    eventInsert.params[4],
    customLocationTime,
    "geofence_events created_at değeri locationTime ile birebir aynı olmalı"
  );

  // alerts insert kontrolü ($12 parametresi created_at / locationTime olmalı)
  const alertInsert = insertQueries.find((q) => q.text.includes("alerts"));
  assert.ok(alertInsert, "alerts tablosuna insert atılmalı");
  assert.strictEqual(
    alertInsert.params[11],
    customLocationTime,
    "alerts created_at değeri locationTime ile birebir aynı olmalı"
  );
});

test("checkGeofences - exit durumunda durationSeconds locationTime farkı ile hesaplanır", async () => {
  const previousTime = new Date("2026-10-11T11:55:00Z");
  const customLocationTime = new Date("2026-10-11T12:00:00Z"); // 5 dakika (300 saniye) sonra çıkış

  const mockClient = new MockPgClient({
    lastEvents: [
      { event_type: "entry", created_at: previousTime }, // Önceden içerideydi
    ],
  });

  await checkGeofences(
    mockClient,
    {
      deviceId: "dev-001",
      companyId: "comp-001",
      vehicleId: "veh-001",
      latitude: 41.05, // Dışarıda bir nokta
      longitude: 28.9784,
      speed: 50,
      locationTime: customLocationTime,
    },
    { log: () => {} }
  );

  const eventInsert = mockClient.executedQueries.find(
    (q) => q.text.includes("geofence_events") && q.params.includes("exit")
  );
  assert.ok(eventInsert, "Çıkış (exit) eventi üretilmeli");

  // duration_seconds $6 parametresidir (300 saniye olmalı)
  const durationSeconds = eventInsert.params[5];
  assert.strictEqual(
    durationSeconds,
    300,
    "Süre farkı (durationSeconds) doğru hesaplanmalı"
  );
});
