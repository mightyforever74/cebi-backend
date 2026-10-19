"use strict";

const crypto = require("crypto");
const { hydrateVehiclesForRouting } = require("./hydrateVehiclesForRouting");
const { buildHereProblem } = require("./buildHereProblem");

/**
 * HereTourPlanningProvider, Faz A-3 (Gerçek HERE Tour Planning Entegrasyonu)
 * portu. Kaynak: tulipfleet-enterprise-backend/lib/routing/
 * HereTourPlanningProvider.js, orada canlıda doğrulanmış (fleet-enterprise-01
 * shell history, 14/15 Ekim 2026), gerçek 400/401 hatalarıyla sertleşmiş bir
 * implementasyon. MockVrpProvider'ın yerini `VRP_PROVIDER=here-tour` ile
 * alır; aynı enterprise.routing_jobs tablosunu, aynı dedup/hash davranışını
 * ve aynı submitVrp/pollVrp/fetchVrp kontratını paylaşır, çağıran kod
 * (vrpFactory.js, routes/dispatcherTasks.js) Mock'tan bu sınıfa geçişte
 * DEĞİŞMEZ.
 *
 * KASITLI PORT FARKI (axios -> native fetch): kaynak axios kullanıyordu,
 * ama cebi-backend'in KENDİ HERE entegrasyonu (services/routing/
 * HereRoutingProvider.js) "axios/node-fetch bağımlılığı yok" kararını
 * zaten vermiş (Node 18+ global fetch). Yeni bir HTTP kütüphanesi
 * bağımlılığı eklememek için burada aynı native-fetch disiplini izlendi;
 * `_defaultHttpClient` axios'un {get,post} + `err.response.{status,data}`
 * arayüzünü taklit eder ki kaynaktaki mapHereError/kontrol akışı (status
 * kodları, violations, timeout tespiti) HİÇ DEĞİŞMEDEN port edilebilsin.
 * Davranış eşdeğeri, kütüphane farklı.
 *
 * Auth: apikey query-param (HERE_API_KEY), cebi-backend'in mevcut
 * HereRoutingProvider.js ile AYNI desen, zaten üretimde doğrulanmış.
 *
 * Endpoint şeması:
 *   1. POST /v3/problems/async?apikey=...   body: buildHereProblem() çıktısı
 *      ({fleet, plan})                       -> {statusId, href}
 *   2. GET  /v3/status/{statusId}?apikey=... -> {status: pending|inProgress
 *                                                |success|timeout|failure,
 *                                                resource?: {resourceId},
 *                                                error?}
 *   3. GET  /v3/problems/{resourceId}/solution?apikey=...  -> final çözüm
 *
 * pollVrp, status=success gördüğü anda adım 3'ü de yapıp sonucu
 * response_payload'a yazar ve status='completed' döner, fetchVrp,
 * MockVrpProvider ile BİREBİR AYNI: sadece DB'den okur, ikinci bir HERE
 * çağrısı yapmaz.
 *
 * AÇIK RİSK (henüz canlıda doğrulanmadı, cebi-backend'in KENDİ HERE_API_KEY'i
 * için): HERE'in Base Plan fiyatlandırması "Optimization" kategorisini
 * (Tour Planning'in düştüğü kategori) kapsam dışı bırakıyor olabilir, * kaynaktaki hesabın Tour Planning'e erişimi olduğu doğrulandı, ama
 * cebi-backend'in kendi HERE_API_KEY'inin aynı yetkiye sahip olduğu HENÜZ
 * doğrulanmadı. Bu kod bir ön koşul/engel olarak ele alınmadı, VRP_PROVIDER=
 * here-tour set edildiğinde ilk gerçek istekte HERE 403/401 dönerse,
 * submitVrp bunu status='failed'+error_message olarak kaydeder (throw etmez,
 * MockVrpProvider ile aynı "sessiz-değil ama akışı durdurmayan" davranış),
 * runtime bulgusu olarak ortaya çıkar.
 */

