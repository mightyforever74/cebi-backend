"use strict";

const crypto = require("crypto");
const { haversineMeters } = require("../geoDistance");

/**
 * MockVrpProvider — Faz A-2 (VRP Optimizasyon Portu).
 *
 * `tulipfleet-enterprise-backend/lib/routing/MockRoutingProvider.js`'ten
 * port. Kaynakta "Mock" adı aldatıcı olabilir: `ROUTING_PROVIDER=here-tour`
 * (gerçek HERE Tour Planning çözücüsü) hiçbir ortamda varsayılan değil —
 * yani bu, kaynağın PRODUCTION'DA GERÇEKTEN ÇALIŞTIRDIĞI state machine'in
 * birebir portu, demo/iskelet kod değil.
 *
 * KASITLI OLARAK PORT EDİLMEDİ: kaynaktaki `simulateHereProblem()` best-effort
 * eki (`hydrateVehiclesForRouting.js` + `buildHereProblem.js`'e bağımlı,
 * `request_payload.here_problem` alanına gelecekteki gerçek HERE Tour
 * Planning entegrasyonu için bir "ön hazırlık" JSON'u yazıyordu). Doğrulandı:
 * `cebi-dispatcher` frontend'i `here_problem` alanını HİÇBİR YERDE okumuyor
 * (grep ile kontrol edildi) — submitVrp/pollVrp/fetchVrp kontratını
 * etkilemiyor, tamamen kozmetik bir simülasyondu. Atlanması surface area'yı
 * azaltıyor, gerçek HERE VRP entegrasyonu geldiğinde (Faz A-3) zaten
 * yeniden yazılacaktı.
 */
class MockVrpProvider {
  /**
   * @param {Object} pgPoolInstance - fastify.pg pool referansı
   */
  constructor(pgPoolInstance) {
    this.db = pgPoolInstance;
    this.capabilities = {
      computeRoute: false,
      solveVrp: true,
      tollCost: false,
      ecoRouting: false,
    };
  }

  /**
   * VRP problemini kaydeder. Aktif bir transaction client geçirilirse
   * routing_jobs INSERT'i O transaction içinde çalışır; arka plan state
   * machine'i BURADA ateşlenmez (henüz commit olmamış satırla yarışırdı).
   * Bunun yerine çağıranın COMMIT SONRASI çağıracağı bir triggerBackground
   * callback'i döner.
   * @param {{company_id:string, tasks:Array, vehicles:Array, routingMode?:string, appointments?:Array, evConsumption?:Object}} problem
   * @param {Object} [trxClient] - Opsiyonel aktif transaction client
   * @returns {Promise<{jobId:string, status:string, triggerBackground:(Function|null)}>}
   */
  async submitVrp(problem, trxClient = null) {
    const executor = trxClient || this.db;

    const rawPayload = JSON.stringify(problem);
    // enterprise.routing_jobs'daki UNIQUE index (request_hash) WHERE
    // status='completed' — provider'dan BAĞIMSIZ (bkz. migrations/
    // 1778687553584_enterprise-schema-init.sql). Hash'e provider adını
    // katmak, farklı bir sağlayıcı aynı girdiyle denendiğinde (ör. ileride
    // here-tour) ikinci sağlayıcının eski mock sonucunu yanlışlıkla
    // dedup'lamasını / unique constraint'e çarpmasını önler (kaynaktaki
    // aynı FIX, 2026-10-15).
    const requestHash = crypto
      .createHash("sha256")
      .update(`${rawPayload}::mock`)
      .digest("hex");

    // Strict dedup: company + provider scoped, sadece completed job'larda.
    const existingJob = await executor.query(
      `SELECT id, status FROM enterprise.routing_jobs
       WHERE request_hash = $1 AND status = 'completed' AND company_id = $2
         AND provider = 'mock' LIMIT 1`,
      [requestHash, problem.company_id]
    );

    if (existingJob.rows.length > 0) {
      return {
        jobId: existingJob.rows[0].id,
        status: "completed",
        triggerBackground: null,
      };
    }

    const jobId = crypto.randomUUID();

    await executor.query(
      `INSERT INTO enterprise.routing_jobs
       (id, company_id, provider, request_hash, status, request_payload, submitted_at)
       VALUES ($1, $2, 'mock', $3, 'submitted', $4, NOW())`,
      [jobId, problem.company_id, requestHash, rawPayload]
    );

    const triggerBackground = async () => {
      this._runBackgroundStateMachine(jobId).catch((err) => {
        console.error(
          `[MockVrpBackgroundError] Job ${jobId} status iteration failed:`,
          err
        );
      });
    };

    return { jobId, status: "submitted", triggerBackground };
  }

