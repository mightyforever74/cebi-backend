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


  // ── Sprint D1: Sürücü Performans Raporu ────────────────────────────────────
  fastify.get("/api/reports/drivers/performance", {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const company_id = request.user.company_id;
    const days = parseInt(request.query.days) || 30;
    try {
      const from = new Date(Date.now() - days * 86400000).toISOString();

      const { rows } = await fastify.pg.query(`
        SELECT
          d.id as driver_id,
          u.first_name,
          u.last_name,
          u.email,

          -- Görev metrikleri
          COUNT(DISTINCT t.id)::int as total_tasks,
          COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed')::int as completed_tasks,
          COUNT(DISTINCT t.id) FILTER (
            WHERE t.status = 'completed'
            AND t.planned_end IS NOT NULL
            AND t.actual_end > t.planned_end + INTERVAL '15 minutes'
          )::int as delayed_tasks,
          ROUND(AVG(
            EXTRACT(EPOCH FROM (t.actual_end - t.actual_start)) / 60
          ) FILTER (
            WHERE t.status = 'completed'
            AND t.actual_start IS NOT NULL
            AND t.actual_end IS NOT NULL
          ))::int as avg_duration_min,

          -- Mesafe (GPS veya fallback)
          ROUND(COALESCE(SUM(t.actual_distance_km) FILTER (
            WHERE t.status = 'completed'
          ), 0), 1)::numeric as total_km,

          -- Alert metrikleri (araç üzerinden)
          COUNT(DISTINCT a.id) FILTER (WHERE a.alert_type = 'HARD_BRAKE')::int as hard_brake_count,
          COUNT(DISTINCT a.id) FILTER (WHERE a.alert_type = 'HARD_TURN' OR a.alert_type = 'SHARP_TURN')::int as hard_turn_count,
          COUNT(DISTINCT a.id) FILTER (WHERE a.alert_type = 'HARD_ACCEL')::int as hard_accel_count,
          COUNT(DISTINCT a.id) FILTER (WHERE a.alert_type = 'OVERSPEED')::int as overspeed_count,
          COUNT(DISTINCT a.id) FILTER (WHERE a.alert_type = 'IMPACT')::int as impact_count,
          COUNT(DISTINCT a.id)::int as total_alerts

        FROM drivers d
        JOIN users u ON u.id = d.user_id
        LEFT JOIN tasks t ON t.driver_id = d.id
          AND t.created_at >= $2
        LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
        LEFT JOIN alerts a ON a.vehicle_id = t.vehicle_id
          AND a.created_at >= COALESCE(t.actual_start, $2)
          AND a.created_at <= COALESCE(t.actual_end, NOW())
        WHERE d.company_id = $1
        GROUP BY d.id, u.first_name, u.last_name, u.email
        ORDER BY completed_tasks DESC, total_alerts ASC
      `, [company_id, from]);

      // Sürüş skoru hesapla (100km başına normalize)
      // Formül: Baz 100 - HARD_BRAKE×3 - HARD_TURN×2 - HARD_ACCEL×2 (100km normalize)
      // Sınırlılık: olay şiddeti (g-force) hesaba katılmıyor, trafik/hava bağlamı yok
      const drivers = rows.map(d => {
        const km = parseFloat(d.total_km) || 0;
        let driving_score = null;
        let score_note = null;

        if (km >= 10) {
          // 100km başına normalize
          const per100km = 100 / km;
          const penalty =
            (d.hard_brake_count * 3 +
             d.hard_turn_count  * 2 +
             d.hard_accel_count * 2) * per100km;
          driving_score = Math.max(0, Math.round(100 - penalty));
        } else {
          score_note = "insufficient_distance"; // < 10km — skor hesaplanamaz
        }

        return { ...d, driving_score, score_note };
      });

      return {
        data: {
          period: { days, from },
          drivers,
          limitations: [
            "Sürüş skoru taslak formüldür — olay şiddeti (g-force) hesaba katılmıyor",
            "Trafik ve hava koşulları bağlamı yok",
            "GPS mesafesi < 10km olan sürücüler için skor hesaplanmaz",
            "Alert verileri araç bazlıdır — sürücü değişimlerinde geçmiş alertler birden fazla sürücüye atanabilir"
          ]
        }
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
  // ── Sprint D1 sonu ──────────────────────────────────────────────────────────

};