"use strict";

/**
 * Alarm "ack" (onaylama) iş mantığı — resolve endpoint'indeki
 * is_resolved/resolved_at/resolved_by desenine paralel, ama bağımsız bir
 * durum (acknowledged_at/acknowledged_by). İdempotent: zaten ack edilmiş bir
 * alert'in UPDATE'i hiç çalışmaz, mevcut acknowledged_at/by ezilmez.
 *
 * client: pg Pool/Client (zaten connect edilmiş, caller release eder).
 */
async function acknowledgeAlert(client, { alertId, companyId, userId }) {
  const { rows: existing } = await client.query(
    "SELECT id, acknowledged_at FROM alerts WHERE id = $1 AND company_id = $2",
    [alertId, companyId]
  );

  if (existing.length === 0) {
    return { ok: false, reason: "not_found" };
  }

  if (existing[0].acknowledged_at) {
    return { ok: false, reason: "already_acknowledged" };
  }

  const { rows } = await client.query(
    `
      UPDATE alerts
      SET acknowledged_at = NOW(),
          acknowledged_by = $1
      WHERE id = $2 AND company_id = $3 AND acknowledged_at IS NULL
      RETURNING *
    `,
    [userId, alertId, companyId]
  );

  return { ok: true, alert: rows[0] };
}

module.exports = { acknowledgeAlert };
