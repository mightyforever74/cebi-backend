"use strict";

/**
 * routes/vehicleCapacityHelpers.js
 *
 * FEAT-020 Phase 1.1 — Vehicle cargo capacity data collection (Cem,
 * 2026-10-12, gatekeeping finding: FEAT-020's own spec is still "pending",
 * only a Phase 1 skeleton exists on the dispatcher side — Kanban capacity
 * form + StrictTaskConstraints contract + cargoScorer, which is INACTIVE
 * because public.vehicles has no cargo capacity columns at all. This
 * module is the real prerequisite Cem chose over writing the full
 * FEAT-020 matching-logic spec first: give public.vehicles a supply-side
 * mirror of the demand-side enterprise.dispatch_tasks.capacity_required
 * jsonb (dispatcher's CapacityRequired type: volume_m3/weight_kg/
 * hazmat_classes), so the data can actually start being collected.
 *
 * Pure validation/parsing only — no DB access, so it is unit-testable
 * without a client (same discipline as checkVehicleQuota's DI pattern,
 * but this function needs no DB round-trip at all).
 *
 * @param {Object} body - raw HTTP request body (POST/PUT /api/vehicles)
 * @returns {{ok: true, volumeM3: number|null, weightKg: number|null, hazmatClasses: string[]}
 *          | {ok: false, error: string}}
 */
function parseVehicleCapacityFields(body) {
  const raw = body || {};

  const volumeM3 = parseOptionalNonNegativeNumber(raw.cargo_capacity_volume_m3);
  if (volumeM3 === INVALID) {
    return { ok: false, error: "invalid_volume" };
  }

  const weightKg = parseOptionalNonNegativeNumber(raw.cargo_capacity_weight_kg);
  if (weightKg === INVALID) {
    return { ok: false, error: "invalid_weight" };
  }

  const hazmatClasses = parseHazmatClasses(raw.hazmat_certified_classes);
  if (hazmatClasses === INVALID) {
    return { ok: false, error: "invalid_hazmat_classes" };
  }

  return { ok: true, volumeM3, weightKg, hazmatClasses };
}

const INVALID = Symbol("invalid");

function parseOptionalNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return INVALID;
  }
  return num;
}

function parseHazmatClasses(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return INVALID;
  }
  return value;
}

module.exports = { parseVehicleCapacityFields, parseOptionalNonNegativeNumber, INVALID };