const DEFAULT_BASE_URL = "https://tourplanning.hereapi.com/v3";
const DEFAULT_TIMEOUT_MS = 8000; // services/routing/HereRoutingProvider.js'teki HERE_TIMEOUT_MS ile aynı varsayılan büyüklük sınıfı

function buildUrlWithParams(url, params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) usp.set(key, value);
  }
  const qs = usp.toString();
  return qs ? `${url}?${qs}` : url;
}

// axios-uyumlu minimal adaptör: {get, post} + hata şekli {response:{status,data}}
// / {code:'ECONNABORTED'}. Yalnızca bu dosyanın kullandığı yüzey port edildi.
async function fetchJson(url, { method, body, params, headers, timeout }) {
  const fullUrl = buildUrlWithParams(url, params);
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;

  let res;
  try {
    res = await fetch(fullUrl, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json", ...(headers || {}) } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("Request timed out");
      e.code = "ECONNABORTED";
      throw e;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_err) {
      data = text;
    }
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.response = { status: res.status, data };
    throw err;
  }
  return { status: res.status, data };
}

const defaultHttpClient = {
  get(url, config = {}) {
    return fetchJson(url, { method: "GET", ...config });
  },
  post(url, body, config = {}) {
    return fetchJson(url, { method: "POST", body, ...config });
  },
};

// Faz A-3 kapsamına girmedi (ayrı, onaylı bir kontrat gerekir): shift
// zamanlarının gerçek araç vardiyasından türetilmesi. Şimdilik "şimdi
// müsait, 8 saat vardiya" varsayımı, kaynaktaki (2026-10-15) aynı canlı
// bulgunun aynı düzeltmesi: HERE şema doğrulaması shifts[].start.time'ı
// ZORUNLU tutuyor, buildHereProblem bunu kasıtlı olarak atlıyor (saf
// fonksiyon, LOCKED test dosyası), bu yüzden varsayılan burada, HERE'e
// gönderilmeden hemen önce uygulanıyor.
const DEFAULT_SHIFT_DURATION_MS = 8 * 60 * 60 * 1000;

function applyDefaultShiftTimes(hereProblem) {
  for (const fleetType of hereProblem.fleet.types) {
    for (const shift of fleetType.shifts) {
      const startIso = shift.start.time || new Date().toISOString();
      shift.start.time = startIso;
      if (shift.end && !shift.end.time) {
        shift.end.time = new Date(new Date(startIso).getTime() + DEFAULT_SHIFT_DURATION_MS).toISOString();
      }
    }
  }
}

function mapHereError(err) {
  if (err && err.response) {
    const status = err.response.status;
    const body = err.response.data;
    const detail = (body && (body.title || body.message || body.error)) || `HTTP ${status}`;
    // HERE 400 yanıtlarında asıl teşhis bilgisi body.violations/body.details
    // dizisindedir (ör. field path + mesaj), kaybetmeden detail'e ekle.
    const violations = body && (body.violations || body.details);
    const violationsSuffix = violations ? `, violations: ${JSON.stringify(violations)}` : "";
    return `HERE Tour Planning ${status}: ${detail}${violationsSuffix}`;
  }
  if (err && (err.code === "ECONNABORTED" || err.name === "TimeoutError")) {
    return "HERE Tour Planning request timed out";
  }
  return `HERE Tour Planning request failed: ${err && err.message}`;
}

