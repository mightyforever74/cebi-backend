// /opt/fleet/backend/routes/geofences.js
// ============================================================
// TulipFleet Geofence Routes  v2.1
// Değişiklikler (Mart 2026):
//   - scope_type + vehicle_id desteği (DB migration ile uyumlu)
//   - GET  /api/geofences:    LEFT JOIN vehicles → vehicle_plate
//   - GET  /api/geofences/:id: LEFT JOIN vehicles → vehicle_plate
//   - POST /api/geofences:    scope_type/vehicle_id + validation + INSERT
//   - PUT  /api/geofences/:id: scope_type/vehicle_id + validation + UPDATE
//   - v1: scope_type sabit 'vehicle' (company scope frontend'de kapalı)
// ============================================================

'use strict';

const {
  publishConfigToAllDevices,
  buildConfigPayload,
} = require('../services/geofenceService');
const { validateGeofencePayload } = require('./geofenceValidation');

// ── Scope validation helper ────────────────────────────────
async function validateVehicleScope(client, vehicle_id, company_id, reply) {
  if (!vehicle_id) {
    reply.status(400).send({ error: 'vehicle_id zorunlu' });
    return false;
  }
  const { rows } = await client.query(
    `SELECT id FROM vehicles
     WHERE id = $1 AND company_id = $2 AND status != 'retired'`,
    [vehicle_id, company_id]
  );
  if (rows.length === 0) {
    reply.status(403).send({ error: 'Araç bulunamadı veya şirkete ait değil' });
    return false;
  }
  return true;
}

