"use strict";

/**
 * services/reconciliation/tripReconciliation.js
 * ADR-CE-04 §2-B / §B.1 / §B.2 / §B.3 — gun-seviyesi otomatik sefer
 * kapanis reconciliation'i (docs/adr/ADR-CE-04-sefer-kapanis-reconciliation.md,
 * v3, Onaylandi).
 *
 * Iki tetikleyici (ADR §B.3), AYNI evaluateDriverDay() fonksiyonunu farkli
 * `isEndOfDay` bayragiyla cagirir:
 *   - Sefer "completed" oldugunda (reevaluateForTask, isEndOfDay=false):
 *     SADECE erken otomatik kapanis kontrolu yapilir (tamamlanan >=
 *     planlanan ise hemen kapat). Sayi henuz yetmiyorsa (gun devam ediyor
 *     olabilir) HICBIR ZAMAN exception_raised'a GECMEZ - bu yanlis-pozitif
 *     uretirdi (gunun geri kalani henuz tamamlanmamis demek, tek basina bir
 *     kacak/ihlal anlamina gelmez).
 *   - Gece yarisi guvenlik-agi cron'u (runEndOfDayReconciliation,
 *     isEndOfDay=true): gun artik KESIN bittigi icin, tamamlanan < planlanan
 *     ise bu kez gercekten exception_raised'a geçer (enterprise.exception_
 *     events'e kayit duser).
 *
 * "O gun" tanimi: tasks.scheduled_start'in (yoksa created_at'in) tarihi -
 * GOREVIN PLANLANDIGI gun, tamamlandigi gun degil (bir gorev gece
 * yarisindan sonra tamamlansa bile hangi gunun plani oldugu degismez).
 *
 * Idempotency: status zaten 'closed_auto'/'exception_raised' ise (terminal)
 * hicbir sey yapilmaz - her iki tetikleyici de ayni (driver, gun) ciftini
 * guvenle defalarca cagirabilir. UPSERT'lerdeki "WHERE ...status='pending'"
 * kosulu, es zamanli iki cagri arasindaki yaris durumuna karsi ayrica DB
 * seviyesinde korur (ikinci cagri satirin zaten terminal oldugunu gorup
 * hicbir satiri etkilemez).
 *
 * HICBIR fonksiyon disariya throw ETMEZ - cagiran taraf (sefer tamamlama
 * endpoint'i veya gece yarisi cron'u) bu yuzden asla kesintiye ugramamali;
 * hata fastify.log'a (veya verilen log objesine) yazilir, {skipped:true,
 * reason:"error"} donulur.
 */

/**
 * Bir (driver_id, date) icin planlanan/tamamlanan ham sayilari tasks
 * tablosundan tek sorguda hesaplar.
 */
