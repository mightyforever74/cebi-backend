// /opt/fleet/backend/routes/company-plan.js
// TulipFleet - Company Plan & Tier Limits
// S5: Subscription Tier Enforcement

"use strict";

// Tier limit tanimlari
const TIER_LIMITS = {
  starter: {
    maxStops: 3,
    maxVehicles: 5,
    maxDrivers: 10,
    maxAdmins: 2,
    features: {
      maps: true,
      csv_export: true,
      public_tracking: true,
      fuel_management: false,
      advanced_analytics: false,
      api_access: false,
    },
  },
  professional: {
    maxStops: 10,
    maxVehicles: 20,
    maxDrivers: 30,
    maxAdmins: 5,
    features: {
      maps: true,
      csv_export: true,
      public_tracking: true,
      fuel_management: true,
      advanced_analytics: true,
      api_access: false,
    },
  },
  enterprise: {
    maxStops: 25,
    maxVehicles: 999,
    maxDrivers: 999,
    maxAdmins: 20,
    features: {
      maps: true,
      csv_export: true,
      public_tracking: true,
      fuel_management: true,
      advanced_analytics: true,
      api_access: true,
    },
  },
  custom: {
    maxStops: 25,
    maxVehicles: 999,
    maxDrivers: 999,
    maxAdmins: 50,
    features: {
      maps: true,
      csv_export: true,
      public_tracking: true,
      fuel_management: true,
      advanced_analytics: true,
      api_access: true,
    },
  },
};

// Aktif olmayan abonelik statusleri - task olusturulamaz
const BLOCKED_STATUSES = ["suspended", "expired", "cancelled"];

async function companyPlanRoutes(fastify) {
  // GET /api/company/plan - Mevcut sirketin plan bilgisi
  fastify.get(
    "/api/company/plan",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const companyId = request.companyId;

      // SuperAdmin company_id olmadan gelirse enterprise don
      if (request.isSuperAdmin && !companyId) {
        return reply.send({
          tier: "enterprise",
          status: "active",
          limits: TIER_LIMITS.enterprise,
        });
      }

      if (!companyId) {
        return reply.status(400).send({ error: "No company associated" });
      }

      const client = await fastify.pg.connect();
      try {
        const result = await client.query(
          `SELECT subscription_tier, subscription_status, 
                  max_vehicles, max_drivers, max_admins,
                  features, trial_ends_at
           FROM companies WHERE id = $1`,
          [companyId]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: "Company not found" });
        }

        const company = result.rows[0];
        const tier = company.subscription_tier || "starter";
        const baseLimits = TIER_LIMITS[tier] || TIER_LIMITS.starter;

        // DB override varsa onu kullan
        const limits = {
          ...baseLimits,
          maxVehicles: company.max_vehicles || baseLimits.maxVehicles,
          maxDrivers: company.max_drivers || baseLimits.maxDrivers,
          maxAdmins: company.max_admins || baseLimits.maxAdmins,
          features: {
            ...baseLimits.features,
            ...(company.features || {}),
          },
        };

        // Trial kalan gun
        let trialDaysLeft = null;
        if (
          company.subscription_status === "trial" &&
          company.trial_ends_at
        ) {
          const diff = new Date(company.trial_ends_at) - new Date();
          trialDaysLeft = Math.max(
            0,
            Math.ceil(diff / (1000 * 60 * 60 * 24))
          );
        }

        return reply.send({
          tier,
          status: company.subscription_status || "trial",
          limits,
          trialDaysLeft,
        });
      } finally {
        client.release();
      }
    }
  );
}

companyPlanRoutes.TIER_LIMITS = TIER_LIMITS;
companyPlanRoutes.BLOCKED_STATUSES = BLOCKED_STATUSES;
module.exports = companyPlanRoutes;