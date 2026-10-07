"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fastify = require("fastify");
const publicTrackRoutes = require("../routes/publicTrack");

const TOKEN = "b".repeat(32);
const GEOMETRY = [
  [41.02, 28.98],
  [41.01, 29.0],
  [40.99, 29.03],
];

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function buildApp(options) {
  const state = {
    status: options.status,
    taskId: options.taskId,
    routeJson: options.routeJson === undefined ? null : options.routeJson,
    updates: 0,
    inserts: 0,
    hereCalls: 0,
    lastLocation: options.lastLocation || null,
    delayMs: options.delayMs || 0,
  };
  const provider = {
    async computeRoute() {
      state.hereCalls += 1;
      if (state.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      return {
        durationSec: 1080,
        baseDurationSec: 1000,
        delayMin: 1,
        incidents: [],
        geometry: GEOMETRY,
        distanceM: 12000,
      };
    },
  };

  const app = fastify({ logger: false });
  app.decorate("routingProvider", provider);
  app.decorate("pg", {
    async connect() {
      return {
        query: async (sql, params) => {
          const s = sql.replace(/\s+/g, " ").trim();
          if (s.includes("INSERT")) {
            state.inserts += 1;
            throw new Error("public read wrote task_events");
          }
          if (s.includes("FROM public_tracking_tokens") && s.startsWith("SELECT")) {
            return {
              rows: [
                {
                  token: TOKEN,
                  task_id: state.taskId,
                  is_revoked: false,
                  expires_at: hoursFromNow(24),
                },
              ],
            };
          }
          if (s.includes("SELECT status FROM tasks")) {
            return { rows: [{ status: state.status }] };
          }
          if (s.includes("task_no, title")) {
            return { rows: [{ task_no: "T-H", title: "Delivery" }] };
          }
          if (s.includes("vehicle_plate")) {
            return {
              rows: [
                {
                  task_no: "T-H",
                  status: state.status,
                  title: "Delivery",
                  start_location: "A",
                  end_location: "B",
                  waypoints: [],
                  actual_start: null,
                  actual_end: null,
                  vehicle_plate: "34-TEST",
                  route_json: state.routeJson,
                  pickup_location: { lat: 41.02, lng: 28.98, address: "Ambarli" },
                  dropoff_location: { lat: 40.99, lng: 29.03, address: "Kadikoy" },
                },
              ],
            };
          }
          if (s.includes("FROM task_events") && s.startsWith("SELECT")) {
            return { rows: [] };
          }
          if (s.includes("esp32_device_id")) {
            return { rows: [{ esp32_device_id: "dev-1" }] };
          }
          if (s.includes("ORDER BY time DESC LIMIT 1")) {
            return { rows: state.lastLocation ? [state.lastLocation] : [] };
          }
          if (s.includes("SELECT route_json FROM tasks")) {
            return { rows: [{ route_json: state.routeJson }] };
          }
          if (s.startsWith("UPDATE")) {
            state.updates += 1;
            state.updateSql = s;
            const patch = JSON.parse(params[1]);
            state.routeJson = Object.assign({}, state.routeJson || {}, patch);
            return { rows: [], rowCount: 1 };
          }
          throw new Error("unexpected sql: " + s);
        },
        async release() {},
      };
    },
  });
  await app.register(publicTrackRoutes);
  await app.ready();
  return { app, state };
}

async function getJson(app) {
  const res = await app.inject({ method: "GET", url: "/v/" + TOKEN + ".json" });
  assert.equal(res.statusCode, 200);
  return res.json();
}

test("route is cached under public_route and a second call makes no HERE request", async () => {
  const { app, state } = await buildApp({
    status: "assigned",
    taskId: "route-cache-1",
    routeJson: { distance: "18.5" },
  });
  try {
    const first = await getJson(app);
    assert.equal(first.eta, null);
    assert.equal(first.route.geometry.length, 3);
    assert.equal(state.hereCalls, 1);
    assert.equal(state.updates, 1);
    assert.match(state.updateSql, /'public_route'/);
    assert.equal(state.routeJson.distance, "18.5");
    assert.equal(state.routeJson.provider, undefined);
    assert.equal(state.routeJson.origin, undefined);
    assert.equal(state.routeJson.destination, undefined);
    assert.equal(state.routeJson.geometry, undefined);
    assert.equal(state.routeJson.distance_m, undefined);
    assert.equal(state.routeJson.duration_s, undefined);
    assert.equal(state.routeJson.computed_at, undefined);
    const cached = state.routeJson.public_route;
    assert.equal(cached.provider, "here");
    assert.equal(cached.distance_m, 12000);
    assert.equal(cached.duration_s, 1080);
    assert.equal(cached.geometry.length, 3);
    assert.ok(cached.origin);
    assert.ok(cached.computed_at);

    const second = await getJson(app);
    assert.equal(second.route.geometry.length, 3);
    assert.equal(second.eta, null);
    assert.equal(state.hereCalls, 1);
    assert.equal(state.updates, 1);
    assert.equal(state.inserts, 0);
  } finally {
    await app.close();
  }
});

test("concurrent first visits share one HERE request", async () => {
  const { app, state } = await buildApp({
    status: "assigned",
    taskId: "route-race-1",
    delayMs: 40,
  });
  try {
    const [left, right] = await Promise.all([getJson(app), getJson(app)]);
    assert.equal(left.route.geometry.length, 3);
    assert.equal(right.route.geometry.length, 3);
    assert.equal(state.hereCalls, 1);
    assert.equal(state.updates, 1);
    assert.equal(state.inserts, 0);
  } finally {
    await app.close();
  }
});

test("eta is only computed for in_progress and is cached for 60s", async () => {
  const assigned = await buildApp({
    status: "assigned",
    taskId: "eta-assigned",
    routeJson: {
      distance: "12",
      public_route: {
        origin: { lat: 41.02, lng: 28.98, label: "Ambarli" },
        destination: { lat: 40.99, lng: 29.03, label: "Kadikoy" },
        geometry: GEOMETRY,
        provider: "here",
      },
    },
    lastLocation: {
      latitude: 41.05,
      longitude: 29.05,
      speed: 40,
      heading: 90,
      time: new Date().toISOString(),
    },
  });
  try {
    const body = await getJson(assigned.app);
    assert.equal(body.eta, null);
    assert.equal(body.last_location, null);
    assert.equal(assigned.state.hereCalls, 0);
    assert.equal(assigned.state.inserts, 0);
  } finally {
    await assigned.app.close();
  }

  const live = await buildApp({
    status: "in_progress",
    taskId: "eta-live",
    routeJson: {
      distance: "12",
      public_route: {
        origin: { lat: 41.02, lng: 28.98, label: "Ambarli" },
        destination: { lat: 40.99, lng: 29.03, label: "Kadikoy" },
        geometry: GEOMETRY,
        provider: "here",
      },
    },
    lastLocation: {
      latitude: 41.05,
      longitude: 29.05,
      speed: 40,
      heading: 90,
      time: new Date().toISOString(),
    },
  });
  try {
    const first = await getJson(live.app);
    assert.equal(first.eta.source, "here");
    assert.equal(first.eta.minutes, 18);
    assert.equal(typeof first.eta.arrival_at, "string");
    assert.equal(first.eta.stale, undefined);
    assert.equal(live.state.hereCalls, 1);
    const second = await getJson(live.app);
    assert.equal(second.eta.source, "here");
    assert.equal(live.state.hereCalls, 1);
    assert.equal(live.state.inserts, 0);
  } finally {
    await live.app.close();
  }
});

test("eta short-circuits within 50m and marks a location older than 10 minutes stale", async () => {
  const near = await buildApp({
    status: "in_progress",
    taskId: "eta-near",
    routeJson: {
      distance: "12",
      public_route: {
        origin: { lat: 41.02, lng: 28.98, label: "Ambarli" },
        destination: { lat: 40.99, lng: 29.03, label: "Kadikoy" },
        geometry: GEOMETRY,
        provider: "here",
      },
    },
    lastLocation: {
      latitude: 40.99,
      longitude: 29.03,
      speed: 0,
      heading: 0,
      time: new Date().toISOString(),
    },
  });
  try {
    const body = await getJson(near.app);
    assert.equal(body.eta.minutes, 0);
    assert.equal(body.eta.source, "proximity");
    assert.equal(typeof body.eta.arrival_at, "string");
    assert.equal(near.state.hereCalls, 0);
    assert.equal(near.state.inserts, 0);
  } finally {
    await near.app.close();
  }

  const stale = await buildApp({
    status: "in_progress",
    taskId: "eta-stale",
    routeJson: {
      distance: "12",
      public_route: {
        origin: { lat: 41.02, lng: 28.98, label: "Ambarli" },
        destination: { lat: 40.99, lng: 29.03, label: "Kadikoy" },
        geometry: GEOMETRY,
        provider: "here",
      },
    },
    lastLocation: {
      latitude: 41.05,
      longitude: 29.05,
      speed: 10,
      heading: 90,
      time: minutesAgo(11),
    },
  });
  try {
    const body = await getJson(stale.app);
    assert.equal(body.eta.source, "here");
    assert.equal(body.eta.stale, true);
    assert.equal(stale.state.hereCalls, 1);
    assert.equal(stale.state.inserts, 0);
  } finally {
    await stale.app.close();
  }
});

test("the page draws road geometry when present and formats ETA", async () => {
  const { app } = await buildApp({
    status: "assigned",
    taskId: "route-html",
    routeJson: {
      geometry: GEOMETRY,
    },
  });
  try {
    const page = await app.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /L\.polyline\(line,/);
    assert.match(page.body, /L\.polyline\(\[origin, dest\]/);
    assert.ok(
      page.body.includes(
        "var text = 'ETA ' + hh + ':' + mm + ' (~' + eta.minutes + ' min)'"
      )
    );
  } finally {
    await app.close();
  }
});
