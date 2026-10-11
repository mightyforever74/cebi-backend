/**
 * tests/vehicleTrack.test.js
 *
 * Harita Dokümanı v2 §9.7 — "Track polyline yönü (start → end) doğru mu
 * doğrulanmalı".
 *
 * Bulgu (11 Ekim 2026): eski sorgu `ORDER BY l.time ASC LIMIT N` kullanıyordu.
 * Varsayılan zaman aralığı "Bugün" (gece yarısı -> şimdi); cihaz ping
 * aralığı ~30s olduğundan N=1000 limit ~8.3 saate denk gelir. Bir araç
 * bugün 8.3 saatten fazla konum göndermişse, ASC+LIMIT en ESKİ N noktayı
 * alır ve rotanın GÜNCEL/BİTİŞ kısmını (şu ana en yakın olanı) sessizce
 * keser — polyline "doğru yönde" çizilir ama gerçek bitiş noktasına hiç
 * ulaşmaz.
 *
 * Düzeltme: `ORDER BY l.time DESC LIMIT N` (en SON N noktayı garanti al),
 * sonra JS'te sonucu ters çevirip ASC sıraya getir. Kesilme olacaksa artık
 * eski uçtan olur, güncel/bitiş kısmı her zaman korunur.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchVehicleTrack } = require("../routes/vehicleTrackHelpers");

function fakeClient(rows) {
  return {
    calls: [],
    async query(text, params) {
      this.calls.push({ text, params });
      return { rows };
    },
  };
}

test("fetchVehicleTrack: sorgu ORDER BY time DESC + LIMIT kullanir (ASC degil)", async () => {
  const client = fakeClient([]);
  await fetchVehicleTrack(client, { vehicleId: "veh-1" });

  const call = client.calls[0];
  assert.match(call.text, /ORDER BY l\.time DESC/);
  assert.doesNotMatch(call.text, /ORDER BY l\.time ASC/);
  assert.match(call.text, /LIMIT \$\d+/);
});

test("fetchVehicleTrack: DB'den DESC gelen satirlar ASC'ye cevrilerek dondurulur", async () => {
  const descRows = [
    { time: "2026-10-11T18:00:00Z", latitude: 3, longitude: 3 },
    { time: "2026-10-11T12:00:00Z", latitude: 2, longitude: 2 },
    { time: "2026-10-11T06:00:00Z", latitude: 1, longitude: 1 },
  ];
  const client = fakeClient(descRows);

  const result = await fetchVehicleTrack(client, { vehicleId: "veh-1" });

  assert.deepEqual(
    result.points.map((p) => p.time),
    ["2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z"],
    "points ASC (eski -> yeni) sirada donmeli, rotanin bitisi (en yeni) korunmali"
  );
});

test("fetchVehicleTrack: limit belirtilmezse varsayilan 1000 kullanilir", async () => {
  const client = fakeClient([]);
  await fetchVehicleTrack(client, { vehicleId: "veh-1" });

  const call = client.calls[0];
  const limitParamIndex = call.text.match(/LIMIT \$(\d+)/)[1];
  assert.equal(call.params[Number(limitParamIndex) - 1], 1000);
});

test("fetchVehicleTrack: ozel limit parametresi kullanilabilir", async () => {
  const client = fakeClient([]);
  await fetchVehicleTrack(client, { vehicleId: "veh-1", limit: 50 });

  const call = client.calls[0];
  const limitParamIndex = call.text.match(/LIMIT \$(\d+)/)[1];
  assert.equal(call.params[Number(limitParamIndex) - 1], 50);
});

test("fetchVehicleTrack: start/end verilmezse sorguya eklenmez, verilirse eklenir", async () => {
  const client1 = fakeClient([]);
  await fetchVehicleTrack(client1, { vehicleId: "veh-1" });
  assert.doesNotMatch(client1.calls[0].text, /l\.time >=/);
  assert.doesNotMatch(client1.calls[0].text, /l\.time <=/);

  const client2 = fakeClient([]);
  await fetchVehicleTrack(client2, {
    vehicleId: "veh-1",
    start: "2026-10-11T00:00:00Z",
    end: "2026-10-11T23:59:59Z",
  });
  assert.match(client2.calls[0].text, /l\.time >=/);
  assert.match(client2.calls[0].text, /l\.time <=/);
  assert.ok(client2.calls[0].params.includes("2026-10-11T00:00:00Z"));
  assert.ok(client2.calls[0].params.includes("2026-10-11T23:59:59Z"));
});

test("fetchVehicleTrack: bos sonuc icin bos points dizisi doner", async () => {
  const client = fakeClient([]);
  const result = await fetchVehicleTrack(client, { vehicleId: "veh-1" });
  assert.deepEqual(result.points, []);
});

test("fetchVehicleTrack: vehicleId sorguya ilk parametre olarak geciliyor", async () => {
  const client = fakeClient([]);
  await fetchVehicleTrack(client, { vehicleId: "veh-xyz" });
  assert.equal(client.calls[0].params[0], "veh-xyz");
  assert.match(client.calls[0].text, /WHERE v\.id = \$1/);
});
