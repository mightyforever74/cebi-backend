/**
 * tests/waypointGeofenceHelpers.test.js
 *
 * Waypoint Geofence Faz 1 — pure logic tests (no DB).
 *
 * Covers the 3 critical safeguards Cem flagged before TDD started:
 *   1. Null/empty/malformed waypoints JSONB must never crash (defensive guards).
 *   2. Waypoint order flexibility — when several unvisited waypoints match the
 *      same geofence_id, the one with the lowest `order` value wins (falls back
 *      to array position when `order` is missing), not just "first in array".
 *   3. route_bypass marking on task completion for required-but-unvisited
 *      waypoints.
 *
 * NOTE on a deliberate design choice (flagged for Cem's review): route_bypass
 * does NOT set `visited: true`. The waypoint genuinely was not visited — that
 * would be a lie. Instead it gets `completion_reason: "route_bypass"` and
 * `completed_at`, which is enough for the waypoint-summary endpoint to report
 * it as "resolved, but not actually visited". If Cem wants `visited: true` for
 * bypassed waypoints too (to simplify "is this waypoint done?" checks
 * elsewhere), that's a one-line change in applyRouteBypass.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeWaypoints,
  findGeofenceMatchIndex,
  applyGeofenceVisit,
  applyRouteBypass,
} = require("../services/waypointGeofenceHelpers");

// ── safeWaypoints ──────────────────────────────────────────────

test("safeWaypoints: null/undefined/non-array returns []", () => {
  assert.deepEqual(safeWaypoints(null), []);
  assert.deepEqual(safeWaypoints(undefined), []);
  assert.deepEqual(safeWaypoints("garbage"), []);
  assert.deepEqual(safeWaypoints(42), []);
  assert.deepEqual(safeWaypoints({}), []);
});

test("safeWaypoints: filters out null/non-object entries from an array", () => {
  const input = [null, { id: "a" }, "garbage", 5, { id: "b" }, undefined];
  assert.deepEqual(safeWaypoints(input), [{ id: "a" }, { id: "b" }]);
});

test("safeWaypoints: empty array stays empty", () => {
  assert.deepEqual(safeWaypoints([]), []);
});

// ── findGeofenceMatchIndex ─────────────────────────────────────

test("findGeofenceMatchIndex: null/non-array waypoints returns -1, never throws", () => {
  assert.equal(findGeofenceMatchIndex(null, "gf-1"), -1);
  assert.equal(findGeofenceMatchIndex(undefined, "gf-1"), -1);
  assert.equal(findGeofenceMatchIndex("garbage", "gf-1"), -1);
});

test("findGeofenceMatchIndex: missing/empty geofenceId returns -1", () => {
  const wps = [{ geofence_id: "gf-1", visited: false }];
  assert.equal(findGeofenceMatchIndex(wps, null), -1);
  assert.equal(findGeofenceMatchIndex(wps, undefined), -1);
  assert.equal(findGeofenceMatchIndex(wps, ""), -1);
});

test("findGeofenceMatchIndex: no matching geofence_id returns -1", () => {
  const wps = [
    { geofence_id: "gf-1", visited: false },
    { geofence_id: "gf-2", visited: false },
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-999"), -1);
});

test("findGeofenceMatchIndex: already-visited matching waypoint is skipped", () => {
  const wps = [{ geofence_id: "gf-1", visited: true, order: 1 }];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), -1);
});

test("findGeofenceMatchIndex: single unvisited match returns its index", () => {
  const wps = [
    { geofence_id: "gf-2", visited: false },
    { geofence_id: "gf-1", visited: false },
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), 1);
});

test("findGeofenceMatchIndex: multiple matches — lowest `order` wins regardless of array position", () => {
  const wps = [
    { geofence_id: "gf-1", visited: false, order: 5 }, // index 0
    { geofence_id: "gf-1", visited: false, order: 1 }, // index 1 — lowest order
    { geofence_id: "gf-1", visited: false, order: 3 }, // index 2
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), 1);
});

test("findGeofenceMatchIndex: multiple matches with missing `order` fall back to array index", () => {
  const wps = [
    { geofence_id: "gf-1", visited: false }, // no order → treated as index 0
    { geofence_id: "gf-1", visited: false }, // no order → treated as index 1
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), 0);
});

test("findGeofenceMatchIndex: visited match is skipped in favor of a later unvisited match with higher order", () => {
  const wps = [
    { geofence_id: "gf-1", visited: true, order: 1 },
    { geofence_id: "gf-1", visited: false, order: 9 },
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), 1);
});

test("findGeofenceMatchIndex: malformed entries in the array (null, non-object) are skipped without throwing", () => {
  const wps = [
    null,
    "garbage",
    5,
    { geofence_id: "gf-1", visited: false, order: 2 },
  ];
  assert.equal(findGeofenceMatchIndex(wps, "gf-1"), 3);
});

// ── applyGeofenceVisit ─────────────────────────────────────────

test("applyGeofenceVisit: null/non-array waypoints returns [] without throwing", () => {
  assert.deepEqual(applyGeofenceVisit(null, 0, "2026-10-11T10:00:00Z"), []);
  assert.deepEqual(
    applyGeofenceVisit("garbage", 0, "2026-10-11T10:00:00Z"),
    []
  );
});

test("applyGeofenceVisit: out-of-range index returns an unchanged copy", () => {
  const wps = [{ geofence_id: "gf-1", visited: false }];
  const result = applyGeofenceVisit(wps, 5, "2026-10-11T10:00:00Z");
  assert.deepEqual(result, wps);
  assert.notEqual(result, wps); // copy, not same reference
});

test("applyGeofenceVisit: marks only the targeted index as visited with geofence_trigger reason", () => {
  const wps = [
    { geofence_id: "gf-1", visited: false, order: 1, label: "Stop A" },
    { geofence_id: "gf-2", visited: false, order: 2, label: "Stop B" },
  ];
  const ts = "2026-10-11T10:00:00Z";
  const result = applyGeofenceVisit(wps, 0, ts);

  assert.equal(result[0].visited, true);
  assert.equal(result[0].visited_at, ts);
  assert.equal(result[0].completion_reason, "geofence_trigger");
  assert.equal(result[0].label, "Stop A"); // other fields preserved

  // untouched entry stays exactly as-is
  assert.deepEqual(result[1], wps[1]);

  // original array/object not mutated
  assert.equal(wps[0].visited, false);
});

// ── applyRouteBypass ───────────────────────────────────────────

test("applyRouteBypass: null/non-array waypoints returns {waypoints: [], bypassedCount: 0}", () => {
  assert.deepEqual(applyRouteBypass(null, "2026-10-11T12:00:00Z"), {
    waypoints: [],
    bypassedCount: 0,
  });
  assert.deepEqual(applyRouteBypass("garbage", "2026-10-11T12:00:00Z"), {
    waypoints: [],
    bypassedCount: 0,
  });
});

test("applyRouteBypass: required+unvisited waypoints get completion_reason/completed_at, NOT visited:true", () => {
  const ts = "2026-10-11T12:00:00Z";
  const wps = [
    { geofence_id: "gf-1", required: true, visited: false, order: 1 },
  ];
  const { waypoints: result, bypassedCount } = applyRouteBypass(wps, ts);

  assert.equal(bypassedCount, 1);
  assert.equal(result[0].completion_reason, "route_bypass");
  assert.equal(result[0].completed_at, ts);
  assert.equal(result[0].visited, false); // deliberately NOT lied about
});

test("applyRouteBypass: required+already-visited waypoints are left untouched", () => {
  const ts = "2026-10-11T12:00:00Z";
  const wps = [
    {
      geofence_id: "gf-1",
      required: true,
      visited: true,
      completion_reason: "geofence_trigger",
    },
  ];
  const { waypoints: result, bypassedCount } = applyRouteBypass(wps, ts);

  assert.equal(bypassedCount, 0);
  assert.deepEqual(result[0], wps[0]);
});

test("applyRouteBypass: non-required waypoints are left untouched whether visited or not", () => {
  const ts = "2026-10-11T12:00:00Z";
  const wps = [
    { geofence_id: "gf-1", required: false, visited: false },
    { geofence_id: "gf-2", required: false, visited: true },
  ];
  const { waypoints: result, bypassedCount } = applyRouteBypass(wps, ts);

  assert.equal(bypassedCount, 0);
  assert.deepEqual(result, wps);
});

test("applyRouteBypass: mixed array — only required+unvisited entries counted/modified", () => {
  const ts = "2026-10-11T12:00:00Z";
  const wps = [
    { id: "a", required: true, visited: false },
    { id: "b", required: true, visited: true },
    { id: "c", required: false, visited: false },
    { id: "d", required: true, visited: false },
  ];
  const { waypoints: result, bypassedCount } = applyRouteBypass(wps, ts);

  assert.equal(bypassedCount, 2);
  assert.equal(result[0].completion_reason, "route_bypass");
  assert.equal(result[1].completion_reason, undefined);
  assert.equal(result[2].completion_reason, undefined);
  assert.equal(result[3].completion_reason, "route_bypass");
});

test("applyRouteBypass: malformed entries (null, non-object) in the array are skipped without throwing", () => {
  const ts = "2026-10-11T12:00:00Z";
  const wps = [null, "garbage", { id: "a", required: true, visited: false }];
  const { waypoints: result, bypassedCount } = applyRouteBypass(wps, ts);

  assert.equal(bypassedCount, 1);
  assert.equal(result[0], null);
  assert.equal(result[1], "garbage");
  assert.equal(result[2].completion_reason, "route_bypass");
});

test("applyRouteBypass: does not mutate the original array or its objects", () => {
  const ts = "2026-10-11T12:00:00Z";
  const original = { id: "a", required: true, visited: false };
  const wps = [original];
  applyRouteBypass(wps, ts);
  assert.equal(original.completion_reason, undefined);
});
