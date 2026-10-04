'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ALERT_TYPE_MAP,
  LIVE_ALERT_TYPES,
  normalizeAlertType,
  resolveReportKey,
  sqlAlertTypeFilter,
  countDrivingQuality,
  _resetUnmappedWarnings,
} = require('../services/alerts/alertTypes');

test('LIVE_ALERT_TYPES includes speeding, harsh_brake, sos, geofence and task_*', () => {
  assert.ok(LIVE_ALERT_TYPES.includes('speeding'));
  assert.ok(LIVE_ALERT_TYPES.includes('harsh_brake'));
  assert.ok(LIVE_ALERT_TYPES.includes('sos'));
  assert.ok(LIVE_ALERT_TYPES.includes('geofence_entry'));
  assert.ok(LIVE_ALERT_TYPES.includes('task_accepted'));
});

test('ALERT_TYPE_MAP live → report keys', () => {
  assert.equal(ALERT_TYPE_MAP.speeding, 'OVERSPEED');
  assert.equal(ALERT_TYPE_MAP.harsh_brake, 'HARD_BRAKE');
  assert.equal(ALERT_TYPE_MAP.sos, 'SOS');
  assert.equal(ALERT_TYPE_MAP.impact, undefined);
});

test('normalizeAlertType lower+trim; NULL/empty → empty string', () => {
  assert.equal(normalizeAlertType(' SPEEDING '), 'speeding');
  assert.equal(normalizeAlertType('SOS'), 'sos');
  assert.equal(normalizeAlertType(null), '');
  assert.equal(normalizeAlertType(undefined), '');
  assert.equal(normalizeAlertType('  '), '');
});

test('resolveReportKey maps mixed case and SOS', () => {
  assert.equal(resolveReportKey('harsh_brake'), 'HARD_BRAKE');
  assert.equal(resolveReportKey(' HARSH_BRAKE '), 'HARD_BRAKE');
  assert.equal(resolveReportKey('Speeding'), 'OVERSPEED');
  assert.equal(resolveReportKey('SOS'), 'SOS');
  assert.equal(resolveReportKey('sos'), 'SOS');
  assert.equal(resolveReportKey(null), null);
  assert.equal(resolveReportKey('geofence_entry'), null);
});

test('sqlAlertTypeFilter uses live types; IMPACT and unmapped are FALSE', () => {
  assert.equal(
    sqlAlertTypeFilter('a.alert_type', 'HARD_BRAKE'),
    "lower(trim(a.alert_type)) IN ('harsh_brake')"
  );
  assert.equal(
    sqlAlertTypeFilter('a.alert_type', 'OVERSPEED'),
    "lower(trim(a.alert_type)) IN ('speeding')"
  );
  assert.equal(sqlAlertTypeFilter('a.alert_type', 'IMPACT'), 'FALSE');
  assert.equal(sqlAlertTypeFilter('a.alert_type', 'HARD_TURN'), 'FALSE');
  assert.equal(sqlAlertTypeFilter('a.alert_type', 'HARD_ACCEL'), 'FALSE');
});

test('countDrivingQuality: lower/upper/padded/NULL/unknown → expected counters', () => {
  _resetUnmappedWarnings();
  const warnings = [];
  const counts = countDrivingQuality(
    [
      { alert_type: 'harsh_brake' },
      { alert_type: 'HARSH_BRAKE' },
      { alert_type: '  speeding' },
      { alert_type: 'SPEEDING' },
      { alert_type: 'SOS' },
      { alert_type: null },
      { alert_type: '  ' },
      { alert_type: 'geofence_entry' },
      { alert_type: 'IMPACT' },
      { alert_type: 'no_such_type' },
      { alert_type: 'no_such_type' },
    ],
    (payload, msg) => warnings.push({ payload, msg })
  );

  assert.deepEqual(counts, {
    hard_brake_count: 2,
    hard_turn_count: 0,
    hard_accel_count: 0,
    overspeed_count: 2,
    impact_count: 0,
  });

  const normalized = warnings.map((w) => w.payload.normalized).sort();
  assert.deepEqual(normalized, ['geofence_entry', 'impact', 'no_such_type']);
});
