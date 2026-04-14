// routes/reports.js — TulipFleet Operations Report
module.exports = async function(fastify) {
  fastify.get("/api/reports/operations", {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const company_id = request.user.company_id;
    const days = parseInt(request.query.days) || 30;
    try {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      const taskResult = await fastify.pg.query(`
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
          )::int as delayed
        FROM tasks
        WHERE company_id = $1 AND created_at >= $2
      `, [company_id, from]);

      const vehicleResult = await fastify.pg.query(`
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
      `, [company_id, from]);

      const driverResult = await fastify.pg.query(`
        SELECT
          u.first_name, u.last_name,
          COUNT(t.id)::int as task_count,
          COUNT(t.id) FILTER (WHERE t.status = 'completed')::int as completed,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.actual_end - t.actual_start))/60) FILTER (
            WHERE t.status = 'completed' AND t.actual_start IS NOT NULL AND t.actual_end IS NOT NULL
          ))::int as avg_duration_min
        FROM drivers d
        JOIN users u ON u.id = d.user_id
        LEFT JOIN tasks t ON t.driver_id = d.id AND t.created_at >= $2
        WHERE d.company_id = $1
        GROUP BY d.id, u.first_name, u.last_name
        ORDER BY task_count DESC
      `, [company_id, from]);

      return {
        data: {
          period: { days, from },
          summary: taskResult.rows[0],
          vehicles: vehicleResult.rows,
          drivers: driverResult.rows,
        }
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
};
