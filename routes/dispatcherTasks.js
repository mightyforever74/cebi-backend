"use strict";

/**
 * Dispatcher tasks — liste + VRP optimizasyon zinciri.
 *
 * GET  /api/dispatcher/tasks?filter=pending_review|today|planned   (Faz A)
 * POST /dispatcher/tasks/optimize             (Faz A-2 — DİKKAT: /api öneki YOK)
 * GET  /dispatcher/tasks/optimize/poll/:id    (Faz A-2 — DİKKAT: /api öneki YOK)
 * POST /dispatcher/tasks/optimize/approve     (Faz A-2 — DİKKAT: /api öneki YOK)
 *
 * Kaynak: tulipfleet-enterprise-backend/routes/tasks.js. İlk üçü (liste) Faz
 * A'da BİREBİR port edildi. optimize/poll/approve route'larının `/api`
 * öneki OLMADIĞI kasıtlı değil, kaynağın kendi tutarsızlığı — ama
 * `cebi-dispatcher` frontend'i (src/hooks/useTaskOptimization.ts) bu
 * öneksiz path'lere sabit kodlanmış, bu yüzden BİREBİR korunuyor (frontend'i
 * kırmamak için "düzeltilmedi").
 *
 * FAZ A-2 (2026-10-19, VRP Optimizasyon Portu) — Faz A'da kasıtlı olarak bu
 * dosyadan dışarıda bırakılan optimize/poll/approve zinciri artık portlandı.
 * İki mimari engel şöyle çözüldü:
 *   (a) VRP sağlayıcı soyutlaması: `lib/routing/vrpFactory.js` +
 *       `lib/routing/MockVrpProvider.js` (YENİ, cebi-backend'in kendi tekil
 *       rota sağlayıcısından — `services/routing/factory.js` — TAMAMEN AYRI,
 *       isim/env çakışması yok — bkz. vrpFactory.js başlık yorumu).
 *   (b) internalBridge.js'e giden eski HTTP self-call (axios +
 *       INTERNAL_CORE_API_URL + X-Internal-Bridge-Token) KALDIRILDI —
 *       `createBridgedTask()` artık doğrudan, in-process çağrılıyor (ADR-CE-03
 *       tek-süreçli mimarinin sağladığı bir basitleştirme: bridge'in
 *       dış-sınır güvenlik kontrolleri sadece HTTP route'un kendisi için
 *       geçerli, aynı süreç içi çağrı için anlamsız). Ayrıca bu, approve'un
 *       per-draft transaction'ını (assigned işareti + köprü INSERT'i) GERÇEK
 *       bir atomik transaction haline getirdi — kaynakta iki ayrı süreç
 *       olduğu için bu mümkün değildi (bkz. internalBridge.js başlık yorumu).
 * KASITLI OLARAK HÂLÂ PORT EDİLMEDİ: `HereTourPlanningProvider` (gerçek HERE
 * Tour Planning/VRP çözücü) — kaynakta da varsayılan değil, Mock zaten
 * kaynağın production'da GERÇEKTEN çalıştırdığı davranış (bkz. vrpFactory.js).
 * Takip işi: "Faz A-3: Gerçek HERE VRP Entegrasyonu".
 *
 * Company-scoped (ADR-0009 §4.4).
 */
const { getVrpProvider } = require("../lib/routing/vrpFactory");
const { createProvider } = require("../services/routing/factory");
const { haversineMeters } = require("../lib/geoDistance");
const { createBridgedTask } = require("./internalBridge");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * HERE Routing API v8 (truck) süre tahmini; HERE yoksa/hata/timeout →
 * haversine mesafe @ 40 km/h + %15 buffer (kaynaktaki Spec v3 fallback'in
 * birebir aynısı). cebi-backend'in kendi `services/routing/factory.js` +
 * `HereRoutingProvider`'ı reuse edilir (Faz A'nın `routes/active`'inde
 * zaten kanıtlanmış aynı desen) — YENİ bir axios/HTTP çağrısı YAZILMADI.
 * Koordinat sayısal değilse dürüst varsayılan: 2 saat (loglanır).
 */