async function getRawCounts(client, driverId, date) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'rejected'))::int AS planned_count,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count
     FROM public.tasks
     WHERE driver_id = $1
       AND COALESCE(scheduled_start, created_at)::date = $2::date`,
    [driverId, date]
  );
  return rows[0] || { planned_count: 0, completed_count: 0 };
}

async function getExistingRow(client, driverId, date) {
  const { rows } = await client.query(
    `SELECT * FROM public.daily_trip_reconciliation
     WHERE driver_id = $1 AND reconciliation_date = $2::date`,
    [driverId, date]
  );
  return rows[0] || null;
}

/**
 * Bir (driver, gun) cifti icin reconciliation'i degerlendirir, satiri
 * upsert eder, ve (end-of-day ise ve uyusmazlik varsa) exception_events'e
 * kayit duser.
 *
 * @param {import('pg').PoolClient} client
 * @param {{warn: Function, error: Function, info?: Function}} log
 * @param {{companyId: string, driverId: string, date: string, isEndOfDay: boolean}} params
 */
async function evaluateDriverDay(client, log, { companyId, driverId, date, isEndOfDay }) {
  try {
    const existing = await getExistingRow(client, driverId, date);

    if (existing && existing.status !== "pending") {
      return { skipped: true, reason: "already_terminal", status: existing.status };
    }

    const raw = await getRawCounts(client, driverId, date);

    // Hic gorev yoksa (bu surucu o gun hic planlanmamis) islenecek bir sey
    // yok - satir bile olusturulmaz, gereksiz "0 planlanan, 0 tamamlanan
    // -> otomatik kapandi" gurultusunu onler.
    if (raw.planned_count === 0 && !existing) {
      return { skipped: true, reason: "no_tasks_that_day" };
    }

    const effectivePlanned =
      existing && existing.planned_count_override != null
        ? existing.planned_count_override
        : raw.planned_count;

    const isClosed = raw.completed_count >= effectivePlanned;

    if (isClosed) {
      const { rows } = await client.query(
        `INSERT INTO public.daily_trip_reconciliation
           (company_id, driver_id, reconciliation_date, planned_count, completed_count, status, closed_at, updated_at)
         VALUES ($1, $2, $3::date, $4, $5, 'closed_auto', NOW(), NOW())
         ON CONFLICT (driver_id, reconciliation_date) DO UPDATE SET
           planned_count = EXCLUDED.planned_count,
           completed_count = EXCLUDED.completed_count,
           status = 'closed_auto',
           closed_at = NOW(),
           updated_at = NOW()
         WHERE public.daily_trip_reconciliation.status = 'pending'
         RETURNING *`,
        [companyId, driverId, date, effectivePlanned, raw.completed_count]
      );
      return { outcome: "closed_auto", row: rows[0] };
    }

    if (!isEndOfDay) {
      // Gun henuz bitmedi, sayi henuz yetmiyor - bu NORMAL, exception
      // DEGIL. Sadece gorunurluk icin anlik sayilari guncelleyip beklet.
      await client.query(
        `INSERT INTO public.daily_trip_reconciliation
           (company_id, driver_id, reconciliation_date, planned_count, completed_count, status, updated_at)
         VALUES ($1, $2, $3::date, $4, $5, 'pending', NOW())
         ON CONFLICT (driver_id, reconciliation_date) DO UPDATE SET
           planned_count = EXCLUDED.planned_count,
           completed_count = EXCLUDED.completed_count,
           updated_at = NOW()
         WHERE public.daily_trip_reconciliation.status = 'pending'`,
        [companyId, driverId, date, effectivePlanned, raw.completed_count]
      );
      return { outcome: "pending", effectivePlanned, completed: raw.completed_count };
    }

    // isEndOfDay && !isClosed -> ADR §2-B / §B.2: gun otomatik kapanmaz,
    // exception_events'e kayit dusulur.
    const detectionPayload = {
      driverId,
      reconciliationDate: date,
      plannedCount: effectivePlanned,
      completedCount: raw.completed_count,
      overrideActive: !!existing && existing.planned_count_override != null,
    };

    const { rows: exceptionRows } = await client.query(
      `INSERT INTO enterprise.exception_events
         (company_id, driver_id, exception_type, severity, detection_payload, occurred_at)
       VALUES ($1, $2, 'trip_count_reconciliation_mismatch', 'medium', $3::jsonb, NOW())
       RETURNING id`,
      [companyId, driverId, JSON.stringify(detectionPayload)]
    );
    const exceptionEventId = exceptionRows[0]?.id || null;

    const { rows } = await client.query(
      `INSERT INTO public.daily_trip_reconciliation
         (company_id, driver_id, reconciliation_date, planned_count, completed_count, status, exception_event_id, closed_at, updated_at)
       VALUES ($1, $2, $3::date, $4, $5, 'exception_raised', $6, NOW(), NOW())
       ON CONFLICT (driver_id, reconciliation_date) DO UPDATE SET
         planned_count = EXCLUDED.planned_count,
         completed_count = EXCLUDED.completed_count,
         status = 'exception_raised',
         exception_event_id = EXCLUDED.exception_event_id,
         closed_at = NOW(),
         updated_at = NOW()
       WHERE public.daily_trip_reconciliation.status = 'pending'
       RETURNING *`,
      [companyId, driverId, date, effectivePlanned, raw.completed_count, exceptionEventId]
    );
    return { outcome: "exception_raised", exceptionEventId, row: rows[0] };
  } catch (error) {
    (log?.error || console.error)(
      { err: error, driverId, date, isEndOfDay },
      "[ADR-CE-04] evaluateDriverDay basarisiz (yutuldu, cagiran akis etkilenmedi)"
    );
    return { skipped: true, reason: "error", message: error.message };
  }
}

/**
 * Bir sefer "completed" oldugunda cagrilir (erken otomatik kapanis
 * kontrolu, bkz. dosya basligi). taskId'den driver_id/company_id/gun
 * kendisi cozer - cagiran taraf (server.js completion endpoint'i) sadece
 * taskId gecirir.
 */
async function reevaluateForTask(client, log, taskId) {
  try {
    const { rows } = await client.query(
      `SELECT driver_id, company_id, COALESCE(scheduled_start, created_at)::date AS reconciliation_date
       FROM public.tasks WHERE id = $1`,
      [taskId]
    );
    const task = rows[0];
    if (!task || !task.driver_id) {
      return { skipped: true, reason: "no_driver_on_task" };
    }
    return await evaluateDriverDay(client, log, {
      companyId: task.company_id,
      driverId: task.driver_id,
      date: task.reconciliation_date,
      isEndOfDay: false,
    });
  } catch (error) {
    (log?.error || console.error)(
      { err: error, taskId },
      "[ADR-CE-04] reevaluateForTask basarisiz (yutuldu)"
    );
    return { skipped: true, reason: "error", message: error.message };
  }
}

/**
 * Gece yarisi guvenlik-agi cron'u icin: verilen `date` icin en az bir
 * (iptal/reddedilmemis) gorevi olan HER surucuyu bulur ve her birini
 * isEndOfDay=true ile degerlendirir. Bir surucunun hatasi digerlerini
 * etkilemez (evaluateDriverDay zaten kendi try/catch'inde).
 *
 * @returns {Promise<{processed:number, closedAuto:number, exceptionRaised:number, pending:number, skipped:number, errors:number}>}
 */
async function runEndOfDayReconciliation(client, log, date) {
  const { rows: driverDays } = await client.query(
    `SELECT DISTINCT driver_id, company_id
     FROM public.tasks
     WHERE COALESCE(scheduled_start, created_at)::date = $1::date
       AND status NOT IN ('cancelled', 'rejected')
       AND driver_id IS NOT NULL`,
    [date]
  );

  const results = {
    processed: 0,
    closedAuto: 0,
    exceptionRaised: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
  };

  for (const row of driverDays) {
    const outcome = await evaluateDriverDay(client, log, {
      companyId: row.company_id,
      driverId: row.driver_id,
      date,
      isEndOfDay: true,
    });
    results.processed += 1;
    if (outcome.skipped) {
      if (outcome.reason === "error") results.errors += 1;
      else results.skipped += 1;
    } else if (outcome.outcome === "closed_auto") {
      results.closedAuto += 1;
    } else if (outcome.outcome === "exception_raised") {
      results.exceptionRaised += 1;
    } else if (outcome.outcome === "pending") {
      results.pending += 1;
    }
  }

  return results;
}

module.exports = {
  getRawCounts,
  evaluateDriverDay,
  reevaluateForTask,
  runEndOfDayReconciliation,
};
