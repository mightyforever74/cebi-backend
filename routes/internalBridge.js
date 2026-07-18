"use strict";

/**
 * TulipFleet Core — Kurşun Geçirmez İnce Köprü API Endpoint'i
 * Aligned with ADR-0009 §5.2 & INTEGRATION_BOUNDARIES (Fail-Closed Auth & Atomic Trx)
 *
 * FIX (2026-07-18): Push notification eklendi. Onceden task INSERT ediliyordu
 * ama surucuye hicbir bildirim gitmiyordu (BUG #2, bkz. ARCHITECTURE_DECISION
 * task-management-api-driven.md SS4.1). Expo Push API kullanilir (mobil
 * usePushNotifications.js -> POST /api/push/register ile zaten kayitli olan
 * expo_push_token uzerinden). Push, COMMIT SONRASI, best-effort (no-throw)
 * cagrilir - transaction'in bir parcasi degildir, basarisiz olsa bile task
 * olusturma islemi geri alinmaz.
 */

// Best-effort push gonderimi. Hata firlatmaz (no-throw), cagiran kodu etkilemez.
async function sendPushNotification(fastify, { userId, title, body, data }) {
  if (!userId) return;
  try {
    const client = await fastify.pg.connect();
    let pushToken = null;
    try {
      const { rows } = await client.query(
        "SELECT expo_push_token FROM users WHERE id = $1",
        [userId]
      );
      pushToken = rows[0]?.expo_push_token || null;
    } finally {
      client.release();
    }

    if (!pushToken) {
      fastify.log.info(
        { userId },
        "[Push] No expo_push_token registered, skipping"
      );
      return;
    }

    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: pushToken,
        title,
        body,
        data: data || {},
        sound: "default",
      }),
    });

    if (!res.ok) {
      fastify.log.warn(
        { status: res.status, userId },
        "[Push] Expo push send failed"
      );
    } else {
      fastify.log.info({ userId }, "[Push] Notification sent");
    }
  } catch (err) {
    fastify.log.error(
      { err, userId },
      "[Push] sendPushNotification failed (no-throw)"
    );
  }
}