// HERE'in ham çözüm şekli ({statistic, tours, unassigned}), cebi-dispatcher
// frontend'inin (src/hooks/useTaskOptimization.ts) beklediği
// {solver, summary, available_vehicles, tasks} sözleşmesine (MockVrpProvider'ın
// ürettiği şekil) çevrilir.
//   - summary <- statistic.distance/duration (HERE: metre/saniye, bizim
//     alanlarımızla birebir aynı birim).
//   - available_vehicles <- tours[].typeId (buildFleetType'ın ürettiği
//     fleetType.id İLE AYNI DEĞER, yani public.vehicles.id, HERE'in kendi
//     ürettiği "vehicleId" (typeId+"_"+sıra) DEĞİL). Yalnız en az bir durağı
//     olan araçlar listelenir.
//   - tasks <- enterprise.dispatch_tasks, routing_job_id=bu job ile
//     sorgulanır (MockVrpProvider._runBackgroundStateMachine ile BİREBİR
//     AYNI desen).
function normalizeHereSolution(hereSolutionData, dispatchTaskRows, taskIdSequence) {
  const statistic = (hereSolutionData && hereSolutionData.statistic) || {};
  const tours = Array.isArray(hereSolutionData && hereSolutionData.tours) ? hereSolutionData.tours : [];
  const usedVehicleIds = Array.from(
    new Set(
      tours
        .filter((tour) => Array.isArray(tour && tour.stops) && tour.stops.length > 0)
        .map((tour) => tour && tour.typeId)
        .filter(Boolean)
    )
  );

  // tasks[i], HERE'in job-${i} activity jobId'siyle eşleşmek ZORUNDA
  // (buildHereProblem.js, aynı submit isteğinin aynı tasks sırası).
  // taskIdSequence (routes/dispatcherTasks.js'in INSERT...RETURNING ile
  // yakaladığı GERÇEK ekleme sırası) varsa, id'ye göre arama yaparak doğru
  // sırayı garanti eder; yoksa (eski job'lar) DB sırasına sessizce düşülür.
  const byId = new Map((dispatchTaskRows || []).map((row) => [row.id, row]));
  const orderedRows =
    Array.isArray(taskIdSequence) && taskIdSequence.length > 0
      ? taskIdSequence.map((id) => byId.get(id)).filter(Boolean)
      : dispatchTaskRows || [];

  return {
    solver: "here-tour-planning-v3",
    summary: {
      total_distance_meters: Math.round(Number(statistic.distance) || 0),
      total_duration_seconds: Math.round(Number(statistic.duration) || 0),
    },
    available_vehicles: usedVehicleIds,
    tasks: orderedRows.map((row) => ({
      id: row.id,
      pickup_location: row.pickup_location,
      dropoff_location: row.dropoff_location,
    })),
    here_raw_solution: hereSolutionData,
  };
}

