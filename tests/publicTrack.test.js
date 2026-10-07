"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fastify = require("fastify");
const publicTrackRoutes = require("../routes/publicTrack");
const {
  publicTrackUrl,
  timingSafeTokenEqual,
} = require("../routes/publicTrack");

const TOKEN = "a".repeat(32);

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function statusFor(mode) {
  if (mode === "completed") return "completed";
  if (mode === "assigned" || mode === "dispatch") return "assigned";
  return "in_progress";
}

function idKeys(value, found) {
  if (Array.isArray(value)) {
    value.forEach((item) => idKeys(item, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || key.endsWith("_id")) found.push(key);
    idKeys(child, found);
  }
  return found;
}

function assertNoIndex(res, referrerPolicy) {
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], referrerPolicy || "no-referrer");
}

function queryFor(mode) {
  return async function query(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.includes("FROM public_tracking_tokens") && s.startsWith("SELECT")) {
      if (mode === "missing") return { rows: [] };
      return {
        rows: [
          {
            token: TOKEN,
            task_id: "task-1",
            is_revoked: mode === "revoked",
            expires_at: mode === "expired" ? hoursFromNow(-1) : hoursFromNow(24),
          },
        ],
      };
    }
    if (s.includes("SELECT status FROM tasks")) {
      return { rows: [{ status: statusFor(mode) }] };
    }
    if (s.includes("task_no, title")) {
      return { rows: [{ task_no: "T-1", title: "Delivery" }] };
    }
    if (s.includes("vehicle_plate")) {
      return {
        rows: [
          {
            id: "task-1",
            driver_id: "driver-1",
            company_id: "company-1",
            task_no: "T-1",
            status: statusFor(mode),
            title: "Delivery",
            start_location: "A",
            end_location: "B",
            waypoints: [
              {
                id: "wp-1",
                vehicle_id: "veh-1",
                name: "Pickup",
                latitude: 41,
                longitude: 29,
                status: "pending",
              },
            ],
            actual_start: null,
            actual_end: null,
            vehicle_plate: "34-TEST",
            route_json: null,
            pickup_location:
              mode === "dispatch"
                ? { lat: 41.02, lng: 28.98, address: "Ambarli", id: "loc-1" }
                : null,
            dropoff_location:
              mode === "dispatch"
                ? {
                    lat: 40.99,
                    lng: 29.03,
                    address: "Kadikoy",
                    location_id: "loc-2",
                  }
                : null,
          },
        ],
      };
    }
    if (s.includes("FROM task_events") && s.startsWith("SELECT")) {
      return {
        rows: [
          {
            id: "evt-1",
            stop_id: "stop-1",
            type: "TASK_STARTED",
            message: "started",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    }
    if (s.includes("esp32_device_id")) {
      return { rows: [{ esp32_device_id: "dev-1" }] };
    }
    if (s.includes("ORDER BY time DESC LIMIT 1")) {
      return {
        rows: [
          {
            latitude: 41.01,
            longitude: 29.01,
            speed: 40,
            heading: 90,
            time: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    }
    if (s.includes("AVG(COALESCE(speed,0))")) return { rows: [{ avg_speed: 0 }] };
    if (s.includes("LIMIT 2")) return { rows: [] };
    if (s.includes("STOP_DELAYED")) return { rows: [] };
    if (s.includes("SELECT route_json FROM tasks")) {
      return { rows: [{ route_json: null }] };
    }
    if (s.startsWith("UPDATE")) return { rows: [], rowCount: 0 };
    throw new Error("unexpected sql: " + s);
  };
}

async function buildApp(mode) {
  const app = fastify({ logger: false });
  const query = queryFor(mode);
  app.decorate("pg", {
    async connect() {
      return {
        query,
        async release() {},
      };
    },
  });
  await app.register(publicTrackRoutes);
  await app.ready();
  return app;
}

test("timingSafeTokenEqual ignores length mismatch without throwing", () => {
  assert.equal(timingSafeTokenEqual("abcd", "abcd"), true);
  assert.equal(timingSafeTokenEqual("abcd", "abc"), false);
  assert.equal(timingSafeTokenEqual("abc", "abcd"), false);
  assert.equal(timingSafeTokenEqual("", "abcd"), false);
});

test("public track url uses PUBLIC_TRACK_BASE_URL or the default", () => {
  const prev = process.env.PUBLIC_TRACK_BASE_URL;
  delete process.env.PUBLIC_TRACK_BASE_URL;
  assert.equal(
    publicTrackUrl("abc"),
    "https://track.tulipfleet.com/v/abc"
  );
  process.env.PUBLIC_TRACK_BASE_URL = "https://example.test/v/";
  assert.equal(publicTrackUrl("abc"), "https://example.test/v/abc");
  if (prev === undefined) delete process.env.PUBLIC_TRACK_BASE_URL;
  else process.env.PUBLIC_TRACK_BASE_URL = prev;
});

test("valid token returns 200 on /v and the legacy path", async () => {
  const app = await buildApp("valid");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "eta",
      "events",
      "last_location",
      "route",
      "task",
      "updated_at",
      "waypoints",
    ]);
    assert.equal(body.task.status, "in_progress");
    assert.equal(body.task.task_no, "T-1");
    assert.equal(body.task.id, undefined);
    assert.deepEqual(idKeys(body, []), []);
    assert.ok(body.last_location);
    assert.equal(body.last_location.latitude, 41.01);
    assertNoIndex(res);

    const legacy = await app.inject({
      method: "GET",
      url: "/public/track/" + TOKEN + ".json",
    });
    assert.equal(legacy.statusCode, 200);

    const page = await app.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"], /text\/html;\s*charset=utf-8/i);
    assert.match(page.body, /<meta charset="utf-8">/);
    assert.match(page.body, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
    assert.match(page.body, /<title>TulipFleet — T-1<\/title>/);
    assert.match(page.body, /referrerPolicy:\s*'strict-origin'/);
    assert.match(page.body, new RegExp("/v/" + TOKEN + "\\.json"));
    assertNoIndex(page, "strict-origin-when-cross-origin");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
  } finally {
    await app.close();
  }
});

test("revoked token returns the same 404", async () => {
  const app = await buildApp("revoked");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "Invalid or expired link" });
    assertNoIndex(res);
  } finally {
    await app.close();
  }
});