async function estimateDriveSeconds(pickup, dropoff, log) {
  const coordsOk =
    Number.isFinite(pickup.lat) &&
    Number.isFinite(pickup.lng) &&
    Number.isFinite(dropoff.lat) &&
    Number.isFinite(dropoff.lng);
  if (!coordsOk) {
    if (log) {
      log.warn(
        { pickup, dropoff },
        "[FazA2] Sayısal koordinat yok - varsayılan 2 saat pencere"
      );
    }
    return 2 * 3600;
  }

  try {
    const provider = createProvider();
    const result = await provider.computeRoute({
      origin: { lat: pickup.lat, lon: pickup.lng },
      destination: { lat: dropoff.lat, lon: dropoff.lng },
      transportMode: "truck",
    });
    if (result.durationSec > 0) return result.durationSec;
  } catch (err) {
    if (log) {
      log.warn({ err: err.message }, "[FazA2] HERE süre alınamadı - fallback");
    }
  }

  const km =
    haversineMeters(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng) / 1000;
  return Math.round((km / 40) * 3600 * 1.15);
}

// DB kolonları timestamp WITHOUT tz, DB saati Etc/UTC (cebi-backend'de de
// aynı varsayım, bkz. dispatcherLocations.js) → UTC duvar saati tz'siz ISO.
function toDbTimestamp(date) {
  return date.toISOString().slice(0, 19);
}

