"use strict";

/**
 * services/reconciliation/dailyReconciliationScheduler.js
 *
 * ADR-CE-04 §B.3 (ii): gun sonunda (gece yarisi, yerel saat) bir
 * guvenlik-agi cron'u, o gun icin daha once "erken otomatik kapanis"
 * (sefer-tamamlama tetikleyicisi, bkz. tripReconciliation.reevaluateForTask)
 * ile kapanmamis her (surucu, gun) ciftini son kez degerlendirir.
 *
 * Desen FEAT-007-EXT-virtual-telematics/06-cron/dailyTelematicsScheduler.js
 * ile AYNI (bu backend'de zaten setInterval/setTimeout tabanli periyodik
 * isler var, yeni bir bagimlilik -node-cron- eklenmedi): scheduleDailyAt
 * her calistirmadan sonra KENDINI YENIDEN kurar (sabit 24 saatlik interval
 * DEGIL) - boylece yaz/kis saati (DST) kaymasinda calisma saati dogru kalir.
 *
 * Varsayilan saat 00:10 (gece yarisindan 10 dk sonra) - tam 00:00 yerine
 * kucuk bir tampon; ozel bir olay/hata verisine dayanmiyor, sadece gun
 * degisiminin DB/uygulama seviyesinde oturmasi icin makul bir pay.
 * Degerlendirilen gun: bu calistirma anindan ONCEKI takvim gunu ("dun" -
 * gun artik yeni bitti).
 *
 * TIMEZONE NOTU (19 Ekim 2026, duzeltildi): "00:10" burada CONTAINER'in
 * yerel saatine gore - production'da bu UTC (cebi-backend container'inda
 * TZ set edilmemis, Node varsayilan UTC kullanir). Bu BILINCLI ve DOGRU:
 * public.tasks.scheduled_start de "ISO, UTC saat" olarak yaziliyor
 * (routes/internalBridge.js:44) ve dispatcherTasks.js'teki gun filtreleri
 * de Postgres CURRENT_DATE'e (DB Etc/UTC) dayaniyor - sistemdeki TUM
 * gun-sinirlari UTC'ye gore. Bu cron'u Europe/Istanbul'a tasimak (TZ env
 * ile) bu tutarliligi bozar, 3 saatlik bir kayma yaratir. "00:10" yani
 * UTC gece yarisindan kisa sure sonra, Istanbul saatiyle 03:10'a denk
 * gelir - bu yanlislik degil, sadece asagidaki yorumlarin ilk yazildigi
 * halde "yerel saat"i yanlislikla Istanbul sanmis olmasindandi.
 */

const { runEndOfDayReconciliation } = require("./tripReconciliation");

const DEFAULT_HOUR = 0;
const DEFAULT_MINUTE = 10;

function msUntilNext(hour, minute, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function yesterdayDateString(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  // ONEMLI (19 Ekim 2026'da duzeltilen yanlis varsayim): asagidaki satirlar
  // toISOString() yerine getFullYear/getMonth/getDate kullanir - CONTAINER'in
  // kendi yerel saatine gore takvim gunu insa eder. Bu production'da UTC'ye
  // esittir (TZ set edilmemis) ve bu DOGRU DAVRANIS: public.tasks.scheduled_start
  // de UTC saat olarak yaziliyor (routes/internalBridge.js:44), yani bu
  // fonksiyonun urettigi tarih string'i scheduled_start'in gun-sinirlariyla
  // ayni takvimde (UTC) kaliyor. Fonksiyon container'in TZ'sine gore calismaya
  // devam eder - eger ileride TZ=Europe/Istanbul set edilirse (BUNU YAPMADAN
  // ONCE scheduled_start/CURRENT_DATE'in de ayni degisikligi almasi gerekir,
  // aksi halde iki farkli takvim birbirine karisir, bkz. dosya basindaki not).
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {Object} fastify - fastify instance (.pg ve .log icin)
 */
async function runDailyReconciliationBatch(fastify) {
  const client = await fastify.pg.connect();
  try {
    const date = yesterdayDateString();
    const result = await runEndOfDayReconciliation(client, fastify.log, date);
    fastify.log.info(
      { date, ...result },
      "[ADR-CE-04] Gunluk reconciliation guvenlik-agi cron'u tamamlandi"
    );
    return result;
  } finally {
    client.release();
  }
}

/**
 * @param {Object} fastify
 * @param {Object} [options]
 * @param {number} [options.hour] - default 0
 * @param {number} [options.minute] - default 10
 */
function scheduleDailyReconciliation(fastify, options = {}) {
  const hour = options.hour ?? DEFAULT_HOUR;
  const minute = options.minute ?? DEFAULT_MINUTE;

  function arm() {
    const delay = msUntilNext(hour, minute);
    fastify.log.info(
      { nextRunInMs: delay, hour, minute },
      "[ADR-CE-04] Gunluk reconciliation zamanlayici kuruldu"
    );
    setTimeout(function fire() {
      runDailyReconciliationBatch(fastify)
        .catch((err) => {
          fastify.log.error(
            { err },
            "[ADR-CE-04] Gunluk reconciliation batch beklenmedik hata"
          );
        })
        .finally(arm); // her durumda ertesi gun icin yeniden kur
    }, delay);
  }

  arm();
}

module.exports = {
  msUntilNext,
  yesterdayDateString,
  runDailyReconciliationBatch,
  scheduleDailyReconciliation,
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
};
