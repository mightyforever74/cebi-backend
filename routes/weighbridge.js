// routes/weighbridge.js
// ============================================================
// TulipFleet Customer Edition — Weighbridge Operations
// Faz 1 §3 (Weighbridge Operations bounded context, Faz 1'de kod yoktu),
// §8.4 (adapter pattern), §9.5 (zorunlu + değişmez — kaçak/kayıp yüklemeyi
// önleyen caydırıcı kontrol), ADR-CE-04 §2-A (tartım kaydı olmadan sefer
// "Completed" durumuna geçemez).
//
// Endpoints:
//   POST /api/weighbridge/readings
//     → Yeni tartım kaydı. Body: { taskId, adapterType? (default 'manual'),
//       weightKg (adapterType='manual' ise zorunlu), note? }
//   GET  /api/weighbridge/tasks/:taskId/readings
//     → Bir seferin tüm tartım geçmişi (düzeltme zinciri dahil, en yeni önce)
//   GET  /api/weighbridge/tasks/:taskId/current
//     → Bir seferin GÜNCEL (henüz düzeltilmemiş) tartım kaydı var mı?
//       { hasReading: boolean, reading: {...} | null } — gate kontrolü için.
//   POST /api/weighbridge/readings/:id/correct
//     → Mevcut bir kaydı DEĞİŞTİRMEZ (append-only) — supersedes_id ile yeni
//       bir satır ekler. Body: { weightKg, reason (zorunlu) }
//
// Auth: preHandler [fastify.authenticate]. Roller: weighbridge_operator
// (Tartı Memuru, §9.6'da eklenen 5. rol), dispatcher, company_admin,
// super_admin — driver tartım girişi yapamaz (fiziksel tartı işlemi sürücü
// değil operatör/dispatcher tarafından yapılır).
//
// NOT: Bu route'lar tartım kaydı oluşturur/okur. ADR-CE-04 §2-A'daki
// "Completed" gate'i AYRICA BURADA DEĞİL — server.js'deki "Complete Task"
// endpoint'inde (public.weighbridge_readings_current sorgusu, bkz. yakl.
// satır 5530+) uygulanmıştır; cebi_e2e_test.sh ile canlıda doğrulanmıştır
// (bkz. scripts/dev/cebi_e2e_test.sh, SESSION_NOTE.md).
// ============================================================

'use strict';

const { getWeighbridgeAdapter } = require('../services/weighbridge');

const RECORD_ROLES = ['weighbridge_operator', 'dispatcher', 'company_admin', 'super_admin'];

function hasRole(user, allowed) {
  return !!user && allowed.includes(user.role);
}