async function dispatcherTasksRoutes(fastify) {
  // ── GET /api/dispatcher/tasks (Faz A) ──
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

  // ── POST /dispatcher/tasks/optimize (Faz A-2, /api öneki YOK — kasıtlı, bkz. başlık) ──
  fastify.post(
    "/dispatcher/tasks/optimize",
    { preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")] },
    async (request, reply) => {
      const { tasks, vehicles, routingMode, appointments, evConsumption } =
        request.body;
      const companyId = request.user.company_id;

      if (!companyId) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Token missing company_id claim",
        });
      }

      if (!tasks || !vehicles || !Array.isArray(tasks) || tasks.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Missing mandatory fields: non-empty tasks array or vehicles.",
        });
      }

      const client = await fastify.pg.connect();

      try {
        await client.query("BEGIN");

        const provider = getVrpProvider(fastify.pg);
        const problem = {
          company_id: companyId,
          tasks,
          vehicles,
          routingMode,
          appointments,
          evConsumption,
        };

        const { jobId, status, triggerBackground } = await provider.submitVrp(
          problem,
          client
        );

        // Dedup hit: completed job zaten var. Tüketilmemiş draft varsa aynen
        // dönülür; draft=0 ise AYNI jobId'ye taslaklar yeniden doğurulur
        // (kaynaktaki 2026-07-31 FIX'in birebir aynısı).
        if (status === "completed") {
          const draftCnt = await client.query(
            `SELECT count(*)::int AS n FROM enterprise.dispatch_tasks
             WHERE routing_job_id = $1 AND company_id = $2 AND status = 'draft'`,
            [jobId, companyId]
          );
          if (draftCnt.rows[0].n > 0) {
            await client.query("ROLLBACK");
            return reply.status(200).send({
              message: "Existing completed optimization returned via deduplication.",
              jobId,
              status,
            });
          }
          request.log.info(
            { jobId },
            "dedup: completed job'un draft'lari tuketilmis - taslaklar yeniden dogurulacak"
          );
        }

        // Draft Doğum: her input task, jobId'ye bağlı bir draft dispatch_task olur.
        const insertedTaskIds = [];
        for (const taskItem of tasks) {
          const pickup = taskItem.pickup_location;
          const dropoff = taskItem.dropoff_location;

          if (
            !pickup ||
            !dropoff ||
            typeof pickup !== "object" ||
            typeof dropoff !== "object" ||
            Array.isArray(pickup) ||
            Array.isArray(dropoff)
          ) {
            throw new ValidationError(
              "pickup_location and dropoff_location are required JSON objects ({lat, lng, address})."
            );
          }

          const capacity =
            taskItem.capacity_required && typeof taskItem.capacity_required === "object"
              ? JSON.stringify(taskItem.capacity_required)
              : null;
          const skill = Array.isArray(taskItem.skill_required)
            ? taskItem.skill_required
            : null;

          const insertRes = await client.query(
            `INSERT INTO enterprise.dispatch_tasks (
               id, company_id, status, pickup_location, dropoff_location,
               capacity_required, skill_required, routing_job_id, created_at, updated_at
             ) VALUES (
               gen_random_uuid(), $1, 'draft', $2, $3, $4, $5, $6, NOW(), NOW()
             ) RETURNING id`,
            [companyId, JSON.stringify(pickup), JSON.stringify(dropoff), capacity, skill, jobId]
          );
          insertedTaskIds.push(insertRes.rows[0].id);
        }

        if (insertedTaskIds.length > 0) {
          await client.query(
            `UPDATE enterprise.routing_jobs
             SET request_payload = COALESCE(request_payload, '{}'::jsonb)
               || jsonb_build_object('task_id_sequence', $1::jsonb)
             WHERE id = $2`,
            [JSON.stringify(insertedTaskIds), jobId]
          );
        }

        await client.query("COMMIT");

        // Race-safe: arka plan state machine'i YALNIZ COMMIT SONRASI ateşlenir.
        if (triggerBackground) triggerBackground();

        return reply.status(202).send({
          message: "VRP optimization job registered. Dispatch tasks created in draft status.",
          jobId,
          status,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});

        if (err.name === "ValidationError") {
          return reply.status(400).send({ error: "Bad Request", message: err.message });
        }

        request.log.error({ err }, "VRP optimization draft pipeline failed");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "An internal error occurred while initializing optimization.",
        });
      } finally {
        client.release();
      }
    }
  );

  // ── GET /dispatcher/tasks/optimize/poll/:id (Faz A-2, /api öneki YOK — kasıtlı) ──
  fastify.get(
    "/dispatcher/tasks/optimize/poll/:id",
    { preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")] },
    async (request, reply) => {
      const jobId = request.params.id;
      if (!jobId) {
        return reply.status(400).send({ error: "Missing mandatory jobId parameter." });
      }

      const provider = getVrpProvider(fastify.pg);
      const jobStatus = await provider.pollVrp(jobId);

      if (jobStatus.status === "completed") {
        const resultPayload = await provider.fetchVrp(jobId);
        return reply.status(200).send({ jobId, status: jobStatus.status, result: resultPayload });
      }

      return reply.status(200).send({ jobId, status: jobStatus.status, error: jobStatus.error });
    }
  );

  // ── POST /dispatcher/tasks/optimize/approve (Faz A-2, /api öneki YOK — kasıtlı) ──
  // Plan onay orkestratörü: completed job'ın draft dispatch_tasks'larını
  // available_vehicles'a dağıtır (manuel atama varsa onu kullanır, yoksa
  // round-robin fallback), sürücüyü araçtan türetir, dispatch_tasks'ı
  // assigned yapar, köprüye (createBridgedTask, in-process) push eder.
  fastify.post(
    "/dispatcher/tasks/optimize/approve",
    { preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")] },
    async (request, reply) => {
      const { routing_job_id, vehicle_assignments, time_windows, override, override_reason } =
        request.body;
      const companyId = request.user.company_id;

      if (!companyId) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Token missing company_id claim",
        });
      }
      if (!routing_job_id) {
        return reply.status(400).send({ error: "Bad Request", message: "Missing routing_job_id." });
      }

      const manualAssignments = new Map();
      if (Array.isArray(vehicle_assignments)) {
        for (const a of vehicle_assignments) {
          if (a && typeof a.taskId === "string" && typeof a.vehicleId === "string") {
            manualAssignments.set(a.taskId, a.vehicleId);
          }
        }
      }

      const windowStarts = new Map();
      if (Array.isArray(time_windows)) {
        for (const w of time_windows) {
          if (w && typeof w.taskId === "string" && w.start) {
            const d = new Date(w.start);
            if (!Number.isNaN(d.getTime())) windowStarts.set(w.taskId, d);
          }
        }
      }

      // KALDIRILDI (Faz A-2): kaynaktaki INTERNAL_CORE_API_URL/INTERNAL_BRIDGE_TOKEN
      // 503 ön-kontrolü. createBridgedTask() artık in-process çağrılıyor — bu
      // env değişkenlerine hiç ihtiyaç yok (bkz. internalBridge.js başlık yorumu).

      const client = await fastify.pg.connect();
      try {
        const jobRes = await client.query(
          `SELECT status, response_payload FROM enterprise.routing_jobs
           WHERE id = $1 AND company_id = $2 LIMIT 1`,
          [routing_job_id, companyId]
        );
        if (jobRes.rows.length === 0) {
          return reply.status(404).send({ error: "Not Found", message: "Routing job not found." });
        }
        if (jobRes.rows[0].status !== "completed") {
          return reply.status(409).send({
            error: "Conflict",
            message: "Routing job is not completed yet.",
          });
        }

        const payload = jobRes.rows[0].response_payload || {};
        const payloadVehicles = Array.isArray(payload.available_vehicles)
          ? payload.available_vehicles
          : [];
        // Savunma: sağlayıcı ne döndürürse döndürsün, yalnız token şirketine
        // ait araçlar atanabilir. Çapraz-şirket araç köprüye hiç gitmez.
        let availableVehicles = [];
        if (payloadVehicles.length > 0) {
          const ownRes = await client.query(
            `SELECT id FROM public.vehicles WHERE company_id = $1 AND id = ANY($2::uuid[])`,
            [companyId, payloadVehicles]
          );
          const own = new Set(ownRes.rows.map((r) => r.id));
          availableVehicles = payloadVehicles.filter((id) => own.has(id));
          if (availableVehicles.length !== payloadVehicles.length) {
            request.log.warn(
              { routing_job_id, dropped: payloadVehicles.length - availableVehicles.length },
              "approve: available_vehicles contained vehicles outside the token company; dropped"
            );
          }
        }
        if (availableVehicles.length === 0) {
          return reply.status(422).send({
            error: "Unprocessable",
            message: "No available vehicles in optimization result.",
          });
        }

        const draftRes = await client.query(
          `SELECT id, pickup_location, dropoff_location
           FROM enterprise.dispatch_tasks
           WHERE routing_job_id = $1 AND company_id = $2 AND status = 'draft'
           ORDER BY created_at ASC`,
          [routing_job_id, companyId]
        );

        if (draftRes.rows.length === 0) {
          return reply.status(200).send({
            success: true,
            message: "No draft tasks to approve.",
            pushed: 0,
          });
        }

        const pushed = [];
        const overriddenConflicts = [];
        const conflicts = [];
        let firstConflictMessage = null;
        let i = 0;
        for (const draft of draftRes.rows) {
          let vehicleId = manualAssignments.get(draft.id);
          if (!vehicleId || !availableVehicles.includes(vehicleId)) {
            vehicleId = availableVehicles[i % availableVehicles.length];
          }
          i++;

          const drvRes = await client.query(
            `SELECT user_id FROM public.drivers WHERE assigned_vehicle_id = $1 LIMIT 1`,
            [vehicleId]
          );
          const userId = drvRes.rows[0]?.user_id || null;

          const pickup = draft.pickup_location || {};
          const dropoff = draft.dropoff_location || {};
          const startStr =
            pickup.address || (pickup.lat != null ? `${pickup.lat},${pickup.lng}` : "Bilinmeyen");
          const endStr =
            dropoff.address || (dropoff.lat != null ? `${dropoff.lat},${dropoff.lng}` : "Bilinmeyen");

          const startDate = windowStarts.get(draft.id) || new Date();
          const pickupNum = { lat: Number(pickup.lat), lng: Number(pickup.lng) };
          const dropoffNum = { lat: Number(dropoff.lat), lng: Number(dropoff.lng) };
          const driveSec = await estimateDriveSeconds(pickupNum, dropoffNum, request.log);
          const endDate = new Date(startDate.getTime() + driveSec * 1000);
          const schedStart = toDbTimestamp(startDate);
          const schedEnd = toDbTimestamp(endDate);

          // Draft-başına transaction: assigned işareti + köprü INSERT'i AYNI
          // transaction'da (ownClient=false — createBridgedTask kendi BEGIN/
          // COMMIT'ini yapmaz, bu bloğunkini kullanır). Bkz. internalBridge.js
          // başlık yorumu: bu, tek-süreçli mimarinin sağladığı gerçek bir
          // atomiklik iyileştirmesi.
          await client.query("BEGIN");
          await client.query(
            `UPDATE enterprise.dispatch_tasks
             SET status = 'assigned', assigned_vehicle_id = $1, assigned_driver_id = $2, updated_at = NOW()
             WHERE id = $3`,
            [vehicleId, userId, draft.id]
          );

          let bridgeResult;
          try {
            bridgeResult = await createBridgedTask(
              fastify,
              {
                enterprise_dispatch_task_id: draft.id,
                company_id: companyId,
                user_id: userId,
                vehicle_id: vehicleId,
                title: null,
                description: null,
                created_by_user_id: request.user.id,
                start_location_str: startStr,
                end_location_str: endStr,
                priority: "normal",
                scheduled_start: schedStart,
                scheduled_end: schedEnd,
                override: !!override,
              },
              client
            );
          } catch (bridgeErr) {
            await client.query("ROLLBACK").catch(() => {});
            throw bridgeErr;
          }

          if (bridgeResult.status === 409) {
            await client.query("ROLLBACK").catch(() => {});
            const meta = bridgeResult.body?.conflict_metadata || null;
            if (firstConflictMessage === null) {
              firstConflictMessage = bridgeResult.body?.message || null;
            }
            conflicts.push({ draft_id: draft.id, vehicle_id: vehicleId, conflict_metadata: meta });
            request.log.warn(
              { draftId: draft.id, vehicleId, meta },
              "[FazA2] Köprü overlap 409 - draft atlandı, döngü sürüyor"
            );
            continue;
          }

          if (bridgeResult.status !== 201) {
            await client.query("ROLLBACK").catch(() => {});
            throw new Error(`Unexpected bridge status: ${bridgeResult.status}`);
          }

          if (bridgeResult.body?.conflict_metadata) {
            overriddenConflicts.push({
              draft_id: draft.id,
              vehicle_id: vehicleId,
              ...bridgeResult.body.conflict_metadata,
            });
          }

          pushed.push(draft.id);
          await client.query("COMMIT");
          // Push, SADECE kendi COMMIT'imiz kesinleştikten sonra ateşlenir.
          if (bridgeResult.firePush) bridgeResult.firePush();
        }

        if (overriddenConflicts.length > 0) {
          await client.query(
            `UPDATE enterprise.routing_jobs
             SET response_payload = COALESCE(response_payload, '{}'::jsonb) ||
                 jsonb_build_object(
                   'conflict_metadata', $1::jsonb,
                   'conflict_override_reason', $2::text
                 )
             WHERE id = $3 AND company_id = $4`,
            [
              JSON.stringify(overriddenConflicts),
              typeof override_reason === "string" ? override_reason.slice(0, 500) : null,
              routing_job_id,
              companyId,
            ]
          );
        }

        if (pushed.length === 0 && conflicts.length > 0) {
          return reply.status(409).send({
            error: "Conflict",
            message: firstConflictMessage || "Bu araca belirtilen aralıkta atanmış görev var.",
            conflict_metadata: conflicts[0].conflict_metadata,
            conflicting_draft_id: conflicts[0].draft_id,
            pushed_before_conflict: 0,
            conflicts,
          });
        }

        return reply.status(200).send({
          success: true,
          message:
            conflicts.length > 0
              ? `Plan partially approved: ${pushed.length} pushed, ${conflicts.length} conflicts.`
              : "Plan approved and pushed.",
          pushed: pushed.length,
          tasks: pushed,
          conflicts: conflicts.length > 0 ? conflicts : undefined,
          overridden_conflicts: overriddenConflicts.length > 0 ? overriddenConflicts : undefined,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error({ err }, "Approve orchestrator failed");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Plan approval failed.",
        });
      } finally {
        client.release();
      }
    }
  );
}

module.exports = dispatcherTasksRoutes;
