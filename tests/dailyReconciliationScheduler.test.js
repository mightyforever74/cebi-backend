"use strict";

/**
 * tests/dailyReconciliationScheduler.test.js
 * ADR-CE-04 §B.3(ii) — gece yarısı güvenlik-ağı cron'u. Desen
 * tests/dailyTelematicsScheduler.test.js ile aynı (saf zaman fonksiyonları
 * + runDailyReconciliationBatch'in client.connect/release ve hata
 * davranışı; gerçek setTimeout zamanlayıcısının kendisi test edilmiyor).
 *
 * yesterdayDateString testleri ÖZELLİKLE önemli: fonksiyon toISOString()
 * (UTC) yerine getFullYear/getMonth/getDate (container'ın kendi yerel
 * saati) kullanır. Production'da bu UTC'ye eşittir — cebi-backend
 * container'ında TZ set edilmemiş, Node varsayılan UTC kullanır — ve bu
 * BİLİNÇLİ/DOĞRU: public.tasks.scheduled_start de UTC saat olarak
 * yazılıyor (routes/internalBridge.js:44), yani bu fonksiyon DB'nin
 * gün-sınırlarıyla aynı takvimde kalıyor. 19 Ekim 2026'da bu dosya ilk
 * yazılırken yanlışlıkla "production Europe/Istanbul'da çalışıyor"
 * varsayılmıştı (bkz. dailyReconciliationScheduler.js'teki TIMEZONE NOTU)
 * — gerçek dağıtımın UTC olduğu sonradan doğrulandı, kod değişmedi (zaten
 * doğru davranıyordu) ama bu yorumlar düzeltildi. Testler kendileri
 * timezone-bağımsız kalır: fonksiyon hangi yerel saatte çalışırsa çalışsın
 * KENDİ takvimiyle tutarlı "dün"ü üretmeli, aşağıdaki testler bunu doğrular.
 *
 * Run: node --test tests/dailyReconciliationScheduler.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  msUntilNext,
  yesterdayDateString,
  runDailyReconciliationBatch,
} = require("../services/reconciliation/dailyReconciliationScheduler");

// ── msUntilNext ──────────────────────────────────────────────────────────

test("msUntilNext: saat henuz gelmediyse bugune kurar", () => {
  const now = new Date("2026-10-19T00:00:01");
  const ms = msUntilNext(0, 10, now);
  assert.equal(ms, (9 * 60 + 59) * 1000); // 00:10'a 9dk59sn
});

test("msUntilNext: saat gectiyse ertesi gune kurar", () => {
  const now = new Date("2026-10-19T00:30:00");
  const ms = msUntilNext(0, 10, now);
  assert.equal(ms, (23 * 60 + 40) * 60 * 1000); // yarin 00:10'a 23s40dk
});

// ── yesterdayDateString ──────────────────────────────────────────────────
// Fonksiyon container'in LOKAL takvim gunune gore hesaplar (toISOString/UTC
// degil) - bu test suitinin calistigi ortamin TZ'si ne olursa olsun
// kendi takvimiyle tutarli olmali. Production'da lokal=UTC oldugu icin bu
// ayni zamanda scheduled_start'in UTC takvimiyle de ortusur (bkz. dosya
// basindaki not).

test("yesterdayDateString: gece yarisindan hemen sonra (00:10 yerel) dogru 'dun'u doner", () => {
  const now = new Date(2026, 9, 19, 0, 10, 0); // yerel: 19 Ekim 2026 00:10 (ay 0-index: 9=Ekim)
  assert.equal(yesterdayDateString(now), "2026-10-18");
});

test("yesterdayDateString: gun sonuna yakin (23:50 yerel) de dogru 'dun'u doner", () => {
  const now = new Date(2026, 9, 19, 23, 50, 0);
  assert.equal(yesterdayDateString(now), "2026-10-18");
});

test("yesterdayDateString: ay sinirini dogru gecer (1 Kasim -> 31 Ekim)", () => {
  const now = new Date(2026, 10, 1, 0, 10, 0); // ay 10 = Kasim
  assert.equal(yesterdayDateString(now), "2026-10-31");
});

// ── runDailyReconciliationBatch ───────────────────────────────────────────

function fakeFastify(queryImpl) {
  const logs = { info: [], error: [] };
  return {
    pg: {
      async connect() {
        return {
          query: queryImpl,
          released: false,
          release() {
            this.released = true;
          },
        };
      },
    },
    log: {
      info: (obj, msg) => logs.info.push({ obj, msg }),
      error: (obj, msg) => logs.error.push({ obj, msg }),
    },
    _logs: logs,
  };
}

test("runDailyReconciliationBatch: isleyecek surucu yoksa processed=0 ile temiz doner", async () => {
  const fastify = fakeFastify(async (sql) => {
    if (sql.includes("SELECT DISTINCT driver_id, company_id")) return { rows: [] };
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await runDailyReconciliationBatch(fastify);

  assert.equal(outcome.processed, 0);
  assert.equal(fastify._logs.error.length, 0);
});

test("runDailyReconciliationBatch: connect() basarisiz olursa hata yukari firlatilir (zamanlayici bunu loglar)", async () => {
  const fastify = {
    pg: { async connect() { throw new Error("DB baglanamadi"); } },
    log: { info() {}, error() {} },
  };

  await assert.rejects(() => runDailyReconciliationBatch(fastify), /DB baglanamadi/);
});

test("runDailyReconciliationBatch: client her zaman release edilir (basarili yolda)", async () => {
  let released = false;
  const fastify = {
    pg: {
      async connect() {
        return {
          query: async (sql) => {
            if (sql.includes("SELECT DISTINCT driver_id, company_id")) return { rows: [] };
            throw new Error("unexpected sql: " + sql);
          },
          release() {
            released = true;
          },
        };
      },
    },
    log: { info() {}, error() {} },
  };

  await runDailyReconciliationBatch(fastify);
  assert.equal(released, true);
});
