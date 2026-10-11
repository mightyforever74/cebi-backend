// routes/reports.js — TulipFleet Operations Report
const { warnUnmappedAlertTypes } = require("../services/alerts/alertTypes");
const {
  buildDriverPerformanceReport,
} = require("./reportsDrivingQualityHelpers");

module.exports = async function (fastify) {
  fastify.get(
    "/api/reports/operations",
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const company_id = request.user.company_id;
      const days = parseInt(request.query.days) || 30;
      try {
        const from = new Date(Date.now() - days * 86400000).toISOString();
        // Company name for report header
        const companyResult = await fastify.pg.query(
          `SELECT name FROM companies WHERE id = $1`,
          [company_id]
        );
        const company_name = companyResult.rows[0]?.name || null;
        const taskResult = await fastify.pg.query(
          `
        SELECT
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
          COUNT(*) FILTER (WHERE status IN ('cancelled', 'rejected'))::int as cancelled,
          COUNT(*) FILTER (WHERE status IN ('pending_review', 'accepted', 'in_progress'))::int as pending,
          ROUND(AVG(EXTRACT(EPOCH FROM (actual_end - actual_start))/60) FILTER (
            WHERE status = 'completed' AND actual_start IS NOT NULL AND actual_end IS NOT NULL
          ))::int as avg_duration_min,
          ROUND(COALESCE(SUM(actual_distance_km) FILTER (WHERE status = 'completed'), 0))::numeric as total_km,
          COUNT(*) FILTER (
            WHERE status = 'completed' AND planned_end IS NOT NULL AND actual_end > planned_end + INTERVAL '15 minutes'
          )::int as delayed,
          ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE status = 'completed'
              AND actual_start IS NOT NULL
              AND planned_start IS NOT NULL
              AND actual_start <= planned_start + INTERVAL '30 minutes'
            ) / NULLIF(COUNT(*) FILTER (
              WHERE status = 'completed'
              AND planned_start IS NOT NULL
            ), 0)
          )::int as on_time_start_rate,
          COUNT(*) FILTER (WHERE status = 'completed' AND distance_source = 'gps')::int as dist_gps,
          COUNT(*) FILTER (WHERE status = 'completed' AND distance_source = 'route')::int as dist_route,
          COUNT(*) FILTER (WHERE status = 'completed' AND distance_source = 'manual')::int as dist_manual,
          COUNT(*) FILTER (WHERE status = 'completed' AND distance_source IN ('no_dev', 'no_start'))::int as dist_unknown
        FROM tasks
        WHERE company_id = $1 AND created_at >= $2
      `,
          [company_id, from]
        );

        const vehicleResult = await fastify.pg.query(
          `
        SELECT
          v.plate_no, v.brand, v.model,
          COUNT(t.id)::int as task_count,
          COUNT(t.id) FILTER (WHERE t.status = 'completed')::int as completed,
          ROUND(COALESCE(SUM(t.actual_distance_km) FILTER (WHERE t.status = 'completed'), 0))::numeric as total_km
        FROM vehicles v
        LEFT JOIN tasks t ON t.vehicle_id = v.id AND t.created_at >= $2
        WHERE v.company_id = $1
        GROUP BY v.id, v.plate_no, v.brand, v.model
        ORDER BY task_count DESC
      `,
          [company_id, from]
        );

        const driverResult = await fastify.pg.query(
          `
        SELECT
          u.first_name, u.last_name,
          COUNT(DISTINCT t.id)::int as task_count,
          COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed')::int as completed,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.actual_end - t.actual_start))/60) FILTER (
            WHERE t.status = 'completed' AND t.actual_start IS NOT NULL AND t.actual_end IS NOT NULL
          ))::int as avg_duration_min,
          COUNT(DISTINCT a.id)::int as alert_count
        FROM drivers d
        JOIN users u ON u.id = d.user_id
        LEFT JOIN tasks t ON t.driver_id = d.id AND t.created_at >= $2
        LEFT JOIN alerts a ON a.vehicle_id = d.assigned_vehicle_id AND a.created_at >= $2
        WHERE d.company_id = $1
        GROUP BY d.id, u.first_name, u.last_name
        ORDER BY task_count DESC
      `,
          [company_id, from]
        );

        return {
          data: {
            company_name,
            period: { days, from },
            summary: taskResult.rows[0],
            vehicles: vehicleResult.rows,
            drivers: driverResult.rows,
          },
        };
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  // ── Sprint D1: Sürücü Performans Raporu ────────────────────────────────────
  // 11 Ekim 2026 — "Driving Quality trend" (§5, Mayıs'tan açık): sorgu +
  // skor mantığı routes/reportsDrivingQualityHelpers.js'e taşındı (test
  // edilebilirlik), ?compare_with_previous=true ile önceki eşit-uzunluktaki
  // döneme göre delta/trend eklendi. Eski davranış (compare_with_previous
  // verilmediğinde) BİREBİR korunur.
  fastify.get(
    "/api/reports/drivers/performance",
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const company_id = request.user.company_id;
      const days = parseInt(request.query.days) || 30;
      const compareWithPrevious =
        request.query.compare_with_previous === "true";
      try {
        const data = await buildDriverPerformanceReport(
          fastify.pg,
          company_id,
          {
            days,
            compareWithPrevious,
          }
        );

        const from = data.period.from;
        const distinctTypes = await fastify.pg.query(
          `SELECT DISTINCT alert_type FROM alerts WHERE company_id = $1 AND created_at >= $2`,
          [company_id, from]
        );
        warnUnmappedAlertTypes(
          distinctTypes.rows.map((r) => r.alert_type),
          request.log
        );

        return { data };
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );
  // ── Sprint D1 sonu ──────────────────────────────────────────────────────────
};