module.exports = async function (fastify) {

  // ── GET /api/geofences ─────────────────────────────────────
  fastify.get('/api/geofences', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const companyId = req.user.company_id;
      const { rows } = await client.query(
        `SELECT g.*,
                v.plate_no AS vehicle_plate,
                (SELECT COUNT(*) FROM geofence_events ge WHERE ge.geofence_id = g.id) AS total_events,
                (SELECT COUNT(*) FROM geofence_events ge WHERE ge.geofence_id = g.id AND ge.created_at > NOW() - INTERVAL '7 days') AS events_last_7d,
                (SELECT COALESCE(SUM(ge.duration_seconds), 0) / 60
                 FROM geofence_events ge
                 WHERE ge.geofence_id = g.id AND ge.event_type = 'exit' AND ge.duration_seconds IS NOT NULL) AS total_duration_minutes
         FROM geofences g
         LEFT JOIN vehicles v ON g.vehicle_id = v.id
         WHERE g.company_id = $1
         ORDER BY g.created_at DESC`,
        [companyId]
      );
      return reply.send({ geofences: rows });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/geofences/csrd-report ────────────────────────
  fastify.get('/api/geofences/csrd-report', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const { from, to } = req.query;
    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `SELECT
           g.name           AS zone_name,
           g.fence_category,
           v.plate_no, v.brand, v.model,
           COUNT(ge.id)     FILTER (WHERE ge.event_type = 'exit') AS visit_count,
           COALESCE(SUM(ge.duration_seconds) FILTER (WHERE ge.event_type = 'exit'), 0) AS total_seconds,
           ROUND(COALESCE(SUM(ge.duration_seconds) FILTER (WHERE ge.event_type = 'exit'), 0) / 60.0, 1) AS total_minutes,
           ROUND(COALESCE(AVG(ge.duration_seconds) FILTER (WHERE ge.event_type = 'exit'), 0) / 60.0, 1) AS avg_minutes_per_visit
         FROM geofence_events ge
         JOIN geofences g ON g.id = ge.geofence_id
         JOIN vehicles  v ON v.id = ge.vehicle_id
         WHERE ge.company_id = $1
           AND g.fence_category = 'emission_zone'
           AND ($2::timestamptz IS NULL OR ge.created_at >= $2)
           AND ($3::timestamptz IS NULL OR ge.created_at <= $3)
         GROUP BY g.name, g.fence_category, v.plate_no, v.brand, v.model
         ORDER BY total_seconds DESC`,
        [req.user.company_id, from || null, to || null]
      );
      return reply.send({ report: rows, generated_at: new Date().toISOString() });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences/csrd-report failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/geofences/config/:chipId ─────────────────────
  fastify.get('/api/geofences/config/:chipId', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { chipId } = req.params;
      const devRes = await client.query(
        `SELECT d.id, v.company_id
         FROM devices d
         LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE d.esp_chip_id = $1
         LIMIT 1`,
        [chipId]
      );
      if (devRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Cihaz bulunamadı' });
      }
      const { company_id } = devRes.rows[0];
      if (req.user.role !== 'super_admin' && req.user.company_id !== company_id) {
        return reply.status(403).send({ error: 'Yetkisiz' });
      }
      const payload = await buildConfigPayload(client, company_id);
      return reply.send(payload);
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences/config failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

// ── GET /api/geofences/events (TUM events) ────────────────
  fastify.get('/api/geofences/events', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const companyId = req.user.company_id;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = parseInt(req.query.offset) || 0;
      const { rows } = await client.query(
        `SELECT ge.*, g.name AS geofence_name, g.fence_type,
                v.plate_no, v.brand, v.model
         FROM geofence_events ge
         LEFT JOIN geofences g ON g.id = ge.geofence_id
         LEFT JOIN vehicles v ON v.id = ge.vehicle_id
         WHERE ge.company_id = $1
         ORDER BY ge.created_at DESC
         LIMIT $2 OFFSET $3`,
        [companyId, limit, offset]
      );
      return reply.send({ events: rows });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences/events failed');
      return reply.status(500).send({ error: 'Sunucu hatasi' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/geofences/:id ─────────────────────────────────
  fastify.get('/api/geofences/:id', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id }    = req.params;
      const companyId = req.user.company_id;
      const { rows } = await client.query(
        `SELECT g.*,
                v.plate_no AS vehicle_plate,
                (SELECT COUNT(*) FROM geofence_events ge WHERE ge.geofence_id = g.id) AS total_events
         FROM geofences g
         LEFT JOIN vehicles v ON g.vehicle_id = v.id
         WHERE g.id = $1 AND g.company_id = $2`,
        [id, companyId]
      );
      if (rows.length === 0) return reply.status(404).send({ error: 'Zone bulunamadı' });
      return reply.send({ geofence: rows[0] });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences/:id failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/geofences/:id/events ─────────────────────────
  fastify.get('/api/geofences/:id/events', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id }    = req.params;
      const companyId = req.user.company_id;
      const limit     = Math.min(parseInt(req.query.limit) || 50, 200);
      const { rows } = await client.query(
        `SELECT ge.*, v.plate_no, v.brand, v.model
         FROM geofence_events ge
         LEFT JOIN vehicles v ON v.id = ge.vehicle_id
         WHERE ge.geofence_id = $1 AND ge.company_id = $2
         ORDER BY ge.created_at DESC
         LIMIT $3`,
        [id, companyId, limit]
      );
      return reply.send({ events: rows });
    } catch (err) {
      fastify.log.error({ err }, 'GET /api/geofences/:id/events failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/geofences/:id/violations ─────────────────────
  fastify.get('/api/geofences/:id/violations', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id }    = req.params;
      const companyId = req.user.company_id;
      const limit     = Math.min(parseInt(req.query.limit)  || 50, 200);
      const offset    = parseInt(req.query.offset) || 0;

      const own = await client.query(
        'SELECT id FROM geofences WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (own.rows.length === 0) return reply.status(404).send({ error: 'Zone bulunamadı' });

      const { rows } = await client.query(
        `SELECT gv.*, v.plate_no
         FROM geofence_violations gv
         LEFT JOIN vehicles v ON v.id = gv.vehicle_id
         WHERE gv.geofence_id = $1
         ORDER BY gv.occurred_at DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );
      return reply.send({ violations: rows });
    } catch (err) {
      fastify.log.error({ err }, 'GET violations failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── POST /api/geofences ────────────────────────────────────
  fastify.post('/api/geofences', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const companyId = req.user.company_id;
      const {
        name,
        fence_type     = 'circle',
        coordinates,
        radius,
        is_active      = true,
        alert_on_entry = false,
        alert_on_exit  = false,
        category       = 'general',
        csrd_tracked   = false,
        start_hour     = null,
        end_hour       = null,
        description    = null,
        vehicle_id     = null,
      } = req.body;

      if (!name || !coordinates) {
        return reply.status(400).send({ error: 'name ve coordinates zorunlu' });
      }

      // §9.5: coordinates yapisi (circle {lat,lng} / polygon >=3 nokta),
      // circle radius sinirlari (10m-5km) ve self-intersecting polygon kontrolu.
      let coordinatesObj;
      try {
        coordinatesObj = typeof coordinates === 'string' ? JSON.parse(coordinates) : coordinates;
      } catch (e) {
        return reply.status(400).send({ error: 'coordinates geçerli bir JSON olmalı' });
      }
      const geoCheck = validateGeofencePayload({ fence_type, coordinates: coordinatesObj, radius });
      if (!geoCheck.ok) {
        return reply.status(400).send({ error: geoCheck.error });
      }

      if (start_hour !== null && (start_hour < 0 || start_hour > 23)) {
        return reply.status(400).send({ error: 'start_hour 0-23 arasında olmalı' });
      }
      if (end_hour !== null && (end_hour < 0 || end_hour > 23)) {
        return reply.status(400).send({ error: 'end_hour 0-23 arasında olmalı' });
      }

      // scope validation — v1'de vehicle_id zorunlu
      const valid = await validateVehicleScope(client, vehicle_id, companyId, reply);
      if (!valid) { client.release(); return; }

      const { rows } = await client.query(
        `INSERT INTO geofences
           (company_id, name, fence_type, coordinates, radius,
            is_active, alert_on_entry, alert_on_exit,
            category, fence_category, csrd_tracked, start_hour, end_hour, description,
            zone_key, config_version,
            scope_type, vehicle_id)
         VALUES ($1,$2,$3,$4,$5, $6,$7,$8, $9,$9,$10,$11,$12,$13,
                 LEFT(gen_random_uuid()::text, 8), 1,
                 'vehicle', $14)
         RETURNING *`,
        [
          companyId, name, fence_type,
          typeof coordinates === 'string' ? coordinates : JSON.stringify(coordinates),
          radius || null,
          is_active, alert_on_entry, alert_on_exit,
          category, csrd_tracked, start_hour, end_hour, description,
          vehicle_id,
        ]
      );

      const zone = rows[0];

      await publishConfigToAllDevices(fastify, companyId).catch(err =>
        fastify.log.warn({ err }, '[GF] Post-create config publish failed')
      );

      return reply.status(201).send({ geofence: zone });
    } catch (err) {
      fastify.log.error({ err }, 'POST /api/geofences failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── PUT /api/geofences/:id ─────────────────────────────────
  fastify.put('/api/geofences/:id', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id }    = req.params;
      const companyId = req.user.company_id;

      const own = await client.query(
        'SELECT id, config_version, fence_type, coordinates, radius FROM geofences WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (own.rows.length === 0) return reply.status(404).send({ error: 'Zone bulunamadı' });

      const current = own.rows[0];
      const {
        name, fence_type, coordinates, radius,
        is_active, alert_on_entry, alert_on_exit,
        category, csrd_tracked, start_hour, end_hour, description,
        vehicle_id = null,
      } = req.body;

      if (start_hour !== undefined && start_hour !== null && (start_hour < 0 || start_hour > 23)) {
        return reply.status(400).send({ error: 'start_hour 0-23 arasında olmalı' });
      }
      if (end_hour !== undefined && end_hour !== null && (end_hour < 0 || end_hour > 23)) {
        return reply.status(400).send({ error: 'end_hour 0-23 arasında olmalı' });
      }

      // §9.5: kismi güncellemede de NIHAI sekil gecerli olmali — bu yuzden
      // body'de verilmeyen alanlar icin mevcut DB degeri ile birlestirilip
      // (merge) o haliyle dogrulanir.
      const effectiveFenceType = fence_type || current.fence_type;
      let effectiveCoordinates = coordinates !== undefined ? coordinates : current.coordinates;
      if (typeof effectiveCoordinates === 'string') {
        try {
          effectiveCoordinates = JSON.parse(effectiveCoordinates);
        } catch (e) {
          return reply.status(400).send({ error: 'coordinates geçerli bir JSON olmalı' });
        }
      }
      const effectiveRadius = radius !== undefined ? radius : current.radius;
      const geoCheck = validateGeofencePayload({
        fence_type: effectiveFenceType,
        coordinates: effectiveCoordinates,
        radius: effectiveRadius,
      });
      if (!geoCheck.ok) {
        return reply.status(400).send({ error: geoCheck.error });
      }

      // scope validation — vehicle_id geldiyse doğrula
      if (vehicle_id !== null) {
        const valid = await validateVehicleScope(client, vehicle_id, companyId, reply);
        if (!valid) { client.release(); return; }
      }

      const newVersion = (current.config_version || 1) + 1;

      const { rows } = await client.query(
        `UPDATE geofences SET
           name           = COALESCE($1,  name),
           fence_type     = COALESCE($2,  fence_type),
           coordinates    = COALESCE($3::jsonb, coordinates),
           radius         = COALESCE($4,  radius),
           is_active      = COALESCE($5,  is_active),
           alert_on_entry = COALESCE($6,  alert_on_entry),
           alert_on_exit  = COALESCE($7,  alert_on_exit),
           category       = COALESCE($8,  category),
           fence_category = COALESCE($8,  fence_category),
           csrd_tracked   = COALESCE($9,  csrd_tracked),
           start_hour     = $10,
           end_hour       = $11,
           description    = COALESCE($12, description),
           config_version = $13,
           scope_type     = COALESCE(scope_type, 'company'),
           vehicle_id     = COALESCE($14, vehicle_id),
           updated_at     = NOW()
         WHERE id = $15 AND company_id = $16
         RETURNING *`,
        [
          name        || null,
          fence_type  || null,
          coordinates ? JSON.stringify(coordinates) : null,
          radius      !== undefined ? radius      : null,
          is_active   !== undefined ? is_active   : null,
          alert_on_entry !== undefined ? alert_on_entry : null,
          alert_on_exit  !== undefined ? alert_on_exit  : null,
          category    || null,
          csrd_tracked !== undefined ? csrd_tracked : null,
          start_hour  !== undefined ? start_hour : null,
          end_hour    !== undefined ? end_hour   : null,
          description || null,
          newVersion,
          vehicle_id,
          id, companyId,
        ]
      );

      await publishConfigToAllDevices(fastify, companyId).catch(err =>
        fastify.log.warn({ err }, '[GF] Post-update config publish failed')
      );

      return reply.send({ geofence: rows[0] });
    } catch (err) {
      fastify.log.error({ err }, 'PUT /api/geofences/:id failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/geofences/:id ──────────────────────────────
  fastify.delete('/api/geofences/:id', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { id }    = req.params;
      const companyId = req.user.company_id;

      let res;
      if (req.query.hard === 'true' && (req.user.role === 'super_admin' || req.user.role === 'company_admin')) {
        res = await client.query(
          'DELETE FROM geofences WHERE id = $1 AND company_id = $2 RETURNING id',
          [id, companyId]
        );
      } else {
        res = await client.query(
          `UPDATE geofences
           SET is_active  = false,
               updated_at = NOW()
           WHERE id = $1 AND company_id = $2
           RETURNING id`,
          [id, companyId]
        );
      }

      if (res.rows.length === 0) return reply.status(404).send({ error: 'Zone bulunamadı' });

      await publishConfigToAllDevices(fastify, companyId).catch(err =>
        fastify.log.warn({ err }, '[GF] Post-delete config publish failed')
      );

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error({ err }, 'DELETE /api/geofences/:id failed');
      return reply.status(500).send({ error: 'Sunucu hatası' });
    } finally {
      client.release();
    }
  });

};