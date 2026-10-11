// routes/companyBranding.js
// Müşteri Takip Portalı (§10, MVP-2 kalan) — şirket markalaması (logo + renk).
// İş mantığı routes/companyBrandingHelpers.js'de kilitli; bu dosya sadece
// auth/route kablolaması (routes/company-plan.js presedenti).

"use strict";

const {
  getCompanyBranding,
  updateCompanyBranding,
  BrandingValidationError,
} = require("./companyBrandingHelpers");

async function companyBrandingRoutes(fastify) {
  fastify.get(
    "/api/company/branding",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const companyId = request.companyId;
      if (!companyId) {
        return reply.status(400).send({ error: "No company associated" });
      }

      const client = await fastify.pg.connect();
      try {
        const branding = await getCompanyBranding(client, companyId);
        return reply.send(branding);
      } finally {
        client.release();
      }
    }
  );

  fastify.put(
    "/api/company/branding",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.role !== "company_admin" && !request.isSuperAdmin) {
        return reply.code(403).send({ error: "Admin access required" });
      }

      const companyId = request.companyId;
      if (!companyId) {
        return reply.status(400).send({ error: "No company associated" });
      }

      const { logoUrl, brandColor } = request.body || {};
      const client = await fastify.pg.connect();
      try {
        const branding = await updateCompanyBranding(client, companyId, {
          logoUrl,
          brandColor,
        });
        return reply.send(branding);
      } catch (err) {
        if (err instanceof BrandingValidationError) {
          return reply.status(400).send({ error: err.message });
        }
        request.log.error(err);
        return reply.status(500).send({ error: "Internal server error" });
      } finally {
        client.release();
      }
    }
  );
}

module.exports = companyBrandingRoutes;