module.exports = async function (fastify) {
  // ── Bir sefer için tartım kaydı oluştur ────────────────────────────────
  fastify.post(
    '/api/weighbridge/readings',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      if (!hasRole(user, RECORD_ROLES)) {
        return reply.code(403).send({ error: 'Bu role tartım kaydı girme yetkisi yok' });
      }

      const { taskId, adapterType, weightKg, note } = request.body || {};
      if (!taskId) {
        return reply.code(400).send({ error: 'taskId zorunlu' });
      }

      const resolvedAdapterType = adapterType || 'manual';

      const client = await fastify.pg.connect();
      try {
        // Task'ı doğrula — company-scope (super_admin hariç, mevcut desenle tutarlı)
        const taskQuery =
          user.role === 'super_admin'
            ? 'SELECT id, vehicle_id FROM tasks WHERE id = $1'
            : 'SELECT id, vehicle_id FROM tasks WHERE id = $1 AND company_id = $2';
        const taskParams = user.role === 'super_admin' ? [taskId] : [taskId, user.company_id];
        const { rows: taskRows } = await client.query(taskQuery, taskParams);
        if (taskRows.length === 0) {
          return reply.code(404).send({ error: 'Task bulunamadı' });
        }
        const vehicleId = taskRows[0].vehicle_id || null;

        let captured;
        try {
          const adapter = getWeighbridgeAdapter(resolvedAdapterType);
          captured = await adapter.captureWeight({ taskId, vehicleId, userId: user.id, weightKg, note });
        } catch (adapterErr) {
          const statusCode = adapterErr.statusCode || 400;
          return reply.code(statusCode).send({ error: adapterErr.message });
        }

        const { rows } = await client.query(
          `INSERT INTO public.weighbridge_readings
             (task_id, vehicle_id, weight_kg, adapter_type, device_identifier, raw_payload, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, task_id, vehicle_id, weight_kg, adapter_type, device_identifier, raw_payload, recorded_by, recorded_at`,
          [
            taskId,
            vehicleId,
            captured.weightKg,
            resolvedAdapterType,
            captured.deviceIdentifier,
            captured.rawPayload ? JSON.stringify(captured.rawPayload) : null,
            user.id,
          ]
        );

        return reply.code(201).send({ reading: rows[0] });
      } catch (err) {
        fastify.log.error({ err }, 'POST /api/weighbridge/readings failed');
        return reply.code(500).send({ error: 'Sunucu hatası' });
      } finally {
        client.release();
      }
    }
  );

  // ── Bir seferin tüm tartım geçmişi (düzeltme zinciri dahil) ───────────
  fastify.get(
    '/api/weighbridge/tasks/:taskId/readings',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      const { taskId } = request.params;

      const client = await fastify.pg.connect();
      try {
        const taskQuery =
          user.role === 'super_admin'
            ? 'SELECT id FROM tasks WHERE id = $1'
            : 'SELECT id FROM tasks WHERE id = $1 AND company_id = $2';
        const taskParams = user.role === 'super_admin' ? [taskId] : [taskId, user.company_id];
        const { rows: taskRows } = await client.query(taskQuery, taskParams);
        if (taskRows.length === 0) {
          return reply.code(404).send({ error: 'Task bulunamadı' });
        }

        const { rows } = await client.query(
          `SELECT id, task_id, vehicle_id, weight_kg, adapter_type, device_identifier,
                  recorded_by, recorded_at, supersedes_id, supersede_reason
           FROM public.weighbridge_readings
           WHERE task_id = $1
           ORDER BY recorded_at DESC`,
          [taskId]
        );

        return reply.send({ readings: rows });
      } catch (err) {
        fastify.log.error({ err }, 'GET /api/weighbridge/tasks/:taskId/readings failed');
        return reply.code(500).send({ error: 'Sunucu hatası' });
      } finally {
        client.release();
      }
    }
  );

  // ── Gate kontrolü: bu sefer tartılmış mı? (weighbridge_readings_current) ─
  fastify.get(
    '/api/weighbridge/tasks/:taskId/current',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      const { taskId } = request.params;

      const client = await fastify.pg.connect();
      try {
        const taskQuery =
          user.role === 'super_admin'
            ? 'SELECT id FROM tasks WHERE id = $1'
            : 'SELECT id FROM tasks WHERE id = $1 AND company_id = $2';
        const taskParams = user.role === 'super_admin' ? [taskId] : [taskId, user.company_id];
        const { rows: taskRows } = await client.query(taskQuery, taskParams);
        if (taskRows.length === 0) {
          return reply.code(404).send({ error: 'Task bulunamadı' });
        }

        const { rows } = await client.query(
          `SELECT id, task_id, vehicle_id, weight_kg, adapter_type, device_identifier,
                  recorded_by, recorded_at
           FROM public.weighbridge_readings_current
           WHERE task_id = $1
           ORDER BY recorded_at DESC
           LIMIT 1`,
          [taskId]
        );

        return reply.send({ hasReading: rows.length > 0, reading: rows[0] || null });
      } catch (err) {
        fastify.log.error({ err }, 'GET /api/weighbridge/tasks/:taskId/current failed');
        return reply.code(500).send({ error: 'Sunucu hatası' });
      } finally {
        client.release();
      }
    }
  );

  // ── Düzeltme: mevcut kaydı DEĞİŞTİRMEZ, supersedes_id ile yeni satır ekler ─
  fastify.post(
    '/api/weighbridge/readings/:id/correct',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      if (!hasRole(user, RECORD_ROLES)) {
        return reply.code(403).send({ error: 'Bu role tartım kaydını düzeltme yetkisi yok' });
      }

      const { id: originalId } = request.params;
      const { weightKg, reason } = request.body || {};

      if (!reason || !String(reason).trim()) {
        return reply.code(400).send({ error: 'reason zorunlu — düzeltme gerekçesiz girilemez (§9.5 audit)' });
      }
      const parsedWeight = Number(weightKg);
      if (!Number.isFinite(parsedWeight) || parsedWeight < 0) {
        return reply.code(400).send({ error: 'weightKg geçerli, negatif olmayan bir sayı olmalı' });
      }

      const client = await fastify.pg.connect();
      try {
        const originalQuery =
          user.role === 'super_admin'
            ? `SELECT r.id, r.task_id, r.vehicle_id, r.adapter_type, r.device_identifier
               FROM public.weighbridge_readings r
               WHERE r.id = $1`
            : `SELECT r.id, r.task_id, r.vehicle_id, r.adapter_type, r.device_identifier
               FROM public.weighbridge_readings r
               JOIN tasks t ON t.id = r.task_id
               WHERE r.id = $1 AND t.company_id = $2`;
        const originalParams = user.role === 'super_admin' ? [originalId] : [originalId, user.company_id];
        const { rows: originalRows } = await client.query(originalQuery, originalParams);
        if (originalRows.length === 0) {
          return reply.code(404).send({ error: 'Orijinal tartım kaydı bulunamadı' });
        }
        const original = originalRows[0];

        const { rows } = await client.query(
          `INSERT INTO public.weighbridge_readings
             (task_id, vehicle_id, weight_kg, adapter_type, device_identifier, recorded_by, supersedes_id, supersede_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, task_id, vehicle_id, weight_kg, adapter_type, device_identifier, recorded_by, recorded_at, supersedes_id, supersede_reason`,
          [
            original.task_id,
            original.vehicle_id,
            parsedWeight,
            original.adapter_type,
            original.device_identifier,
            user.id,
            original.id,
            String(reason).trim(),
          ]
        );

        return reply.code(201).send({ reading: rows[0] });
      } catch (err) {
        fastify.log.error({ err }, 'POST /api/weighbridge/readings/:id/correct failed');
        return reply.code(500).send({ error: 'Sunucu hatası' });
      } finally {
        client.release();
      }
    }
  );
};
