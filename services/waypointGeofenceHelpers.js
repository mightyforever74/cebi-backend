/**
 * services/waypointGeofenceHelpers.js
 *
 * Waypoint Geofence Faz 1 — pure, DB-free logic for linking a task's
 * `waypoints` JSONB array to resolved geofence zones (WAYPOINT_GEOFENCE_SPEC.md).
 *
 * Deliberately has NO database/network access so it can be unit-tested in
 * isolation (tests/waypointGeofenceHelpers.test.js) and reused identically by:
 *   - services/geofenceService.js → handleGeofenceEvent (MQTT "entry" event
 *     auto-visits the matching waypoint via applyGeofenceVisit)
 *   - server.js → PUT /api/driver/tasks/:id/complete (closes out any
 *     required-but-unvisited waypoints via applyRouteBypass)
 *
 * `geofence_id` on a waypoint is the geofence's UUID (`geofences.id`), matching
 * the existing `geofence_violations.geofence_id` column convention — confirmed
 * with Cem.
 *
 * Design note on route_bypass (flagged for Cem's review): a bypassed waypoint
 * gets `completion_reason: "route_bypass"` + `completed_at`, but NOT
 * `visited: true` — it genuinely wasn't visited, and setting visited:true would
 * misrepresent that. Anything reading "is this waypoint resolved?" should check
 * `visited === true || completion_reason === "route_bypass"`, not `visited`
 * alone. If a simpler single-boolean check is preferred instead, this is a
 * one-line change.
 */
"use strict";

function safeWaypoints(waypoints) {
  if (!Array.isArray(waypoints)) return [];
  return waypoints.filter((wp) => wp !== null && typeof wp === "object");
}

/**
 * Finds the index (in the ORIGINAL array, not a filtered copy) of the
 * best unvisited waypoint matching `geofenceId`. "Best" = lowest `order`
 * value among matches; waypoints with no `order` field fall back to their
 * array index so ordering stays deterministic either way. Already-visited
 * matches are skipped. Returns -1 when there's no eligible match, including
 * for null/non-array input or a missing geofenceId — never throws.
 */
function findGeofenceMatchIndex(waypoints, geofenceId) {
  if (!Array.isArray(waypoints) || !geofenceId) return -1;

  let bestIdx = -1;
  let bestOrder = Infinity;
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (!wp || typeof wp !== "object") continue;
    if (wp.geofence_id !== geofenceId) continue;
    if (wp.visited === true) continue;

    const order = typeof wp.order === "number" ? wp.order : i;
    if (order < bestOrder) {
      bestOrder = order;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Returns a NEW waypoints array with the entry at `index` marked visited via
 * a geofence trigger. Never mutates the input. Out-of-range index (or
 * null/non-array input) returns a safe copy/[] unchanged.
 */
function applyGeofenceVisit(waypoints, index, timestamp) {
  if (!Array.isArray(waypoints)) return [];
  if (index < 0 || index >= waypoints.length) return waypoints.slice();

  const ts = timestamp || new Date().toISOString();
  return waypoints.map((wp, i) => {
    if (i !== index || !wp || typeof wp !== "object") return wp;
    return {
      ...wp,
      visited: true,
      visited_at: ts,
      completion_reason: "geofence_trigger",
    };
  });
}

/**
 * On task completion: closes out every required-but-unvisited waypoint as
 * "route_bypass" (see design note above — does NOT set visited:true). Never
 * mutates the input. Returns { waypoints, bypassedCount } so callers can log
 * how many stops were skipped.
 */
function applyRouteBypass(waypoints, timestamp) {
  if (!Array.isArray(waypoints)) return { waypoints: [], bypassedCount: 0 };

  const ts = timestamp || new Date().toISOString();
  let bypassedCount = 0;
  const result = waypoints.map((wp) => {
    if (!wp || typeof wp !== "object") return wp;
    if (wp.required === true && wp.visited !== true) {
      bypassedCount++;
      return {
        ...wp,
        completion_reason: "route_bypass",
        completed_at: ts,
      };
    }
    return wp;
  });
  return { waypoints: result, bypassedCount };
}

module.exports = {
  safeWaypoints,
  findGeofenceMatchIndex,
  applyGeofenceVisit,
  applyRouteBypass,
};
