"use strict";

/**
 * tests/tripReconciliation.test.js
 * ADR-CE-04 §2-B/§B.1/§B.2/§B.3 — gün-seviyesi sefer kapanış reconciliation.
 *
 * fakeClient deseni bu repodaki diğer testlerle aynı (bkz.
 * tests/telematicsBatches.test.js) — gerçek DB yok, her çağrıyı sql metni
 * üzerinden ayırt edip canned sonuç döner, beklenmeyen bir sorgu throw eder.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateDriverDay,
  reevaluateForTask,
  runEndOfDayReconciliation,
} = require("../services/reconciliation/tripReconciliation");

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

const noopLog = { error: () => {}, warn: () => {}, info: () => {} };

test("evaluateDriverDay: tamamlanan >= planlanan, erken tetikleyici (isEndOfDay=false) -> closed_auto", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [] }; // ilk kez degerlendiriliyor
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 2, completed_count: 2 }] };
    }
    if (sql.includes("'closed_auto'")) {
      return { rows: [{ id: "recon-1", status: "closed_auto" }] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: false,
  });

  assert.equal(outcome.outcome, "closed_auto");
  assert.equal(outcome.row.status, "closed_auto");
});

test("evaluateDriverDay: tamamlanan < planlanan, erken tetikleyici -> 'pending' kalir, ISTISNA OLUSTURULMAZ", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [] };
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 2, completed_count: 1 }] };
    }
    if (sql.includes("VALUES ($1, $2, $3::date, $4, $5, 'pending'")) {
      return { rows: [] };
    }
    throw new Error("unexpected sql (beklenmeyen - erken tetikleyici exception_events'e yazmamali): " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: false,
  });

  assert.equal(outcome.outcome, "pending");
  assert.ok(!client.calls.some((c) => c.sql.includes("enterprise.exception_events")));
});

test("evaluateDriverDay: tamamlanan < planlanan, gece yarisi cron'u (isEndOfDay=true) -> exception_raised", async () => {
  const client = fakeClient((sql, params) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [] };
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 2, completed_count: 1 }] };
    }
    if (sql.includes("INSERT INTO enterprise.exception_events")) {
      assert.equal(params.length, 3); // company_id, driver_id, detection_payload (exception_type/severity SQL literal)
      const payload = JSON.parse(params[2]);
      assert.equal(payload.plannedCount, 2);
      assert.equal(payload.completedCount, 1);
      return { rows: [{ id: "exc-1" }] };
    }
    if (sql.includes("'exception_raised'")) {
      return { rows: [{ id: "recon-1", status: "exception_raised", exception_event_id: "exc-1" }] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: true,
  });

  assert.equal(outcome.outcome, "exception_raised");
  assert.equal(outcome.exceptionEventId, "exc-1");
});

test("evaluateDriverDay: zaten terminal (closed_auto) -> yeniden islenmez, raw sayim sorgusu bile atilmaz", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [{ id: "recon-1", status: "closed_auto", planned_count_override: null }] };
    }
    throw new Error("unexpected sql (idempotency ihlali - terminal satir yeniden islendi): " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: true,
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "already_terminal");
  assert.equal(client.calls.length, 1);
});

test("evaluateDriverDay: override aktifse ham planlanan sayi yerine override kullanilir", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [{ id: "recon-1", status: "pending", planned_count_override: 1 }] };
    }
    if (sql.includes("AS planned_count")) {
      // ham veri 3 planlanan gosteriyor ama override 1'e sabitledi
      return { rows: [{ planned_count: 3, completed_count: 1 }] };
    }
    if (sql.includes("'closed_auto'")) {
      return { rows: [{ id: "recon-1", status: "closed_auto", planned_count: 1 }] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: false,
  });

  assert.equal(outcome.outcome, "closed_auto");
  assert.equal(outcome.row.planned_count, 1);
});

test("evaluateDriverDay: o gun hic gorev yoksa (planned_count=0, kayit yok) atlanir, hicbir satir olusturulmaz", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [] };
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 0, completed_count: 0 }] };
    }
    throw new Error("unexpected sql (gereksiz bir satir yazilmaya calisildi): " + sql);
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: true,
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "no_tasks_that_day");
});

test("evaluateDriverDay: DB hatasi throw etmez, {skipped:true, reason:'error'} doner", async () => {
  const client = fakeClient(() => {
    throw new Error("connection lost");
  });

  const outcome = await evaluateDriverDay(client, noopLog, {
    companyId: "co-1",
    driverId: "drv-1",
    date: "2026-10-19",
    isEndOfDay: true,
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "error");
});

test("reevaluateForTask: task'tan driver_id/company_id/gun cozup evaluateDriverDay'e devreder", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("AS reconciliation_date")) {
      return {
        rows: [{ driver_id: "drv-1", company_id: "co-1", reconciliation_date: "2026-10-19" }],
      };
    }
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      return { rows: [] };
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 1, completed_count: 1 }] };
    }
    if (sql.includes("'closed_auto'")) {
      return { rows: [{ id: "recon-1", status: "closed_auto" }] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await reevaluateForTask(client, noopLog, "task-1");
  assert.equal(outcome.outcome, "closed_auto");
});

test("reevaluateForTask: task/driver bulunamazsa atlanir", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("AS reconciliation_date")) {
      return { rows: [] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const outcome = await reevaluateForTask(client, noopLog, "task-does-not-exist");
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, "no_driver_on_task");
});

test("runEndOfDayReconciliation: birden fazla surucuyu isler, biri hata verse bile digeri etkilenmez", async () => {
  const client = fakeClient((sql, params) => {
    if (sql.includes("SELECT DISTINCT driver_id, company_id")) {
      return {
        rows: [
          { driver_id: "drv-ok", company_id: "co-1" },
          { driver_id: "drv-err", company_id: "co-1" },
        ],
      };
    }
    if (sql.includes("SELECT * FROM public.daily_trip_reconciliation")) {
      if (params[0] === "drv-err") throw new Error("boom");
      return { rows: [] };
    }
    if (sql.includes("AS planned_count")) {
      return { rows: [{ planned_count: 2, completed_count: 2 }] };
    }
    if (sql.includes("'closed_auto'")) {
      return { rows: [{ id: "recon-ok", status: "closed_auto" }] };
    }
    throw new Error("unexpected sql: " + sql);
  });

  const result = await runEndOfDayReconciliation(client, noopLog, "2026-10-19");

  assert.equal(result.processed, 2);
  assert.equal(result.closedAuto, 1);
  assert.equal(result.errors, 1);
});