test("expired token returns the same 404", async () => {
  const app = await buildApp("expired");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "Invalid or expired link" });
  } finally {
    await app.close();
  }
});

test("completed task returns the same 404", async () => {
  const app = await buildApp("completed");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "Invalid or expired link" });
  } finally {
    await app.close();
  }
});

test("dispatcher task without route_json uses enterprise pickup and dropoff", async () => {
  const app = await buildApp("dispatch");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.route.origin, {
      lat: 41.02,
      lng: 28.98,
      label: "Ambarli",
    });
    assert.deepEqual(body.route.destination, {
      lat: 40.99,
      lng: 29.03,
      label: "Kadikoy",
    });
    assert.equal(body.last_location, null);
    assert.deepEqual(idKeys(body, []), []);
    assertNoIndex(res);

    const page = await app.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /stop-marker stop-origin/);
    assert.match(page.body, /stop-marker stop-destination/);
    assert.match(page.body, /L\.polyline\(\[origin, dest\]/);
    assert.match(page.body, /lat === 0 && lng === 0/);
  } finally {
    await app.close();
  }
});

test("assigned task hides live location and the 404 page is utf-8", async () => {
  const app = await buildApp("assigned");
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.task.status, "assigned");
    assert.equal(body.last_location, null);
    assert.equal(body.eta, null);
    assert.equal(body.waypoints[0].name, "Pickup");
    assert.deepEqual(idKeys(body, []), []);
    assertNoIndex(res);

    const page = await app.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"], /charset=utf-8/i);
    assert.match(page.body, /Araç yola çıktığında canlı konum burada görünecek/);
    assert.match(page.body, /"assigned":"Atandı"/);
    assertNoIndex(page, "strict-origin-when-cross-origin");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
  } finally {
    await app.close();
  }

  const missing = await buildApp("missing");
  try {
    const html = await missing.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(html.statusCode, 404);
    assert.match(html.headers["content-type"], /text\/html;\s*charset=utf-8/i);
    assert.match(html.body, /<meta charset="utf-8">/);
    assert.match(html.body, /<title>TulipFleet — Link geçersiz<\/title>/);
    assert.match(html.body, /Link geçersiz veya süresi dolmuş/);
    assert.equal(html.body.includes("geÃ"), false);
    assert.match(html.body, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
    assertNoIndex(html, "strict-origin-when-cross-origin");

    const legacy = await missing.inject({
      method: "GET",
      url: "/public/track/" + TOKEN,
    });
    assert.equal(legacy.statusCode, 404);
    assert.match(legacy.headers["content-type"], /charset=utf-8/i);
    assertNoIndex(legacy, "strict-origin-when-cross-origin");
  } finally {
    await missing.close();
  }
});

test("unknown token and a different length both return 404", async () => {
  const app = await buildApp("missing");
  try {
    const missing = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    const short = await app.inject({
      method: "GET",
      url: "/v/ab.json",
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(short.statusCode, 404);
    assert.deepEqual(missing.json(), short.json());
  } finally {
    await app.close();
  }
});

test("the 61st request on one IP returns 429 with a fixed body", async () => {
  const app = await buildApp("valid");
  try {
    let limited;
    for (let i = 1; i <= 61; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v/" + TOKEN + ".json",
      });
      if (i <= 60) {
        assert.equal(res.statusCode, 200, "request " + i);
      } else {
        limited = res;
      }
    }
    assert.equal(limited.statusCode, 429);
    const again = await app.inject({
      method: "GET",
      url: "/v/" + TOKEN + ".json",
    });
    assert.equal(again.statusCode, 429);
    assert.deepEqual(again.json(), limited.json());
    assert.equal(limited.json().message, "Too many requests");
  } finally {
    await app.close();
  }
});