class HereTourPlanningProvider {
  /**
   * @param {Object} pgPoolInstance - fastify.pg pool referansı
   * @param {Object} [options]
   * @param {string} [options.apiKey] - varsayılan: process.env.HERE_TOUR_PLANNING_API_KEY || process.env.HERE_API_KEY
   * @param {string} [options.baseUrl] - varsayılan: tourplanning.hereapi.com/v3
   * @param {number} [options.timeoutMs] - istek başına timeout, varsayılan 8000ms
   * @param {Object} [options.httpClient] - enjekte edilebilir {get,post} istemci (test)
   */
  constructor(pgPoolInstance, options = {}) {
    this.db = pgPoolInstance;
    this.apiKey =
      options.apiKey || process.env.HERE_TOUR_PLANNING_API_KEY || process.env.HERE_API_KEY || null;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || Number(process.env.HERE_TOUR_PLANNING_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.http = options.httpClient || defaultHttpClient;

    this.capabilities = {
      computeRoute: false,
      computeMatrix: false,
      traffic: false,
      solveVrp: true,
      tollCost: true,
      ecoRouting: true,
      evConsumption: false,
    };
  }

  _requestConfig(extra = {}) {
    return {
      timeout: this.timeoutMs,
      params: { apikey: this.apiKey, ...(extra.params || {}) },
      ...(extra.headers ? { headers: extra.headers } : {}),
    };
  }

  /**
   * @param {{company_id:string, tasks:Array, vehicles:Array}} problem
   * @param {Object} [trxClient] - Opsiyonel aktif transaction client
   * @returns {Promise<{jobId:string, status:string, triggerBackground:null}>}
   */
  async submitVrp(problem, trxClient = null) {
    const executor = trxClient || this.db;

    const rawPayload = JSON.stringify(problem);
    // Hash provider adını içeriyor (MockVrpProvider ile aynı disiplin), // mock ile atılmış eski bir completed job, VRP_PROVIDER=here-tour'a
    // geçildiğinde HERE'e hiç istek gitmeden sahte bir "sonuç" olarak geri
    // dönmesin diye provider-scoped dedup.
    const requestHash = crypto.createHash("sha256").update(`${rawPayload}::here-tour`).digest("hex");

    const existingJob = await executor.query(
      `SELECT id, status FROM enterprise.routing_jobs
       WHERE request_hash = $1 AND status = 'completed' AND company_id = $2
         AND provider = 'here-tour' LIMIT 1`,
      [requestHash, problem.company_id]
    );
    if (existingJob.rows.length > 0) {
      return { jobId: existingJob.rows[0].id, status: "completed", triggerBackground: null };
    }

    const jobId = crypto.randomUUID();
    let status = "submitted";
    let providerJobId = null;
    let errorMessage = null;
    let hereProblem = null;

    if (!this.apiKey) {
      status = "failed";
      errorMessage =
        "HereTourPlanningProvider: no HERE API key configured (HERE_TOUR_PLANNING_API_KEY / HERE_API_KEY)";
    } else {
      try {
        const vehicleIds = (Array.isArray(problem.vehicles) ? problem.vehicles : [])
          .map((v) => (typeof v === "string" ? v : v && (v.id || v.vehicle_id)))
          .filter(Boolean);
        const { vehicles: hydratedVehicles } = await hydrateVehiclesForRouting(
          executor,
          problem.company_id,
          vehicleIds
        );
        hereProblem = buildHereProblem(Array.isArray(problem.tasks) ? problem.tasks : [], hydratedVehicles);
        applyDefaultShiftTimes(hereProblem);
      } catch (err) {
        // Mock'un aksine bu BEST-EFFORT değil: geçerli bir problem olmadan
        // HERE'e para harcayan bir istek atılmaz.
        status = "failed";
        errorMessage = `buildHereProblem/hydrate failed: ${err.message}`;
      }
    }

    if (status !== "failed") {
      try {
        const res = await this.http.post(
          `${this.baseUrl}/problems/async`,
          hereProblem,
          this._requestConfig({ headers: { "Content-Type": "application/json" } })
        );
        providerJobId = res.data && res.data.statusId;
        if (!providerJobId) {
          throw new Error("HERE async submit response missing statusId");
        }
      } catch (err) {
        status = "failed";
        errorMessage = mapHereError(err);
        // Teşhis için gönderilen tam HERE problem body'si ve HERE'in tam
        // yanıt body'si (API key içermez) console.error ile yazılır, // "OpenApi validation error" tek başına hangi alanın kırıldığını
        // söylemiyor (kaynaktaki 2026-10-15 canlı bulgusuyla aynı ihtiyaç).
        console.error(
          "[HereTourPlanningProvider] HERE problems/async hata - tam detay:",
          JSON.stringify({
            sentProblem: hereProblem,
            hereResponseStatus: err && err.response && err.response.status,
            hereResponseBody: err && err.response && err.response.data,
          })
        );
      }
    }

    const storedPayload = JSON.stringify({ ...problem, here_problem: hereProblem });

    await executor.query(
      `INSERT INTO enterprise.routing_jobs
       (id, company_id, provider, provider_job_id, request_hash, status, request_payload, submitted_at, error_message, completed_at)
       VALUES ($1, $2, 'here-tour', $3, $4, $5, $6, NOW(), $7, $8)`,
      [jobId, problem.company_id, providerJobId, requestHash, status, storedPayload, errorMessage, status === "failed" ? new Date() : null]
    );

    // Gerçek sağlayıcıda arka plan simülasyonu yok, durum değişimi HERE'in
    // kendi sunucularında gerçekleşir; çağıran pollVrp ile takip eder.
    return { jobId, status, triggerBackground: null };
  }

  /**
   * @param {string} jobId
   * @returns {Promise<{status:string, error:(string|null)}>}
   */
  async pollVrp(jobId) {
    const result = await this.db.query(
      "SELECT status, provider_job_id, error_message, request_payload FROM enterprise.routing_jobs WHERE id = $1 LIMIT 1",
      [jobId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Job ${jobId} not found.`);
    }
    const row = result.rows[0];

    if (row.status === "completed" || row.status === "failed") {
      return { status: row.status, error: row.error_message };
    }
    if (!row.provider_job_id) {
      return { status: row.status, error: row.error_message };
    }

    let statusRes;
    try {
      statusRes = await this.http.get(`${this.baseUrl}/status/${row.provider_job_id}`, this._requestConfig());
    } catch (err) {
      // Geçici ağ/HERE hatası: job durumu değişmeden kalır, çağıran tekrar dener.
      return { status: row.status, error: mapHereError(err) };
    }

    const hereStatus = statusRes.data && statusRes.data.status;

    if (hereStatus === "failure" || hereStatus === "timeout") {
      const msg = (statusRes.data.error && statusRes.data.error.message) || `HERE job ${hereStatus}`;
      await this.db.query(
        `UPDATE enterprise.routing_jobs SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1`,
        [jobId, msg]
      );
      return { status: "failed", error: msg };
    }

    if (hereStatus === "success") {
      const resourceId = statusRes.data.resource && statusRes.data.resource.resourceId;
      if (!resourceId) {
        const msg = "HERE status=success but resource.resourceId missing";
        await this.db.query(
          `UPDATE enterprise.routing_jobs SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1`,
          [jobId, msg]
        );
        return { status: "failed", error: msg };
      }
      try {
        const solutionRes = await this.http.get(
          `${this.baseUrl}/problems/${resourceId}/solution`,
          this._requestConfig()
        );
        const dispatchTasksRes = await this.db.query(
          `SELECT id, pickup_location, dropoff_location
           FROM enterprise.dispatch_tasks WHERE routing_job_id = $1`,
          [jobId]
        );
        const taskIdSequence =
          row.request_payload && Array.isArray(row.request_payload.task_id_sequence)
            ? row.request_payload.task_id_sequence
            : null;
        const normalized = normalizeHereSolution(solutionRes.data, dispatchTasksRes.rows, taskIdSequence);
        await this.db.query(
          `UPDATE enterprise.routing_jobs
           SET status = 'completed', response_payload = $1, provider_job_id = $2, completed_at = NOW()
           WHERE id = $3`,
          [JSON.stringify(normalized), resourceId, jobId]
        );
        return { status: "completed", error: null };
      } catch (err) {
        // Çözüm henüz hazır değilse HERE 404 döner, job'u failed'e düşürmeden
        // olduğu gibi bırak, bir sonraki pollVrp tekrar dener.
        return { status: row.status, error: mapHereError(err) };
      }
    }

    // pending | inProgress
    await this.db.query(
      `UPDATE enterprise.routing_jobs SET status = 'running' WHERE id = $1 AND status = 'submitted'`,
      [jobId]
    );
    return { status: "running", error: null };
  }

  /**
   * MockVrpProvider ile birebir aynı: yalnızca DB'den okur. Çözümün HERE'den
   * çekilmesi pollVrp'nin işi (status=success anında); fetchVrp ikinci bir
   * HERE isteği ATMAZ.
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

module.exports = HereTourPlanningProvider;
module.exports.mapHereError = mapHereError;
module.exports.normalizeHereSolution = normalizeHereSolution;
