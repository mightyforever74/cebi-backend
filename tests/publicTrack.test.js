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
      return {
        rows: [{ status: mode === "completed" ? "completed" : "in_progress" }],
      };
    }
    if (s.includes("task_no, title")) {
      return { rows: [{ task_no: "T-1", title: "Delivery" }] };
    }
    if (s.includes("vehicle_plate")) {
      return {
        rows: [
          {
            id: "task-1",
            task_no: "T-1",
            status: "in_progress",
            title: "Delivery",
            start_location: "A",
            end_location: "B",
            waypoints: [],
            actual_start: null,
            actual_end: null,
            vehicle_plate: "34-TEST",
          },
        ],
      };
    }
    if (s.includes("FROM task_events")) return { rows: [] };
    if (s.includes("esp32_device_id")) return { rows: [{ esp32_device_id: null }] };
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
      "task",
      "updated_at",
      "waypoints",
    ]);
    assert.equal(body.task.status, "in_progress");
    assert.equal(body.last_location, null);

    const legacy = await app.inject({
      method: "GET",
      url: "/public/track/" + TOKEN + ".json",
    });
    assert.equal(legacy.statusCode, 200);

    const page = await app.inject({ method: "GET", url: "/v/" + TOKEN });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.body, new RegExp("/v/" + TOKEN + "\\.json"));
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
