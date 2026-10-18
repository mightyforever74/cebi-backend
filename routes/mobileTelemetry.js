// routes/mobileTelemetry.js
// ============================================================
// TulipFleet Customer Edition — Mobil Telemetri (ADR-CE-01, ADR-CE-02)
//
// Endpoint:
//   POST /api/driver/telemetry/batch
//     Body: { taskId, pings: [{ clientPingId, latitude, longitude,
//             speed?, heading?, accuracy?, recordedAt }, ...] }
//     → Kimliği doğrulanmış sürücünün KENDİ task'ına ait bir GPS ping
//       kümesini toplu olarak kaydeder. İdempotent: aynı clientPingId
//       tekrar gönderilirse (retry/ağ kopması) sessizce atlanır
//       (UNIQUE constraint + ON CONFLICT DO NOTHING) — mobil taraf, bir
//       batch'in kısmen mi tam mı ulaştığını bilmeden güvenle tekrar
//       gönderebilir.
//
// Task sahiplik kontrolü yapılır (driver_id = kendi drivers.id'si), ama
// task'ın durumu (in_progress/completed) kısıtlanmaz — ağ kopması sonrası
// geç senkronize olan, sefer tamamlandıktan sonra ulaşan ping'ler de
// meşrudur ve kabul edilir (kayıp veri yerine geç veri tercih edilir).
//
// Auth: preHandler [fastify.authenticate], rol: sadece driver (kendi
// task'ı için telemetri gönderir, başka bir sürücü/rol adına gönderemez).
// ============================================================

'use strict';

const MAX_BATCH_SIZE = 500; // tek istekte makul üst sınır — mobil taraf kuyruğu bu boyutlarda dilimlemeli

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validatePing(p) {
  if (!p || typeof p !== 'object') return 'ping bir obje olmalı';
  if (typeof p.clientPingId !== 'string' || !p.clientPingId.trim()) return 'clientPingId zorunlu';
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) return 'latitude geçersiz';
  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) return 'longitude geçersiz';
  if (!p.recordedAt || isNaN(new Date(p.recordedAt).getTime())) return 'recordedAt geçersiz tarih';
  return null;
}

module.exports = async function (fastify) {
  fastify.post(
    '/api/driver/telemetry/batch',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      if (user.role !== 'driver') {
        return reply.code(403).send({ error: 'Sadece driver rolü telemetri gönderebilir' });
      }

      const { taskId, pings } = request.body || {};
      if (!taskId) {
        return reply.code(400).send({ error: 'taskId zorunlu' });
      }
      if (!Array.isArray(pings) || pings.length === 0) {
        return reply.code(400).send({ error: 'pings boş olmayan bir dizi olmalı' });
      }
      if (pings.length > MAX_BATCH_SIZE) {
        return reply.code(400).send({ error: `pings en fazla ${MAX_BATCH_SIZE} eleman olabilir, kuyruğu dilimleyin` });
      }
      for (const p of pings) {
        const err = validatePing(p);
        if (err) {
          return reply.code(400).send({ error: `Geçersiz ping (clientPingId=${p?.clientPingId}): ${err}` });
        }
      }

      const client = await fastify.pg.connect();
      try {
        const { rows: driverRows } = await client.query(
          'SELECT id FROM public.drivers WHERE user_id = $1',
          [user.id]
        );
        if (driverRows.length === 0) {
          return reply.code(404).send({ error: 'Driver not found' });
        }
        const driverId = driverRows[0].id;

        const { rows: taskRows } = await client.query(
          'SELECT id FROM public.tasks WHERE id = $1 AND driver_id = $2',
          [taskId, driverId]
        );
        if (taskRows.length === 0) {
          return reply.code(404).send({ error: 'Task bulunamadı veya bu sürücüye ait değil' });
        }

        // Çoklu VALUES tek INSERT — ON CONFLICT (client_ping_id) DO NOTHING
        // ile idempotent. Her ping 9 sütun değeri üretir; global parametre
        // indeksi (i * 9 + j + 1) ile hesaplanır — satır/sütun karışmasını
        // önlemek için map+flatten ile tek seferde kuruluyor.
        const values = [];
        const rowsSql = pings
          .map((p, i) => {
            const rowValues = [
              p.clientPingId,
              taskId,
              driverId,
              Number(p.latitude),
              Number(p.longitude),
              p.speed != null ? Number(p.speed) : null,
              p.heading != null ? Number(p.heading) : null,
              p.accuracy != null ? Number(p.accuracy) : null,
              new Date(p.recordedAt).toISOString(),
            ];
            const placeholders = rowValues
              .map((_, j) => `$${i * rowValues.length + j + 1}`)
              .join(', ');
            values.push(...rowValues);
            return `(${placeholders})`;
          })
          .join(', ');

        const { rowCount } = await client.query(
          `INSERT INTO public.mobile_location_pings
             (client_ping_id, task_id, driver_id, latitude, longitude, speed, heading, accuracy, recorded_at)
           VALUES ${rowsSql}
           ON CONFLICT (client_ping_id) DO NOTHING`,
          values
        );

        return reply.code(201).send({
          submitted: pings.length,
          accepted: rowCount,
          duplicates: pings.length - rowCount,
        });
      } catch (err) {
        fastify.log.error({ err }, 'POST /api/driver/telemetry/batch failed');
        return reply.code(500).send({ error: 'Sunucu hatası' });
      } finally {
        client.release();
      }
    }
  );
};
