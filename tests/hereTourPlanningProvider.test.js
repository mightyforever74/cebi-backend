"use strict";

/**
 * HereTourPlanningProvider.js (Faz A-3, 2026-10-19) kablolama testi.
 *
 * Gerçek HERE Tour Planning çağrısı YAPILMAZ (ücretli dış servis, hesap
 * yetkisi henüz canlıda doğrulanmadı — bkz. HereTourPlanningProvider.js
 * başlık yorumu). Bunun yerine `httpClient` enjekte edilip submitVrp ->
 * pollVrp (inProgress -> success) -> fetchVrp zinciri, gerçek HERE'in
 * dönebileceği gerçek şekillerle (statusId/href, status/resource,
 * statistic/tours) doğrulanır. Faz A-2'nin canlı e2e script'inin
 * (scripts/dev/cebi_dispatcher_faza2_vrp_e2e_test.sh) kapsayamadığı katman
 * budur: HTTP sözleşmesi + DB state machine, dış servis maliyeti olmadan.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const HereTourPlanningProvider = require("../lib/routing/HereTourPlanningProvider");

function makeFakeDb() {
  const routingJobs = new Map();
  const vehicleRows = [
    {
      id: "veh-1",
      company_id: "co-1",
      cargo_capacity_volume_m3: 5,
      cargo_capacity_weight_kg: 1000,
      hazmat_certified_classes: [],
      latitude: 40.9,
      longitude: 28.9,
    },
  ];
  const dispatchTasks = [
    { id: "task-1", pickup_location: { lat: 41.0, lng: 29.0 }, dropoff_location: { lat: 41.1, lng: 29.1 } },
  ];

  return {
    async query(sql, params) {
      if (sql.includes("FROM public.vehicles v") && sql.includes("LEFT JOIN LATERAL")) {
        const [companyId, ids] = params;
        const rows = vehicleRows.filter((v) => v.company_id === companyId && ids.includes(v.id));
        return { rows };
      }
      if (sql.includes("SELECT id, status FROM enterprise.routing_jobs")) {
        return { rows: [] }; // dedup: hiç eşleşme yok (test her zaman temiz başlar)
      }
      if (sql.startsWith("INSERT INTO enterprise.routing_jobs")) {
        const [id, company_id, provider_job_id, request_hash, status, request_payload, error_message] = params;
        routingJobs.set(id, {
          id,
          company_id,
          provider_job_id,
          request_hash,
          status,
          request_payload: JSON.parse(request_payload),
          error_message,
        });
        return { rows: [] };
      }
      if (sql.includes("SELECT status, provider_job_id, error_message, request_payload FROM enterprise.routing_jobs")) {
        const row = routingJobs.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("UPDATE enterprise.routing_jobs SET status = 'running'")) {
        const row = routingJobs.get(params[0]);
        if (row && row.status === "submitted") row.status = "running";
        return { rows: [] };
      }
      if (sql.includes("SELECT id, pickup_location, dropoff_location") && sql.includes("dispatch_tasks")) {
        return { rows: dispatchTasks };
      }
      if (sql.startsWith("UPDATE enterprise.routing_jobs") && sql.includes("status = 'completed'")) {
        const [response_payload, provider_job_id, id] = params;
        const row = routingJobs.get(id);
        row.status = "completed";
        row.response_payload = JSON.parse(response_payload);
        return { rows: [] };
      }
      if (sql.includes("SELECT status, response_payload FROM enterprise.routing_jobs")) {
        const row = routingJobs.get(params[0]);
        return { rows: row ? [{ status: row.status, response_payload: row.response_payload }] : [] };
      }
      throw new Error("Unhandled fake query: " + sql.slice(0, 80));
    },
  };
}

function makeFakeHttp() {
  const calls = { post: 0, status: 0, solution: 0 };
  return {
    calls,
    async post(url, body, config) {
      calls.post++;
      assert.equal(url.endsWith("/problems/async"), true, "submitVrp must POST to /problems/async");
      assert.equal(config.params.apikey, "fake-key", "apikey query-param must carry the configured key");
      assert.deepEqual(Object.keys(body).sort(), ["fleet", "plan"], "HERE problem body must be {fleet, plan}");
      return { status: 202, data: { statusId: "status-abc", href: "https://tourplanning.hereapi.com/v3/status/status-abc" } };
    },
    async get(url, config) {
      assert.equal(config.params.apikey, "fake-key", "apikey query-param must carry the configured key on GET too");
      if (url.endsWith("/status/status-abc")) {
        calls.status++;
        if (calls.status < 2) return { status: 200, data: { status: "inProgress" } };
        return { status: 200, data: { status: "success", resource: { resourceId: "res-xyz" } } };
      }
      if (url.endsWith("/problems/res-xyz/solution")) {
        calls.solution++;
        return {
          status: 200,
          data: {
            statistic: { distance: 12345, duration: 678 },
            tours: [{ typeId: "veh-1", stops: [{ id: "s1" }] }],
          },
        };
      }
      throw new Error("Unexpected GET " + url);
    },
  };
}

test("HereTourPlanningProvider: submitVrp -> pollVrp (inProgress->success) -> fetchVrp", async () => {
  const db = makeFakeDb();
  const http = makeFakeHttp();
  const provider = new HereTourPlanningProvider(db, { apiKey: "fake-key", httpClient: http });

  const problem = {
    company_id: "co-1",
    tasks: [{ id: "task-1", pickup_location: { lat: 41.0, lng: 29.0 }, dropoff_location: { lat: 41.1, lng: 29.1 } }],
    vehicles: ["veh-1"],
  };

  const submitRes = await provider.submitVrp(problem, db);
  assert.equal(submitRes.status, "submitted");
  assert.equal(submitRes.triggerBackground, null, "gerçek sağlayıcıda arka plan simülasyonu olmamalı");

  const poll1 = await provider.pollVrp(submitRes.jobId);
  assert.equal(poll1.status, "running", "HERE inProgress -> job running'e geçmeli");

  const poll2 = await provider.pollVrp(submitRes.jobId);
  assert.equal(poll2.status, "completed", "HERE success -> job completed'e geçmeli");

  const result = await provider.fetchVrp(submitRes.jobId);
  assert.equal(result.solver, "here-tour-planning-v3");
  assert.equal(result.summary.total_distance_meters, 12345);
  assert.equal(result.summary.total_duration_seconds, 678);
  assert.deepEqual(result.available_vehicles, ["veh-1"]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "task-1");
  assert.ok(result.here_raw_solution, "denetim için ham HERE çözümü saklanmalı");

  assert.equal(http.calls.post, 1, "submitVrp tam olarak bir HERE POST atmalı");
  assert.equal(http.calls.status, 2, "pollVrp iki kez status sorgulamalı (inProgress, success)");
  assert.equal(http.calls.solution, 1, "solution tam olarak bir kez çekilmeli (fetchVrp ikinci bir HERE çağrısı yapmamalı)");
});

test("HereTourPlanningProvider: API key yoksa job 'failed' olur, HERE'e hiç istek atılmaz", async () => {
  const db = makeFakeDb();
  const http = makeFakeHttp();
  const provider = new HereTourPlanningProvider(db, { apiKey: null, httpClient: http });

  const problem = {
    company_id: "co-1",
    tasks: [{ id: "task-1", pickup_location: { lat: 41.0, lng: 29.0 }, dropoff_location: { lat: 41.1, lng: 29.1 } }],
    vehicles: ["veh-1"],
  };

  const submitRes = await provider.submitVrp(problem, db);
  assert.equal(submitRes.status, "failed");
  assert.equal(http.calls.post, 0, "API key yoksa HERE'e hiç para harcayan istek atılmamalı");
});

test("HereTourPlanningProvider: HERE 400 yanıtı submitVrp'yi throw etmez, job 'failed' olarak kaydedilir", async () => {
  const db = makeFakeDb();
  const http = makeFakeHttp();
  http.post = async () => {
    const err = new Error("Bad Request");
    err.response = { status: 400, data: { title: "OpenApi validation error", violations: [{ field: "fleet.types[0].costs" }] } };
    throw err;
  };
  const provider = new HereTourPlanningProvider(db, { apiKey: "fake-key", httpClient: http });

  const problem = {
    company_id: "co-1",
    tasks: [{ id: "task-1", pickup_location: { lat: 41.0, lng: 29.0 }, dropoff_location: { lat: 41.1, lng: 29.1 } }],
    vehicles: ["veh-1"],
  };

  const submitRes = await provider.submitVrp(problem, db);
  assert.equal(submitRes.status, "failed");
  assert.equal(submitRes.triggerBackground, null);
});
