/**
 * FEAT-007-EXT-virtual-telematics / 06-cron/dailyTelematicsScheduler.js
 *
 * 11 Ekim 2026 — Cem'in kararı: "Sanal telematik" artık demo/pilot'a özel
 * manuel script değil, sistemde otomatik çalışan bir production feature.
 * Bu modül üç batch'i (fuelSnapshotBatch -> reconcileBatch ->
 * correlationBatch) her gün 02:00'da sırayla çalıştırır.
 *
 * Neden setTimeout/setInterval, neden node-cron değil: bu backend'de zaten
 * (simulate_*.js, publicTrack.js) periyodik işler setInterval ile yapılıyor,
 * yeni bir bağımlılık eklemeden mevcut kalıp izlendi. `scheduleDailyAt`
 * her çalıştırmadan sonra KENDİNİ YENİDEN kurar (setInterval(24h) DEĞİL) —
 * böylece yaz/kış saati (DST, NL) kaymasında "02:00" doğru kalır, 24 saatlik
 * sabit interval'de kayma birikmez.
 *
 * Sıra ÖNEMLİ: fuelSnapshotBatch depo seviyesini güncelliyor, reconcileBatch
 * o güncel odometer/GPS farkına göre uyarı üretiyor, correlationBatch en son
 * güncel fuel_records'u regresyona katıyor. Birinin hatası diğerlerini
 * engellemez (her biri kendi try/catch'inde, loglanır, batch devam eder).
 */

const { runFuelSnapshotBatch } = require("../05-integration/fuelSnapshotBatch");
const { runReconcileBatch } = require("../05-integration/reconcileBatch");
const { runCorrelationBatch } = require("../05-integration/correlationBatch");

const DEFAULT_HOUR = 2;
const DEFAULT_MINUTE = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Şu andan (veya verilen `now`'dan), bugün/yarın saat `hour:minute`'a kadar
 * kalan milisaniye. Saat geçmişse (veya tam o anıysa) ertesi güne kurar —
 * böylece bir zamanlayıcı asla "0 ms sonra" ya da negatif gecikmeyle
 * tetiklenmez.
 */
function msUntilNext(hour, minute, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Üç batch'i sırayla çalıştırır. Her biri kendi try/catch'inde — biri
 * hata verirse diğerleri yine de denenir, hiçbiri sessizce yutulmaz
 * (hepsi fastify.log'a yazılır).
 *
 * @param {Object} fastify - fastify instance (.pg ve .log için)
 * @returns {Promise<{fuel, reconcile, correlation}>} her birinin sonucu
 *   (hata verenler {error: true, message} şeklinde işaretlenir, throw etmez
 *   — zamanlayıcı döngüsünün kendisi hiç durmamalı).
 */
async function runDailyTelematicsBatch(fastify) {
  const client = await fastify.pg.connect();
  const outcome = {};

  try {
    try {
      outcome.fuel = await runFuelSnapshotBatch(client);
      fastify.log.info(
        { processed: outcome.fuel.processed },
        "[FEAT-007-EXT] fuelSnapshotBatch tamamlandı"
      );
    } catch (err) {
      fastify.log.error({ err }, "[FEAT-007-EXT] fuelSnapshotBatch hata verdi");
      outcome.fuel = { error: true, message: err.message };
    }

    try {
      outcome.reconcile = await runReconcileBatch(client);
      fastify.log.info(
        { processed: outcome.reconcile.processed },
        "[FEAT-007-EXT] reconcileBatch tamamlandı"
      );
    } catch (err) {
      fastify.log.error({ err }, "[FEAT-007-EXT] reconcileBatch hata verdi");
      outcome.reconcile = { error: true, message: err.message };
    }

    try {
      outcome.correlation = await runCorrelationBatch(client);
      fastify.log.info(
        { processed: outcome.correlation.processed },
        "[FEAT-007-EXT] correlationBatch tamamlandı"
      );
    } catch (err) {
      fastify.log.error({ err }, "[FEAT-007-EXT] correlationBatch hata verdi");
      outcome.correlation = { error: true, message: err.message };
    }

    return outcome;
  } finally {
    client.release();
  }
}

/**
 * Günlük telematik batch zincirini saat `hour:minute`'da (default 02:00)
 * çalışacak şekilde kurar. Her çalıştırmadan sonra kendini ertesi gün için
 * yeniden kurar (DST-güvenli). Sunucu kapanana kadar sürer.
 *
 * @param {Object} fastify
 * @param {Object} [options]
 * @param {number} [options.hour] - default 2
 * @param {number} [options.minute] - default 0
 */
function scheduleDailyTelematicsBatch(fastify, options = {}) {
  const hour = options.hour ?? DEFAULT_HOUR;
  const minute = options.minute ?? DEFAULT_MINUTE;

  function arm() {
    const delay = msUntilNext(hour, minute);
    fastify.log.info(
      { nextRunInMs: delay, hour, minute },
      "[FEAT-007-EXT] Günlük telematik batch zamanlayıcı kuruldu"
    );
    setTimeout(function fire() {
      runDailyTelematicsBatch(fastify)
        .catch((err) => {
          // runDailyTelematicsBatch kendi iç hatalarını yutar (outcome.error),
          // bu catch yalnızca client.connect() gibi beklenmedik hataları yakalar.
          fastify.log.error(
            { err },
            "[FEAT-007-EXT] Günlük batch zinciri beklenmedik hata"
          );
        })
        .finally(arm); // her durumda ertesi gün için yeniden kur
    }, delay);
  }

  arm();
}

module.exports = {
  msUntilNext,
  runDailyTelematicsBatch,
  scheduleDailyTelematicsBatch,
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
  DAY_MS,
};