  /**
   * Simüle edilmiş, in-process async worker döngüsü. `this.db` (pool)
   * üzerinde çalışır, herhangi bir transaction client'ta DEĞİL — çağıranın
   * transaction'ı bu ateşlendiğinde zaten commit olmuş olmalı.
   * BİLİNEN SINIRLAMA: in-process — Fastify süreci yeniden başlarsa
   * "running" durumunda kalan job'lar sonsuza dek takılır (kaynakla aynı
   * sınırlama, kaynakta da düzeltilmemiş).
   * @private
   */
  async _runBackgroundStateMachine(jobId) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // submitted -> running (3s)
    await sleep(3000);
    await this.db.query(
      "UPDATE enterprise.routing_jobs SET status = 'running' WHERE id = $1 AND status = 'submitted'",
      [jobId]
    );

    // running -> completed + mock payload (3s)
    await sleep(3000);

    const draftTasksRes = await this.db.query(
      `SELECT id, pickup_location, dropoff_location
       FROM enterprise.dispatch_tasks
       WHERE routing_job_id = $1 AND status = 'draft'
       ORDER BY created_at ASC`,
      [jobId]
    );

    // available_vehicles İSTEĞİN KENDİ araçlarından türetilir, sabit/seed
    // veri DEĞİL. Kural: request_payload.vehicles ∩ public.vehicles(company_id
    // = job.company_id). Boş kalırsa job 'failed' (çapraz-şirket araç sızıntısı
    // engellenir — kaynaktaki 2026-09-27 cutover bulgusuyla aynı disiplin).
    const jobRow = await this.db.query(
      `SELECT company_id, request_payload FROM enterprise.routing_jobs
       WHERE id = $1 LIMIT 1`,
      [jobId]
    );
    const jobCompanyId = jobRow.rows[0]?.company_id || null;
    const reqPayload = jobRow.rows[0]?.request_payload || {};
    const requestedVehicleIds = (Array.isArray(reqPayload.vehicles) ? reqPayload.vehicles : [])
      .map((v) => (typeof v === "string" ? v : v && (v.id || v.vehicle_id)))
      .filter(Boolean);

    let availableVehicles = [];
    if (jobCompanyId && requestedVehicleIds.length > 0) {
      const vehRes = await this.db.query(
        `SELECT id FROM public.vehicles
         WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [jobCompanyId, requestedVehicleIds]
      );
      const allowed = new Set(vehRes.rows.map((r) => r.id));
      availableVehicles = requestedVehicleIds.filter((id) => allowed.has(id));
    }

    if (availableVehicles.length === 0) {
      await this.db.query(
        `UPDATE enterprise.routing_jobs
         SET status = 'failed',
             error_message = 'No vehicles in request belong to this company',
             completed_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [jobId]
      );
      return;
    }

    // summary, draft task'ların gerçek pickup->dropoff kuş uçuşu (haversine)
    // mesafesinden toplanır — sabit/uydurma sayı DEĞİL. DÜRÜSTLÜK NOTU
    // (kaynaktan birebir): bu hâlâ kuş uçuşu toplamı, gerçek sürüş rotası
    // değil; gerçek HERE VRP entegrasyonu (Faz A-3) ayrı, henüz yok.
    const AVG_SPEED_KMH = 60;
    const totalDistanceMeters = draftTasksRes.rows.reduce((sum, t) => {
      if (!t.pickup_location || !t.dropoff_location) return sum;
      return (
        sum +
        haversineMeters(
          t.pickup_location.lat,
          t.pickup_location.lng,
          t.dropoff_location.lat,
          t.dropoff_location.lng
        )
      );
    }, 0);
    const totalDurationSeconds = Math.round(
      (totalDistanceMeters / 1000 / AVG_SPEED_KMH) * 3600
    );

    const mockVrpResult = {
      solver: "mock-optimization-engine",
      summary: {
        total_distance_meters: Math.round(totalDistanceMeters),
        total_duration_seconds: totalDurationSeconds,
      },
      available_vehicles: availableVehicles,
      tasks: draftTasksRes.rows.map((t) => ({
        id: t.id,
        pickup_location: t.pickup_location,
        dropoff_location: t.dropoff_location,
      })),
    };

    await this.db.query(
      `UPDATE enterprise.routing_jobs
       SET status = 'completed', response_payload = $1, completed_at = NOW()
       WHERE id = $2 AND status = 'running'`,
      [JSON.stringify(mockVrpResult), jobId]
    );
  }

  /**
   * @param {string} jobId
   * @returns {Promise<{status:string, error:(string|null)}>}
   */
  async pollVrp(jobId) {
    const result = await this.db.query(
      "SELECT status, error_message FROM enterprise.routing_jobs WHERE id = $1 LIMIT 1",
      [jobId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Job ${jobId} not found.`);
    }

    return {
      status: result.rows[0].status,
      error: result.rows[0].error_message,
    };
  }

  /**
   * @param {string} jobId
   * @returns {Promise<Object>}
   */
  async fetchVrp(jobId) {
    const result = await this.db.query(
      "SELECT status, response_payload FROM enterprise.routing_jobs WHERE id = $1 LIMIT 1",
      [jobId]
    );

    if (result.rows.length === 0 || result.rows[0].status !== "completed") {
      throw new Error(`Job ${jobId} is not in a completed state.`);
    }

    return result.rows[0].response_payload;
  }
}

module.exports = MockVrpProvider;
