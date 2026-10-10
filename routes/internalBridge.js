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
 *
 * A2 (2026-07-22): Turetilmis baslik (derivedTitle). Dispatcher/enterprise
 * gorevleri title GONDERMEZ -> mobil listede TLP-26-XXXXX kodu gorunuyordu
 * (AdminTasks.js:212 `task.title || task.task_no`). Kopru, ZATEN elinde olan
 * start/end_location_str'den okunabilir baslik turetir (push body'si ayni
 * veriyi zaten kullaniyordu). Mobil admin gorevlerinde title dolu gelir ->
 * fallback devreye girmez. Varchar zirhi: 255'e kirpilir.
 *
 * BUG-1 Spec v3 Faz A+B (2026-08-02): Zaman penceresi zinciri + overlap 409.
 * - Payload'a scheduled_start / scheduled_end (ISO, UTC saat — DB kolonlari
 *   timestamp WITHOUT tz, DB Etc/UTC kanitli) + override (bool) eklendi.
 * - INSERT bu iki kolonu MUHURLER (onceden hic yazilmiyordu — 3-katman
 *   eksiginin son halkasi).
 * - CAKISMA DENETIMI (Validation Engine, dispatcher kanali): ayni vehicle_id
 *   uzerinde aktif statulerdeki (assigned/accepted/in_progress/pending_review)
 *   gorevlerle tsrange kesisimi -> HTTP 409 + conflict_metadata
 *   {conflicting_task_no, overlap_minutes}. Denetim NUMARATORDEN ONCE kosulur
 *   (409'da task_no sayaci yakilmaz). NULL pencereli eski gorevler muaftir
 *   (karar 2b — idx_tasks_time_overlap predicate'iyle ayni sozlesme).
 * - override=true (Mode 1 Advisory — "Gerekceli Onay") gelirse 409 atlanir;
 *   conflict_metadata yine hesaplanir ve YANITTA doner ki enterprise/UI
 *   FN-18 karar loguna (Faz C) muhurleyebilsin.
 */

// P1-3b (10 Eki, TODO_ACTIVE §4 "FCM/push sablonu ... kullanici diline gore"):
// public.users.language zaten var (kayitta INSERT edilir, sendOTPEmail zaten
// kullanir) ama push hic okumuyordu - her surucu sabit TR metin aliyordu.
// Karar (Cem, 10 Eki): TR/EN/NL icin tam sablon; mobilin desteklediği diger
// diller (de/fr/it/bg/es/ku) veya eksik/bilinmeyen deger EN'e duser.
const SUPPORTED_PUSH_LANGUAGES = new Set(["tr", "en", "nl"]);

const PUSH_TEMPLATES = {
  taskAssigned: {
    tr: (v) => ({
      title: "Yeni Görev Atandı",
      body: `${v.taskNo}: ${v.startLabel} → ${v.endLabel}`,
    }),
    en: (v) => ({
      title: "New Task Assigned",
      body: `${v.taskNo}: ${v.startLabel} → ${v.endLabel}`,
    }),
    nl: (v) => ({
      title: "Nieuwe taak toegewezen",
      body: `${v.taskNo}: ${v.startLabel} → ${v.endLabel}`,
    }),
  },
};

/** tr/en/nl pass through; anything else (including null/undefined/unknown) -> en. */
function resolvePushLanguage(language) {
  return SUPPORTED_PUSH_LANGUAGES.has(language) ? language : "en";
}

/** Renders a push template's {title, body} for the resolved language. */
function renderPushCopy(templateKey, language, vars) {
  const template = PUSH_TEMPLATES[templateKey];
  const lang = resolvePushLanguage(language);
  return template[lang](vars || {});
}

// Best-effort push gonderimi. Hata firlatmaz (no-throw), cagiran kodu etkilemez.
async function sendPushNotification(fastify, { userId, templateKey, vars, data }) {
  if (!userId) return;
  try {
    const client = await fastify.pg.connect();
    let pushToken = null;
    let language = null;
    try {
      const { rows } = await client.query(
        "SELECT expo_push_token, language FROM users WHERE id = $1",
        [userId]
      );
      pushToken = rows[0]?.expo_push_token || null;
      language = rows[0]?.language || null;
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

    const { title, body } = renderPushCopy(templateKey, language, vars);

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
        // BUG-1 Faz A: zaman penceresi zinciri (ISO string, UTC saat)
        scheduled_start,
        scheduled_end,
        // BUG-1 Faz C on-hazirligi: Mode 1 "Gerekceli Onay" bayragi
        override,
        created_by_user_id,
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

      // A2 (2026-07-22): Dispatcher title gondermez -> adreslerden okunabilir
      // baslik turet. Mobil gorevlerde title dolu -> fallback devreye girmez.
      const derivedTitle = (
        title || `${start_location_str} → ${end_location_str}`
      ).slice(0, 255);

      // SORUN 2 ÇÖZÜMÜ: Numaratör ve INSERT adımları tek bir atomik PostgreSQL Transaction zırhına alınır!
      await client.query("BEGIN");

      // ── BUG-1 Faz B: CAKISMA DENETIMI (numaratorden ONCE — 409'da sayac yanmaz) ──
      // Yalniz her iki pencere de doluysa kosulur (karar 2b: NULL'lar muaf).
      let conflictMetadata = null;
      if (vehicle_id && scheduled_start && scheduled_end) {
        const { rows: confRows } = await client.query(
          `SELECT task_no,
                  ROUND(EXTRACT(EPOCH FROM (
                    LEAST(scheduled_end, $3::timestamp) -
                    GREATEST(scheduled_start, $2::timestamp)
                  )) / 60.0)::int AS overlap_minutes
           FROM tasks
           WHERE vehicle_id = $1
             AND status IN ('assigned','accepted','in_progress','pending_review')
             AND scheduled_start IS NOT NULL
             AND scheduled_end IS NOT NULL
             AND tsrange(scheduled_start, scheduled_end) &&
                 tsrange($2::timestamp, $3::timestamp)
           ORDER BY scheduled_start ASC
           LIMIT 1`,
          [vehicle_id, scheduled_start, scheduled_end]
        );
        if (confRows.length > 0) {
          conflictMetadata = {
            conflicting_task_no: confRows[0].task_no,
            overlap_minutes: confRows[0].overlap_minutes,
          };
          if (!override) {
            await client.query("ROLLBACK");
            fastify.log.warn(
              { vehicle_id, conflictMetadata },
              "[BridgeOverlapBlocked] Zaman penceresi cakismasi — 409"
            );
            return reply.status(409).send({
              error: "Conflict",
              message: `Bu araca belirtilen aralıkta atanmış görev var (${conflictMetadata.conflicting_task_no}, çakışma ~${conflictMetadata.overlap_minutes} dk).`,
              conflict_metadata: conflictMetadata,
            });
          }
          // override=true: Mode 1 Advisory — insan kurali deldi; metadata
          // yanitla doner, FN-18 karar loguna muhurlenmesi cagiranin isi (Faz C).
          fastify.log.info(
            { vehicle_id, conflictMetadata },
            "[BridgeOverlapOverride] Cakisma override ile gecildi (Gerekceli Onay)"
          );
        }
      }

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
      // BUG-1 Faz A: scheduled_start/end artik MUHURLENIR (null-safe — pencere
      // gelmezse NULL kalir, overlap denetimi de zaten kosulmamis olur).
      const { rows: insertedTask } = await client.query(
        `INSERT INTO tasks (
          id, task_no, driver_id, vehicle_id, title, description, 
          start_location, end_location, priority, status, company_id, 
          enterprise_dispatch_task_id, scheduled_start, scheduled_end,
          created_by, created_at, updated_at, distance_source
         ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'assigned', $9, $10,
          $11::timestamp, $12::timestamp, $13, NOW(), NOW(), 'manual'
         ) RETURNING id, task_no`,
        [
          task_no,
          driver_id,
          vehicle_id,
          derivedTitle,
          description == null ? null : description,
          start_location_str.slice(0, 255), // Varchar(255) kırpma zırhı
          end_location_str.slice(0, 255), // Varchar(255) kırpma zırhı
          priority || "normal",
          company_id,
          enterprise_dispatch_task_id,
          scheduled_start || null,
          scheduled_end || null,
          created_by_user_id || null,
        ]
      );

      await client.query("COMMIT"); // TÜM İŞLEMLERİ ATOMİK OLARAK VERİTABANINA KİLİTLE!

      // FIX (2026-07-18): Push bildirimi - COMMIT SONRASI, best-effort, no-throw.
      // Transaction'a dahil degil, basarisiz olursa task olusturma etkilenmez.
      if (user_id) {
        sendPushNotification(fastify, {
          userId: user_id,
          templateKey: "taskAssigned",
          vars: { taskNo: task_no, startLabel: start_location_str, endLabel: end_location_str },
          data: { taskNo: insertedTask[0].task_no, taskId: insertedTask[0].id },
        }).catch(() => {}); // ekstra guvenlik agi, fonksiyon zaten no-throw
      }

      return reply.status(201).send({
        success: true,
        taskId: insertedTask[0].id,
        taskNo: insertedTask[0].task_no,
        // BUG-1: override ile gecilen cakisma varsa cagirana muhurlenmek uzere doner
        conflict_metadata: conflictMetadata,
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
module.exports.sendPushNotification = sendPushNotification;
module.exports.renderPushCopy = renderPushCopy;
module.exports.resolvePushLanguage = resolvePushLanguage;

