// routes/reconciliation.js
// ============================================================
// ADR-CE-04 — Sefer Kapanış Reconciliation'ı (gün-seviyesi otomatik
// kapanış: planlanan vs. tamamlanan sefer sayısı eşleştirmesi).
// Asıl değerlendirme/kapanış mantığı services/reconciliation/
// tripReconciliation.js'te (iki tetikleyici: sefer tamamlama, gece yarısı
// cron'u, bkz. server.js). Bu dosya SADECE görünürlük (GET) ve istisnai
// override (PUT) için insan arayüzüdür.
//
// Endpoints:
//   GET  /api/reconciliation/daily?date=YYYY-MM-DD&driverId=?
//     → O gün için (tüm sürücüler veya tek bir sürücü) reconciliation
//       durumunu listeler. Roller: dispatcher, company_admin, super_admin.
//   PUT  /api/reconciliation/:driverId/:date/override
//     → Planlanan sefer sayısını elle değiştirir (ADR §B.1 "Override").
//       Body: { plannedCountOverride: number|null, reason: string (zorunlu) }
//       plannedCountOverride=null → override kaldırılır, otomatik türetilen
//       sayı tekrar geçerli olur. Her iki durumda da reason zorunlu
//       (audit, ADR §B.1 "loglanır") ve override_log'a ayrı bir satır
//       olarak eklenir (geçmiş kaybolmaz).
//       **Yetki: SADECE company_admin/super_admin** (ADR §B.1 — dispatcher
//       bu sayıyı değiştiremez, caydırıcılık amacını zayıflatmasın diye).
//       Override hemen ardından günü isEndOfDay=true ile yeniden
//       değerlendirir (admin sonucu anında görür — kapandı mı, hâlâ
//       istisna mı).
// ============================================================

"use strict";

const { evaluateDriverDay } = require("../services/reconciliation/tripReconciliation");

const VIEW_ROLES = ["dispatcher", "company_admin", "super_admin"];
const OVERRIDE_ROLES = ["company_admin", "super_admin"];

function hasRole(user, allowed) {
  return !!user && allowed.includes(user.role);
}

module.exports = async function (fastify) {
  // ── O gün için reconciliation durumunu listele ─────────────────────────
  fastify.get(
    "/api/reconciliation/daily",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      if (!hasRole(user, VIEW_ROLES)) {
        return reply.code(403).send({ error: "Bu role reconciliation görüntüleme yetkisi yok" });
      }

      const { date, driverId } = request.query || {};
      if (!date) {
        return reply.code(400).send({ error: "date (YYYY-MM-DD) zorunlu" });
      }

      try {
        const conditions = ["reconciliation_date = $1::date"];
        const params = [date];

        if (user.role !== "super_admin") {
          params.push(user.company_id);
          conditions.push(`company_id = $${params.length}`);
        }
        if (driverId) {
          params.push(driverId);
          conditions.push(`driver_id = $${params.length}`);
        }

        const { rows } = await fastify.pg.query(
          `SELECT r.*, u.first_name, u.last_name
           FROM public.daily_trip_reconciliation r
           JOIN public.drivers d ON d.id = r.driver_id
           JOIN public.users u ON u.id = d.user_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY r.updated_at DESC`,
          params
        );

        return { reconciliations: rows };
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  // ── Planlanan sefer sayısını elle değiştir (ADR §B.1 Override) ─────────
  fastify.put(
    "/api/reconciliation/:driverId/:date/override",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user;
      if (!hasRole(user, OVERRIDE_ROLES)) {
        return reply.code(403).send({
          error: "Bu role planlanan sefer sayısını değiştirme yetkisi yok (sadece company_admin/super_admin)",
        });
      }

      const { driverId, date } = request.params;
      const { plannedCountOverride, reason } = request.body || {};

      if (!reason || typeof reason !== "string" || !reason.trim()) {
        return reply.code(400).send({ error: "reason zorunlu (audit için)" });
      }
      if (
        plannedCountOverride !== null &&
        plannedCountOverride !== undefined &&
        (!Number.isInteger(plannedCountOverride) || plannedCountOverride < 0)
      ) {
        return reply.code(400).send({
          error: "plannedCountOverride null veya negatif olmayan bir tam sayı olmalı",
        });
      }
      const overrideValue =
        plannedCountOverride === undefined ? null : plannedCountOverride;

      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");

        const driverQuery =
          user.role === "super_admin"
            ? "SELECT id, company_id FROM public.drivers WHERE id = $1"
            : "SELECT id, company_id FROM public.drivers WHERE id = $1 AND company_id = $2";
        const driverParams =
          user.role === "super_admin" ? [driverId] : [driverId, user.company_id];
        const { rows: driverRows } = await client.query(driverQuery, driverParams);
        if (driverRows.length === 0) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Sürücü bulunamadı" });
        }
        const companyId = driverRows[0].company_id;

        const { rows: upserted } = await client.query(
          `INSERT INTO public.daily_trip_reconciliation
             (company_id, driver_id, reconciliation_date, planned_count_override,
              override_set_by, override_set_at, override_reason, status, updated_at)
           VALUES ($1, $2, $3::date, $4, $5, NOW(), $6, 'pending', NOW())
           ON CONFLICT (driver_id, reconciliation_date) DO UPDATE SET
             planned_count_override = EXCLUDED.planned_count_override,
             override_set_by = EXCLUDED.override_set_by,
             override_set_at = EXCLUDED.override_set_at,
             override_reason = EXCLUDED.override_reason,
             status = 'pending',
             closed_at = NULL,
             exception_event_id = NULL,
             updated_at = NOW()
           RETURNING id`,
          [companyId, driverId, date, overrideValue, user.id, reason.trim()]
        );
        const reconciliationId = upserted[0].id;

        await client.query(
          `INSERT INTO public.daily_trip_reconciliation_override_log
             (reconciliation_id, planned_count_override, set_by, reason)
           VALUES ($1, $2, $3, $4)`,
          [reconciliationId, overrideValue, user.id, reason.trim()]
        );

        // Override, bir onceki terminal durumu "pending"e geri aldigi icin
        // (yukaridaki UPSERT), gunu hemen isEndOfDay=true ile yeniden
        // degerlendiriyoruz - admin sonucu bu cevapta ANINDA gorur (kapandi
        // mi, hala istisna mi), bir sonraki tetikleyiciyi (gece yarisi
        // cron'u) beklemeden.
        const outcome = await evaluateDriverDay(client, request.log, {
          companyId,
          driverId,
          date,
          isEndOfDay: true,
        });

        await client.query("COMMIT");
        return { success: true, outcome };
      } catch (error) {
        await client.query("ROLLBACK");
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      } finally {
        client.release();
      }
    }
  );
};
