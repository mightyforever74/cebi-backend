"use strict";

/**
 * Dispatcher drivers endpoint — Faz A (Çekirdek Operasyon) portu.
 *
 * GET /api/dispatcher/drivers
 *
 * Kaynak: tulipfleet-enterprise-backend/routes/drivers.js — BİREBİR port
 * (sorgu, yetki deseni, yanıt şekli aynı). cebi-backend'in Modüler Monolit
 * mimarisine taşınırken TEK değişiklik: requireRole decorator'ı artık
 * server.js içinde (bkz. "Dispatcher Faz A" yorumu) tanımlı — eski
 * plugins/auth.js'teki ayrı plugin yerine.
 *
 * Company-scoped (ADR-0009 §4.4 tenant isolation). SELECT-only.
 * Driver name/email public.users'ta yaşar (drivers.user_id FK, skills
 * kolonu yok — kaynak kodun kendi yorumunda doğrulanmış).
 */
async function dispatcherDriversRoutes(fastify) {
  fastify.get(
    "/api/dispatcher/drivers",
    {
      preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Token missing company_id claim",
        });
      }
      try {
        const result = await fastify.pg.query(
          `SELECT d.id, d.user_id, u.first_name, u.last_name, u.email,
                  d.license_no, d.license_expiry, d.phone, d.status,
                  d.total_km_driven, d.safety_score, d.assigned_vehicle_id,
                  d.company_id
           FROM public.drivers d
           JOIN public.users u ON u.id = d.user_id
           WHERE d.company_id = $1
           ORDER BY u.last_name ASC NULLS LAST`,
          [companyId]
        );
        return {
          drivers: result.rows,
          count: result.rowCount,
        };
      } catch (err) {
        request.log.error({ err }, "Failed to fetch dispatcher drivers");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch drivers",
        });
      }
    }
  );
}

module.exports = dispatcherDriversRoutes;
