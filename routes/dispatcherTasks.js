"use strict";

/**
 * Dispatcher tasks — liste endpoint'i. Faz A (Çekirdek Operasyon) portu.
 *
 * GET /api/dispatcher/tasks?filter=pending_review|today|planned
 *
 * Kaynak: tulipfleet-enterprise-backend/routes/tasks.js'in SADECE bu tekil
 * SELECT-only endpoint'i — BİREBİR port.
 *
 * KASITLI OLARAK BU PASTA DAHİL EDİLMEDİ (kapsam kararı, bkz. SESSION_NOTE.md
 * "devam 13"): aynı kaynak dosyadaki
 *   POST /dispatcher/tasks/optimize
 *   GET  /dispatcher/tasks/optimize/poll/:id
 *   POST /dispatcher/tasks/optimize/approve
 * — VRP (Vehicle Routing Problem) optimizasyon boru hattı. "Faz A: Çekirdek
 * Operasyon" kullanıcıya "tasks, drivers, vehicles, locations/latest —
 * dispatcher panelinin gün içi asıl kullanımı" olarak tarif edilmişti; bu
 * dört endpoint o tarife birebir karşılık gelir. Optimize/approve zinciri
 * ise:
 *   (a) cebi-backend'de henüz PORT EDİLMEMİŞ bir VRP sağlayıcı soyutlaması
 *       gerektirir (kaynaktaki lib/routing/factory.js — cebi-backend'de
 *       YOK; cebi-backend'in kendi services/routing/factory.js'i FARKLI bir
 *       şey yapar: tekil rota/trafik, VRP çözücü değil),
 *   (b) routes/internalBridge.js'e giden eski HTTP "ince köprü" push'unu
 *       (axios + INTERNAL_CORE_API_URL + X-Internal-Bridge-Token) tek
 *       süreçli mimariye uyarlamayı gerektirir — kendi başına ayrı bir
 *       kod inceleme + karar + test döngüsü ister (ADR-CE-02/ADR-CE-04
 *       presedentiyle aynı disiplin: tek seferde her şeyi portlamak yerine
 *       her parça kendi döngüsünde tamamlanır/doğrulanır).
 * Şema tarafı hazır (enterprise.routing_jobs, enterprise.dispatch_tasks,
 * company_task_counters zaten mevcut/kullanımda — internalBridge.js canlı)
 * — eksik olan sadece uygulama kodu. Bu, ayrı bir takip ADR/işi olarak
 * planlanmalı (öneri: "Faz A-2: VRP Optimizasyon Portu").
 *
 * Company-scoped (ADR-0009 §4.4). SELECT-only.
 */
async function dispatcherTasksRoutes(fastify) {
  fastify.get(
    "/api/dispatcher/tasks",
    { preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")] },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Token missing company_id claim",
        });
      }

      const filter = request.query.filter;
      let whereExtra = "";
      if (filter === "pending_review") {
        whereExtra = `AND t.status = 'pending_review'`;
      } else if (filter === "today") {
        whereExtra = `AND t.scheduled_start::date = CURRENT_DATE`;
      } else if (filter === "planned") {
        whereExtra = `AND t.scheduled_start > now()`;
      }

      try {
        const result = await fastify.pg.query(
          `SELECT t.id, t.task_no, t.title, t.status, t.priority,
                  t.driver_id, t.vehicle_id,
                  t.start_location, t.end_location,
                  t.scheduled_start, t.scheduled_end,
                  t.total_distance_km, t.created_at, t.company_id
           FROM public.tasks t
           WHERE t.company_id = $1
           ${whereExtra}
           ORDER BY t.scheduled_start DESC NULLS LAST, t.created_at DESC`,
          [companyId]
        );
        return {
          tasks: result.rows,
          count: result.rowCount,
          filter: filter || "all",
        };
      } catch (err) {
        request.log.error({ err }, "Failed to fetch dispatcher tasks");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch tasks",
        });
      }
    }
  );
}

module.exports = dispatcherTasksRoutes;
