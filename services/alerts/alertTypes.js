'use strict';

/**
 * Live alert_type dictionary + Driving Quality report map.
 *
 * Canonical live set matches argon `scripts/i18n-dynamic-roots.json`
 * key `adminAlerts.types` (there is no `alerts.alert_type` key in that file).
 * Matching is always lower+trim. Unknown map keys are ignored and warned once.
 *
 * IMPACT: no live counterpart exists (harsh_brake/speeding/SOS only).
 * The report field `impact_count` stays 0 for mobile back-compat.
 */

// Live values as stored after lower(trim()). JSON lists `sos`; DB may store `SOS`.
const LIVE_ALERT_TYPES = Object.freeze([
  'task_accepted',
  'task_started',
  'task_completed',
  'task_withdrawn',
  'task_offered',
  'task_rejected',
  'geofence_entry',
  'geofence_exit',
  'sos',
  'speeding',
  'harsh_brake',
]);

const LIVE_ALERT_TYPE_SET = new Set(LIVE_ALERT_TYPES);

/** Live (normalized) → report key. IMPACT is intentionally absent. */
const ALERT_TYPE_MAP = Object.freeze({
  speeding: 'OVERSPEED',
  harsh_brake: 'HARD_BRAKE',
  sos: 'SOS',
});

const REPORT_COUNT_FIELDS = Object.freeze({
  HARD_BRAKE: 'hard_brake_count',
  OVERSPEED: 'overspeed_count',
  IMPACT: 'impact_count',
  HARD_TURN: 'hard_turn_count',
  HARD_ACCEL: 'hard_accel_count',
});

const warnedUnmapped = new Set();

function normalizeAlertType(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

function resolveReportKey(rawType) {
  const live = normalizeAlertType(rawType);
  if (!live) return null;
  return ALERT_TYPE_MAP[live] || null;
}

function sqlLiteralList(values) {
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
}

/**
 * SQL boolean expr: lower(trim(column)) IN (live types for reportKey).
 * IMPACT and unmapped keys (HARD_TURN, HARD_ACCEL) → FALSE (count stays 0).
 */
function sqlAlertTypeFilter(column, reportKey) {
  if (reportKey === 'IMPACT') {
    return 'FALSE';
  }
  const lives = Object.entries(ALERT_TYPE_MAP)
    .filter(([, key]) => key === reportKey)
    .map(([live]) => live);
  if (lives.length === 0) {
    return 'FALSE';
  }
  return `lower(trim(${column})) IN (${sqlLiteralList(lives)})`;
}

function emptyDrivingQualityCounts() {
  return {
    hard_brake_count: 0,
    hard_turn_count: 0,
    hard_accel_count: 0,
    overspeed_count: 0,
    impact_count: 0,
  };
}

/**
 * Count mapped driving-quality keys from an alert array.
 * IMPACT is always 0. Unmapped types (after lower+trim) are skipped and
 * logged once per process via `logWarn`.
 */
function countDrivingQuality(alerts, logWarn) {
  const counts = emptyDrivingQualityCounts();
  const list = Array.isArray(alerts) ? alerts : [];
  for (const alert of list) {
    const raw = alert == null ? null : alert.alert_type;
    const live = normalizeAlertType(raw);
    if (!live) continue;
    const reportKey = ALERT_TYPE_MAP[live];
    if (!reportKey) {
      warnUnmappedOnce(live, raw, logWarn);
      continue;
    }
    if (reportKey === 'IMPACT') continue;
    const field = REPORT_COUNT_FIELDS[reportKey];
    if (field && Object.prototype.hasOwnProperty.call(counts, field)) {
      counts[field] += 1;
    }
  }
  counts.impact_count = 0;
  return counts;
}

function warnUnmappedOnce(normalized, raw, logWarn) {
  if (warnedUnmapped.has(normalized)) return;
  warnedUnmapped.add(normalized);
  const payload = { alert_type: raw, normalized };
  if (typeof logWarn === 'function') {
    logWarn(payload, 'unmapped alert_type ignored in report counters');
  } else if (logWarn && typeof logWarn.warn === 'function') {
    logWarn.warn(payload, 'unmapped alert_type ignored in report counters');
  }
}

function warnUnmappedAlertTypes(rawTypes, logWarn) {
  for (const raw of rawTypes || []) {
    const live = normalizeAlertType(raw);
    if (!live) continue;
    if (!ALERT_TYPE_MAP[live]) warnUnmappedOnce(live, raw, logWarn);
  }
}

/** Test helper — do not use in production request paths. */
function _resetUnmappedWarnings() {
  warnedUnmapped.clear();
}

module.exports = {
  LIVE_ALERT_TYPES,
  LIVE_ALERT_TYPE_SET,
  ALERT_TYPE_MAP,
  REPORT_COUNT_FIELDS,
  normalizeAlertType,
  resolveReportKey,
  sqlAlertTypeFilter,
  countDrivingQuality,
  emptyDrivingQualityCounts,
  warnUnmappedAlertTypes,
  _resetUnmappedWarnings,
};
