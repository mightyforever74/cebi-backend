"use strict";

/**
 * routes/vehicleQuotaHelpers.js
 *
 * Vehicle creation quota enforcement. TulipFleet Connect Tier A ticari
 * ilkesi (Cem, 2026-10-11): "Plaka/Kota Korumasi - company_id altindaki
 * yetkilendirmede tanimli lisansli arac sayisi denetlenir." Su an
 * POST /api/vehicles (server.js) hicbir kota kontrolu yapmadan INSERT
 * ediyor - bu modul o kontrolun is mantigini saglar.
 *
 * Test edilebilirlik icin veritabani client'i disaridan enjekte edilir
 * (routes/alertsHelpers.js / routes/vehicleTrackHelpers.js presedenti).
 *
 * Mevcut S5 (routes/company-plan.js TIER_LIMITS) presedentini izler:
 * companies.max_vehicles bir DB override'dir; falsy (null/0/undefined)
 * ise subscription_tier'in taban limitine dusulur. "Aktif arac" sayimi
 * mevcut konvansiyonla ayni: status != 'retired' (bkz.
 * routes/superadmin.companies.js, routes/superadmin.subscriptions.js).
 */

const TIER_LIMITS = {
  starter: 5,
  professional: 20,
  enterprise: 999,
  custom: 999,
};
const DEFAULT_TIER_LIMIT = TIER_LIMITS.starter;

/**
 * @param {Object} client - pg client (disaridan enjekte edilir)
 * @param {string} companyId
 * @returns {Promise<{allowed: boolean, reason: string|null, activeCount: number|null, maxVehicles: number|null}>}
 */
async function checkVehicleQuota(client, companyId) {
  if (!companyId) {
    return {
      allowed: false,
      reason: "company_required",
      activeCount: null,
      maxVehicles: null,
    };
  }

  const companyResult = await client.query(
    "SELECT subscription_tier, max_vehicles FROM companies WHERE id = $1",
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company) {
    return {
      allowed: false,
      reason: "company_not_found",
      activeCount: null,
      maxVehicles: null,
    };
  }

  const tier = company.subscription_tier || "starter";
  const tierLimit = TIER_LIMITS[tier] || DEFAULT_TIER_LIMIT;
  const maxVehicles = company.max_vehicles || tierLimit;

  const countResult = await client.query(
    "SELECT COUNT(*)::int AS active_count FROM vehicles WHERE company_id = $1 AND status != 'retired'",
    [companyId]
  );
  const activeCount = countResult.rows[0].active_count;

  const allowed = activeCount < maxVehicles;
  return {
    allowed,
    reason: allowed ? null : "quota_exceeded",
    activeCount,
    maxVehicles,
  };
}

module.exports = { checkVehicleQuota, TIER_LIMITS };