async function internalBridgeRoutes(fastify) {
  // 1. GÜVENLİK FİLTRESİ: IP Allowlist ve FAIL-CLOSED Token Denetimi
  fastify.addHook("onRequest", async (request, reply) => {
    const clientIp = request.ip || request.socket.remoteAddress || "";

    // SORUN 1 ÇÖZÜMÜ: Hardcoded fallback temizlendi. Token yoksa sistem fail-closed ile kendini kapatır!
    const expectedToken = process.env.INTERNAL_BRIDGE_TOKEN;
    if (!expectedToken) {
      fastify.log.error(
        "[BridgeSecurityFatal] INTERNAL_BRIDGE_TOKEN env variable is missing. Bridge interface isolated."
      );
      return reply
        .status(503)
        .send({
          error: "Service Unavailable",
          message: "Bridge infrastructure is unconfigured.",
        });
    }

    const internalToken = request.headers["x-internal-bridge-token"];
    const isLocalhost = clientIp === "127.0.0.1" || clientIp === "::1";
    const isPrivateNetwork =
      clientIp.startsWith("10.") ||
      clientIp.startsWith("172.16.") ||
      clientIp.startsWith("192.168.");

    if (!isLocalhost && !isPrivateNetwork) {
      fastify.log.warn(
        { clientIp },
        "[BridgeAttackBlocked] External perimeter network boundary breach attempted."
      );
      return reply
        .status(403)
        .send({
          error: "Forbidden",
          message: "Network boundary isolation fault.",
        });
    }

    if (!internalToken || internalToken !== expectedToken) {
      fastify.log.warn(
        { clientIp },
        "[BridgeAuthBlocked] Authentication token handshake mismatched."
      );
      return reply
        .status(401)
        .send({
          error: "Unauthorized",
          message: "Bridge identity verification token mismatched.",
        });
    }
  });

  // 2. ATOMİK İNCE KÖPRÜ GİRİŞİ
  fastify.post("/api/internal/bridge/tasks", async (request, reply) => {
    const client = await fastify.pg.connect();

    try {
      const {
        enterprise_dispatch_task_id,
        company_id,
        user_id, // Enterprise'dan gelen assigned_driver_id (users.id)
        vehicle_id,
        title,
        description,
        start_location_str, // SORUN 3 ÇÖZÜMÜ: Sözleşme gereği düz varchar(255) string metin gelir
        end_location_str, // SORUN 3 ÇÖZÜMÜ: Sözleşme gereği düz varchar(255) string metin gelir
        priority,
      } = request.body;

      if (!company_id || !start_location_str || !end_location_str) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message:
              "Missing mandatory thin bridge contract payload attributes.",
          });
      }

      // SORUN 2 ÇÖZÜMÜ: Numaratör ve INSERT adımları tek bir atomik PostgreSQL Transaction zırhına alınır!
      await client.query("BEGIN");

      // Sürücü Profil Kimliği Çeviri İstasyonu (users.id -> drivers.id)
      let driver_id = null;
      if (user_id) {
        const { rows: drvRows } = await client.query(
          "SELECT id FROM drivers WHERE user_id = $1 LIMIT 1",
          [user_id]
        );
        driver_id = drvRows[0]?.id || null;
      }

      // Canlı Kod Satır 2262-2265 Gerçeği: Kolon adı 'code', fallback 'TLP'
      const { rows: companyRows } = await client.query(
        "SELECT code FROM companies WHERE id = $1 LIMIT 1",
        [company_id]
      );
      const companyCode = companyRows[0]?.code || "TLP";
      const year = new Date().getFullYear() % 100; // 26

      // Canlı Kod Satır 2270-2274 Gerçeği: Atomik Numaratör Artırımı
      const { rows: counterRows } = await client.query(
        `INSERT INTO company_task_counters (company_id, year, last_number)
         VALUES ($1, $2, 1)
         ON CONFLICT (company_id, year)
         DO UPDATE SET last_number = company_task_counters.last_number + 1, updated_at = NOW()
         RETURNING last_number`,
        [company_id, 2000 + year]
      );

      const taskNumber = counterRows[0].last_number;
      const task_no = `${companyCode}-${year}-${String(taskNumber).padStart(
        5,
        "0"
      )}`;

      // Güvenli public.tasks INSERT işlemi (Varchar veri tipi uyuşmazlığı tamamen çözüldü)
      const { rows: insertedTask } = await client.query(
        `INSERT INTO tasks (
          id, task_no, driver_id, vehicle_id, title, description, 
          start_location, end_location, priority, status, company_id, 
          enterprise_dispatch_task_id, created_at, updated_at, distance_source
         ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'assigned', $9, $10, NOW(), NOW(), 'manual'
         ) RETURNING id, task_no`,
        [
          task_no,
          driver_id,
          vehicle_id,
          title,
          description,
          start_location_str.slice(0, 255), // Varchar(255) kırpma zırhı
          end_location_str.slice(0, 255), // Varchar(255) kırpma zırhı
          priority || "normal",
          company_id,
          enterprise_dispatch_task_id,
        ]
      );

      await client.query("COMMIT"); // TÜM İŞLEMLERİ ATOMİK OLARAK VERİTABANINA KİLİTLE!

      // FIX (2026-07-18): Push bildirimi - COMMIT SONRASI, best-effort, no-throw.
      // Transaction'a dahil degil, basarisiz olursa task olusturma etkilenmez.
      if (user_id) {
        sendPushNotification(fastify, {
          userId: user_id,
          title: "Yeni Görev Atandı",
          body: `${task_no}: ${start_location_str} → ${end_location_str}`,
          data: { taskNo: insertedTask[0].task_no, taskId: insertedTask[0].id },
        }).catch(() => {}); // ekstra guvenlik agi, fonksiyon zaten no-throw
      }

      return reply.status(201).send({
        success: true,
        taskId: insertedTask[0].id,
        taskNo: insertedTask[0].task_no,
      });
    } catch (err) {
      await client.query("ROLLBACK"); // En ufak hatada geri çekil, numaratör sırasını koru!
      fastify.log.error(
        err,
        "[BridgeTransactionCrashed] Core monolit bridge atomic query collapsed."
      );
      return reply
        .status(500)
        .send({
          error: "Internal Server Error",
          message: "Atomic bridge synchronization collapsed.",
        });
    } finally {
      client.release();
    }
  });
}

module.exports = internalBridgeRoutes;
