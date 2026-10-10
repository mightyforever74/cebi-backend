"use strict";

const crypto = require("crypto");
const rateLimit = require("@fastify/rate-limit");
const { createProvider } = require("../services/routing/factory");

const PUBLIC_TRACK_BASE_DEFAULT = "https://track.tulipfleet.com/v";
const PUBLIC_TRACK_JSON_404 = { error: "Invalid or expired link" };
const PUBLIC_TRACK_CLOSED = new Set(["completed", "cancelled", "withdrawn"]);
const PUBLIC_TRACK_DUMMY = "0".repeat(32);

// staging fleet_tracking_staging tasks_status_check (2026-09-29):
// pending, pending_review, accepted, assigned, rejected,
// in_progress, completed, cancelled, withdrawn.
// The only value in that set that means the vehicle is driving is in_progress.
const PUBLIC_TRACK_LIVE = new Set(["in_progress"]);

const PUBLIC_TRACK_STATUS_TR = {
  pending: "Bekliyor",
  pending_review: "İnceleniyor",
  accepted: "Kabul Edildi",
  assigned: "Atandı",
  rejected: "Reddedildi",
  in_progress: "Devam Ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal edildi",
  withdrawn: "Geri çekildi",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripInternalIds(value) {
  if (Array.isArray(value)) return value.map(stripInternalIds);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || key.endsWith("_id")) continue;
    out[key] = stripInternalIds(child);
  }
  return out;
}

function publicHtmlShell(lang, title, inner) {
  return (
    "<!DOCTYPE html><html lang=\"" +
    escapeHtml(lang) +
    "\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">" +
    "<title>" +
    escapeHtml(title) +
    "</title></head><body style=\"font-family:Arial,sans-serif;text-align:center;padding:60px;\">" +
    inner +
    "</body></html>"
  );
}

function publicTrackUrl(token) {
  const raw = process.env.PUBLIC_TRACK_BASE_URL;
  const base =
    raw && String(raw).trim() ? String(raw).trim() : PUBLIC_TRACK_BASE_DEFAULT;
  return base.replace(/\/+$/, "") + "/" + token;
}

function timingSafeTokenEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  const sameBytes = crypto.timingSafeEqual(pa, pb) ? 1 : 0;
  const sameLen = a.length === b.length ? 1 : 0;
  return (sameBytes & sameLen) === 1;
}

async function revokePublicTrackingBestEffort(client, taskId, log) {
  let savepoint = false;
  try {
    await client.query("SAVEPOINT public_track_revoke");
    savepoint = true;
  } catch (_) {
    savepoint = false;
  }
  try {
    await client.query(
      `UPDATE public_tracking_tokens
       SET is_revoked = true
       WHERE task_id = $1 AND is_revoked = false`,
      [taskId]
    );
    if (savepoint) await client.query("RELEASE SAVEPOINT public_track_revoke");
  } catch (err) {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT public_track_revoke");
      } catch (_) {
        /* transaction already clean */
      }
    }
    if (log && typeof log.error === "function") {
      log.error({ err: err.message }, "public tracking revoke failed");
    }
  }
}

async function resolvePublicTracking(client, presented) {
  const presentedStr = presented == null ? "" : String(presented);
  const { rows } = await client.query(
    `SELECT token, task_id, is_revoked, expires_at
     FROM public_tracking_tokens
     WHERE token = $1`,
    [presentedStr]
  );
  const row = rows[0] || null;
  const stored =
    row && typeof row.token === "string" ? row.token : PUBLIC_TRACK_DUMMY;
  const match = timingSafeTokenEqual(stored, presentedStr) ? 1 : 0;
  const alive = row && row.is_revoked !== true ? 1 : 0;
  let fresh = 0;
  if (row && row.expires_at == null) {
    fresh = 1;
  } else if (row && row.expires_at != null) {
    const exp = new Date(row.expires_at).getTime();
    fresh = Number.isFinite(exp) && exp > Date.now() ? 1 : 0;
  }
  if ((match & alive & fresh) !== 1) return null;

  const { rows: taskRows } = await client.query(
    `SELECT status FROM tasks WHERE id = $1`,
    [row.task_id]
  );
  if (!taskRows.length) return null;
  const status = String(taskRows[0].status || "").toLowerCase();
  if (PUBLIC_TRACK_CLOSED.has(status)) return null;
  return row.task_id;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function asObject(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value : null;
}

// Same coordinate read as simulate_fleet.js numPair. (0,0) is not a stop:
// it is the null-island point that drew the circles at sea.
function numPair(o) {
  if (!o || typeof o !== "object") return null;
  const lat = Number(o.lat ?? o.latitude);
  const lng = Number(o.lng ?? o.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function resolveRoutePoint(primary, fallback, defaultLabel) {
  const primaryObj = asObject(primary);
  const fallbackObj = asObject(fallback);
  const fromPrimary = numPair(primaryObj);
  const source = fromPrimary ? primaryObj : fallbackObj;
  const pair = fromPrimary || numPair(fallbackObj);
  if (!pair) return null;
  const rawLabel = source && (source.label || source.address || source.name);
  const label =
    rawLabel != null && String(rawLabel).trim()
      ? String(rawLabel)
      : defaultLabel || null;
  return { lat: pair.lat, lng: pair.lng, label };
}

// Single-instance bounded. Core prod is one Node process in one container,
// so these Maps are the route lock and the 60s ETA cache.
const ROUTE_INFLIGHT = new Map();
const ROUTE_FAIL_LOGGED = new Set();
const ROUTE_FAIL_UNTIL = new Map();
const ETA_CACHE = new Map();
const ETA_INFLIGHT = new Map();
const ETA_FAIL_LOGGED = new Set();
const ETA_TTL_MS = 60 * 1000;
const ETA_STALE_MS = 10 * 60 * 1000;
const ETA_PROXIMITY_M = 50;
const ROUTE_FAIL_BACKOFF_MS = 60 * 1000;

let fallbackProvider = null;

function trackProvider(fastify) {
  if (fastify && fastify.routingProvider) return fastify.routingProvider;
  if (!fallbackProvider) fallbackProvider = createProvider();
  return fallbackProvider;
}

function publicRouteCache(routeJson) {
  const nested = routeJson && routeJson.public_route;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  return nested;
}

function cachedGeometry(routeJson) {
  const geometry = publicRouteCache(routeJson) && publicRouteCache(routeJson).geometry;
  if (!Array.isArray(geometry) || geometry.length < 2) return null;
  return geometry;
}

function logOnce(seen, key, logger, level, message, extra) {
  const id = String(key);
  if (seen.has(id)) return;
  seen.add(id);
  if (logger && typeof logger[level] === "function") {
    logger[level](extra || {}, message);
  }
}

function herePoint(point) {
  return { lat: point.lat, lon: point.lng };
}

async function ensureRoadGeometry(client, taskId, route, routeJson, provider, logger) {
  const existing = cachedGeometry(routeJson);
  if (existing) return existing;
  if (!route.origin || !route.destination) return null;

  const key = String(taskId);
  const blockedUntil = ROUTE_FAIL_UNTIL.get(key);
  if (blockedUntil && blockedUntil > Date.now()) return null;

  let job = ROUTE_INFLIGHT.get(key);
  if (!job) {
    job = computeAndStoreRoute(client, taskId, route, provider, logger);
    ROUTE_INFLIGHT.set(key, job);
  }
  try {
    return await job;
  } finally {
    if (ROUTE_INFLIGHT.get(key) === job) ROUTE_INFLIGHT.delete(key);
  }
}

async function computeAndStoreRoute(client, taskId, route, provider, logger) {
  const key = String(taskId);
  try {
    const { rows } = await client.query(
      `SELECT route_json FROM tasks WHERE id = $1`,
      [taskId]
    );
    const again = cachedGeometry(asObject(rows[0] && rows[0].route_json));
    if (again) return again;
  } catch (err) {
    logOnce(
      ROUTE_FAIL_LOGGED,
      "read:" + key,
      logger,
      "warn",
      "public track route cache read failed",
      { code: "READ" }
    );
    return null;
  }

  let result;
  try {
    result = await provider.computeRoute({
      origin: herePoint(route.origin),
      destination: herePoint(route.destination),
      transportMode: "truck",
    });
  } catch (err) {
    ROUTE_FAIL_UNTIL.set(key, Date.now() + ROUTE_FAIL_BACKOFF_MS);
    logOnce(
      ROUTE_FAIL_LOGGED,
      key,
      logger,
      "warn",
      "public track HERE route unavailable",
      { code: err && err.code ? err.code : "HERE" }
    );
    return null;
  }

  const geometry = Array.isArray(result && result.geometry) ? result.geometry : null;
  if (!geometry || geometry.length < 2) {
    ROUTE_FAIL_UNTIL.set(key, Date.now() + ROUTE_FAIL_BACKOFF_MS);
    logOnce(
      ROUTE_FAIL_LOGGED,
      key,
      logger,
      "warn",
      "public track HERE route unavailable",
      { code: "NO_GEOMETRY" }
    );
    return null;
  }

  const patch = {
    public_route: {
      origin: route.origin,
      destination: route.destination,
      geometry,
      distance_m: Number.isFinite(result.distanceM) ? result.distanceM : null,
      duration_s: Number.isFinite(result.durationSec) ? result.durationSec : null,
      provider: "here",
      computed_at: new Date().toISOString(),
    },
  };

  try {
    await client.query(
      `UPDATE tasks
          SET route_json = COALESCE(route_json::jsonb, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND (
            route_json IS NULL
            OR (route_json::jsonb)->'public_route' IS NULL
            OR jsonb_typeof(((route_json::jsonb)->'public_route')->'geometry') IS DISTINCT FROM 'array'
          )`,
      [taskId, JSON.stringify(patch)]
    );
  } catch (err) {
    logOnce(
      ROUTE_FAIL_LOGGED,
      "persist:" + key,
      logger,
      "warn",
      "public track route cache write failed",
      { code: "PERSIST" }
    );
  }

  if (logger && typeof logger.info === "function") {
    logger.info({ taskId: key }, "public track HERE route computed");
  }
  return geometry;
}

function locationIsStale(lastLocation) {
  const parsed = Date.parse(lastLocation && lastLocation.time);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed > ETA_STALE_MS;
}

function withStale(eta, lastLocation) {
  if (!eta) return null;
  if (!locationIsStale(lastLocation)) return eta;
  return Object.assign({}, eta, { stale: true });
}

async function etaForTask(taskId, lastLocation, destination, provider, logger) {
  const lat = Number(lastLocation.latitude);
  const lng = Number(lastLocation.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!destination) return null;

  const distM =
    haversineDistanceKm(lat, lng, destination.lat, destination.lng) * 1000;
  if (distM <= ETA_PROXIMITY_M) {
    return withStale(
      {
        minutes: 0,
        arrival_at: new Date().toISOString(),
        source: "proximity",
      },
      lastLocation
    );
  }

  const key = String(taskId);
  const hit = ETA_CACHE.get(key);
  if (hit && hit.expires > Date.now()) return withStale(hit.value, lastLocation);

  let job = ETA_INFLIGHT.get(key);
  if (!job) {
    job = computeEta(key, lat, lng, destination, provider, logger);
    ETA_INFLIGHT.set(key, job);
  }
  try {
    return withStale(await job, lastLocation);
  } finally {
    if (ETA_INFLIGHT.get(key) === job) ETA_INFLIGHT.delete(key);
  }
}

async function computeEta(key, lat, lng, destination, provider, logger) {
  try {
    const result = await provider.computeRoute({
      origin: { lat, lon: lng },
      destination: herePoint(destination),
      transportMode: "truck",
    });
    const durationSec = Number(result && result.durationSec);
    if (!Number.isFinite(durationSec)) return null;
    const eta = {
      minutes: Math.max(0, Math.round(durationSec / 60)),
      arrival_at: new Date(Date.now() + durationSec * 1000).toISOString(),
      source: "here",
    };
    ETA_CACHE.set(key, { expires: Date.now() + ETA_TTL_MS, value: eta });
    return eta;
  } catch (err) {
    logOnce(
      ETA_FAIL_LOGGED,
      key,
      logger,
      "warn",
      "public track HERE eta unavailable",
      { code: err && err.code ? err.code : "HERE" }
    );
    return null;
  }
}

// ============================================
// PUBLIC TRACKING — JSON Data (Auth gerektirmez)
// ============================================
async function publicTrackJson(fastify, request, reply) {
  const { token } = request.params;
  const client = await fastify.pg.connect();

  try {
    const taskId = await resolvePublicTracking(client, token);
    if (!taskId) return reply.code(404).send(PUBLIC_TRACK_JSON_404);

    // Task bilgisi
    const { rows: taskRows } = await client.query(
      `SELECT t.task_no, t.status, t.title, t.start_location, t.end_location,
              t.waypoints, t.actual_start, t.actual_end, t.route_json,
              d.pickup_location, d.dropoff_location,
              v.plate_no as vehicle_plate
       FROM tasks t
       LEFT JOIN vehicles v ON t.vehicle_id = v.id
       LEFT JOIN enterprise.dispatch_tasks d ON d.id = t.enterprise_dispatch_task_id
       WHERE t.id = $1`,
      [taskId]
    );
    if (!taskRows.length)
      return reply.code(404).send(PUBLIC_TRACK_JSON_404);

    const task = taskRows[0];
    const live = PUBLIC_TRACK_LIVE.has(String(task.status || ""));

    // Events — public fields only (no event id, no stop id)
    const { rows: events } = await client.query(
      `SELECT type, message, created_at
       FROM task_events WHERE task_id = $1
       ORDER BY created_at ASC LIMIT 200`,
      [String(taskId)]
    );

    // Son konum yalnız araç yoldayken (PUBLIC_TRACK_LIVE).
    let lastLocation = null;
    let vRows = [];
    if (live) {
      const { rows } = await client.query(
        `SELECT v.esp32_device_id FROM vehicles v
         JOIN tasks t ON t.vehicle_id = v.id
         WHERE t.id = $1`,
        [taskId]
      );
      vRows = rows;
      if (vRows.length && vRows[0].esp32_device_id) {
        const { rows: locRows } = await client.query(
          `SELECT latitude, longitude, speed, heading, time
           FROM locations WHERE device_id = $1
           ORDER BY time DESC LIMIT 1`,
          [vRows[0].esp32_device_id]
        );
        if (locRows.length) lastLocation = locRows[0];
      }
    }

    const routeJson = asObject(task.route_json) || {};
    const route = {
      origin: resolveRoutePoint(
        routeJson.origin,
        task.pickup_location,
        task.start_location || null
      ),
      destination: resolveRoutePoint(
        routeJson.destination,
        task.dropoff_location,
        task.end_location || null
      ),
    };

    // Waypoints parse
    let waypoints = task.waypoints || [];
    if (typeof waypoints === "string") {
      try {
        waypoints = JSON.parse(waypoints);
      } catch {
        waypoints = [];
      }
    }

    const provider = trackProvider(fastify);
    let geometry = cachedGeometry(routeJson);
    if (!geometry && route.origin && route.destination) {
      geometry = await ensureRoadGeometry(
        client,
        taskId,
        route,
        routeJson,
        provider,
        request.log
      );
    }
    route.geometry = geometry;

    let eta = null;
    if (live && lastLocation && route.destination) {
      eta = await etaForTask(
        taskId,
        lastLocation,
        route.destination,
        provider,
        request.log
      );
    }

    return reply.send(
      stripInternalIds({
        task: {
          task_no: task.task_no,
          status: task.status,
          title: task.title,
          start_location: task.start_location,
          end_location: task.end_location,
          vehicle_plate: task.vehicle_plate,
          actual_start: task.actual_start,
          actual_end: task.actual_end,
        },
        waypoints,
        events,
        route,
        last_location: live ? lastLocation : null,
        eta: live ? eta : null,
        updated_at: new Date().toISOString(),
      })
    );
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  } finally {
    client.release();
  }
}

// ============================================
// PUBLIC TRACKING — HTML Page (Leaflet Map + i18n)
// ============================================
const PUBLIC_TRACK_I18N = {
  tr: {
    loading: "Yükleniyor...",
    invalidLink: "Link geçersiz veya süresi dolmuş",
    contactCompany: "Lütfen şirketinizle iletişime geçin.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Görev Bilgisi',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Duraklar',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> İlerleme',
    taskNo: "Görev No",
    vehicle: "Araç",
    route: "Güzergah",
    status: "Durum",
    noStops: "Durak yok",
    noProgress: "Henüz ilerleme yok",
    lastUpdate: "Son güncelleme",
    connError: "Bağlantı hatası",
    invalidLinkShort: "Link geçersiz",
    vehicleLocation: "Araç Konumu",
    serverError: "Sunucu hatası",
    pending: "Bekliyor",
    arrived: "Vardı",
    departed: "Ayrıldı",
    completed: "Tamamlandı",
    in_progress: "Devam Ediyor",
    accepted: "Kabul Edildi",
    pending_review: "İnceleniyor",
    TASK_COMPLETED: "Görev Tamamlandı",
    TASK_STARTED: "Görev Başladı",
    TASK_ACCEPTED: "Görev Kabul Edildi",
    TASK_REJECTED: "Görev Reddedildi",
    TASK_WITHDRAWN: "Görev Çekildi",
    STOP_ARRIVED: "Durağa Varış",
    STOP_DEPARTED: "Duraktan Ayrılış",
    WAYPOINT_COMPLETED: "Durak Tamamlandı",
    nextStop: "Sonraki Durak",
    distance: "Mesafe",
    min: "dk",
    noSpeed: "Hareket bekleniyor",
    delayRisk: "GECİKME RİSKİ",
    noEta: "ETA hesaplanamıyor",
    etaStale: "eski konum",
    liveNote: "Araç yola çıktığında canlı konum burada görünecek",
  },
  en: {
    loading: "Loading...",
    invalidLink: "Invalid or expired link",
    contactCompany: "Please contact your company.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Task Info',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Stops',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Progress',
    taskNo: "Task No",
    vehicle: "Vehicle",
    route: "Route",
    status: "Status",
    noStops: "No stops",
    noProgress: "No progress yet",
    lastUpdate: "Last update",
    connError: "Connection error",
    invalidLinkShort: "Invalid link",
    vehicleLocation: "Vehicle Location",
    serverError: "Server error",
    pending: "Pending",
    arrived: "Arrived",
    departed: "Departed",
    completed: "Completed",
    in_progress: "In Progress",
    accepted: "Accepted",
    pending_review: "Pending Review",
    TASK_COMPLETED: "Task Completed",
    TASK_STARTED: "Task Started",
    TASK_ACCEPTED: "Task Accepted",
    TASK_REJECTED: "Task Rejected",
    TASK_WITHDRAWN: "Task Withdrawn",
    STOP_ARRIVED: "Stop Arrived",
    STOP_DEPARTED: "Stop Departed",
    WAYPOINT_COMPLETED: "Stop Completed",
    nextStop: "Next Stop",
    distance: "Distance",
    min: "min",
    noSpeed: "Waiting for movement",
    delayRisk: "DELAY RISK",
    noEta: "ETA unavailable",
    etaStale: "stale location",
    liveNote: "Live location appears here once the vehicle is on the way",
  },
  ku: {
    loading: "Tê barkirin...",
    invalidLink: "Lînk nederbasdar e an dema wê derbas bûye",
    contactCompany: "Ji kerema xwe bi pargîdaniya xwe re têkilî daynin.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Agahiyên Peywirê',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Rawestgeh',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Pêşveçûn',
    taskNo: "Hejmara Peywirê",
    vehicle: "Wesayît",
    route: "Rê",
    status: "Rewş",
    noStops: "Rawestgeh tune",
    noProgress: "Hêj pêşveçûn tune",
    lastUpdate: "Nûvekirina dawîn",
    connError: "Xeletiya girêdanê",
    invalidLinkShort: "Lînk nederbasdar e",
    vehicleLocation: "Cihê Wesayîtê",
    serverError: "Xeletiya serverê",
    pending: "Li bendê",
    arrived: "Gihîşt",
    departed: "Derket",
    completed: "Qediya",
    in_progress: "Derdikeve",
    accepted: "Hat pejirandin",
    pending_review: "Tê vekolîn",
    TASK_COMPLETED: "Peywir qediya",
    TASK_STARTED: "Peywir dest pê kir",
    TASK_ACCEPTED: "Peywir hat pejirandin",
    TASK_REJECTED: "Peywir hat redkirin",
    TASK_WITHDRAWN: "Peywir hat paşxistin",
    STOP_ARRIVED: "Gihîşte rawestgehê",
    STOP_DEPARTED: "Ji rawestgehê derket",
    WAYPOINT_COMPLETED: "Rawestgeh qediya",
    nextStop: "Rawestgeha Pêş",
    distance: "Dûrahî",
    min: "deq",
    noSpeed: "Li benda tevgerê",
    delayRisk: "RÎSKA DERENGÎ",
    noEta: "ETA ne peyda ye",
    etaStale: "cihê kevn",
    liveNote: "Dem araç derket kir, cihê zindî li vir xuya dibe",
  },
  nl: {
    loading: "Laden...",
    invalidLink: "Ongeldige of verlopen link",
    contactCompany: "Neem contact op met uw bedrijf.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Taakinformatie',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Haltes',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Voortgang',
    taskNo: "Taaknr",
    vehicle: "Voertuig",
    route: "Route",
    status: "Status",
    noStops: "Geen haltes",
    noProgress: "Nog geen voortgang",
    lastUpdate: "Laatste update",
    connError: "Verbindingsfout",
    invalidLinkShort: "Ongeldige link",
    vehicleLocation: "Voertuiglocatie",
    serverError: "Serverfout",
    pending: "Wachtend",
    arrived: "Aangekomen",
    departed: "Vertrokken",
    completed: "Voltooid",
    in_progress: "Bezig",
    accepted: "Geaccepteerd",
    pending_review: "In behandeling",
    TASK_COMPLETED: "Taak voltooid",
    TASK_STARTED: "Taak gestart",
    TASK_ACCEPTED: "Taak geaccepteerd",
    TASK_REJECTED: "Taak geweigerd",
    TASK_WITHDRAWN: "Taak ingetrokken",
    STOP_ARRIVED: "Halte bereikt",
    STOP_DEPARTED: "Halte verlaten",
    WAYPOINT_COMPLETED: "Halte voltooid",
    nextStop: "Volgende halte",
    distance: "Afstand",
    min: "min",
    noSpeed: "Wachten op beweging",
    delayRisk: "VERTRAGINGSRISICO",
    noEta: "ETA niet beschikbaar",
    etaStale: "verouderde locatie",
    liveNote: "De live locatie verschijnt hier zodra het voertuig onderweg is",
  },
  bg: {
    loading: "Зареждане...",
    invalidLink: "Невалиден или изтекъл линк",
    contactCompany: "Моля, свържете се с вашата компания.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Информация за задачата',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Спирки',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Напредък',
    taskNo: "Задача №",
    vehicle: "Превозно средство",
    route: "Маршрут",
    status: "Статус",
    noStops: "Няма спирки",
    noProgress: "Все още няма напредък",
    lastUpdate: "Последна актуализация",
    connError: "Грешка при свързване",
    invalidLinkShort: "Невалиден линк",
    vehicleLocation: "Местоположение",
    serverError: "Сървърна грешка",
    pending: "Изчакване",
    arrived: "Пристигнал",
    departed: "Заминал",
    completed: "Завършен",
    in_progress: "В ход",
    accepted: "Приет",
    pending_review: "В преглед",
    TASK_COMPLETED: "Задача завършена",
    TASK_STARTED: "Задача стартирана",
    TASK_ACCEPTED: "Задача приета",
    TASK_REJECTED: "Задача отхвърлена",
    TASK_WITHDRAWN: "Задача оттеглена",
    STOP_ARRIVED: "Пристигане на спирка",
    STOP_DEPARTED: "Заминаване от спирка",
    WAYPOINT_COMPLETED: "Спирка завършена",
    nextStop: "Следваща спирка",
    distance: "Разстояние",
    min: "мин",
    noSpeed: "Изчакване на движение",
    delayRisk: "РИСК ОТ ЗАКЪСНЕНИЕ",
    noEta: "ETA не е наличен",
    etaStale: "остаряло местоположение",
    liveNote: "Местоположението на живо се показва тук, когато автомобилът потегли",
  },
  it: {
    loading: "Caricamento...",
    invalidLink: "Link non valido o scaduto",
    contactCompany: "Contatta la tua azienda.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Info Attività',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Fermate',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Progresso',
    taskNo: "N. Attività",
    vehicle: "Veicolo",
    route: "Percorso",
    status: "Stato",
    noStops: "Nessuna fermata",
    noProgress: "Nessun progresso",
    lastUpdate: "Ultimo aggiornamento",
    connError: "Errore di connessione",
    invalidLinkShort: "Link non valido",
    vehicleLocation: "Posizione veicolo",
    serverError: "Errore del server",
    pending: "In attesa",
    arrived: "Arrivato",
    departed: "Partito",
    completed: "Completato",
    in_progress: "In corso",
    accepted: "Accettato",
    pending_review: "In revisione",
    TASK_COMPLETED: "Attività completata",
    TASK_STARTED: "Attività avviata",
    TASK_ACCEPTED: "Attività accettata",
    TASK_REJECTED: "Attività rifiutata",
    TASK_WITHDRAWN: "Attività ritirata",
    STOP_ARRIVED: "Arrivo alla fermata",
    STOP_DEPARTED: "Partenza dalla fermata",
    WAYPOINT_COMPLETED: "Fermata completata",
    nextStop: "Prossima fermata",
    distance: "Distanza",
    min: "min",
    noSpeed: "In attesa di movimento",
    delayRisk: "RISCHIO RITARDO",
    noEta: "ETA non disponibile",
    etaStale: "posizione non aggiornata",
    liveNote: "La posizione live compare qui quando il veicolo è in viaggio",
  },
  es: {
    loading: "Cargando...",
    invalidLink: "Enlace inválido o expirado",
    contactCompany: "Contacte con su empresa.",
    taskInfo:
      '<ion-icon name="clipboard-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Info de Tarea',
    stops:
      '<ion-icon name="location-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Paradas',
    progress:
      '<ion-icon name="stats-chart-outline" style="vertical-align:middle;margin-right:4px;color:#5E72E4;"></ion-icon> Progreso',
    taskNo: "N° Tarea",
    vehicle: "Vehículo",
    route: "Ruta",
    status: "Estado",
    noStops: "Sin paradas",
    noProgress: "Sin progreso aún",
    lastUpdate: "Última actualización",
    connError: "Error de conexión",
    invalidLinkShort: "Enlace inválido",
    vehicleLocation: "Ubicación del vehículo",
    serverError: "Error del servidor",
    pending: "Pendiente",
    arrived: "Llegó",
    departed: "Partió",
    completed: "Completado",
    in_progress: "En curso",
    accepted: "Aceptado",
    pending_review: "En revisión",
    TASK_COMPLETED: "Tarea completada",
    TASK_STARTED: "Tarea iniciada",
    TASK_ACCEPTED: "Tarea aceptada",
    TASK_REJECTED: "Tarea rechazada",
    TASK_WITHDRAWN: "Tarea retirada",
    STOP_ARRIVED: "Llegada a parada",
    STOP_DEPARTED: "Salida de parada",
    WAYPOINT_COMPLETED: "Parada completada",
    nextStop: "Próxima parada",
    distance: "Distancia",
    min: "min",
    noSpeed: "Esperando movimiento",
    delayRisk: "RIESGO DE RETRASO",
    noEta: "ETA no disponible",
    etaStale: "ubicación antigua",
    liveNote: "La ubicación en vivo aparece aquí cuando el vehículo está en camino",
  },
};

async function publicTrackHtml(fastify, request, reply) {
  const { token } = request.params;
  const lang = PUBLIC_TRACK_I18N[request.query.lang]
    ? request.query.lang
    : "tr";
  const t = PUBLIC_TRACK_I18N[lang];
  const locale =
    {
      tr: "tr-TR",
      en: "en-US",
      ku: "ku",
      nl: "nl-NL",
      bg: "bg-BG",
      it: "it-IT",
      es: "es-ES",
    }[lang] || "tr-TR";
  const client = await fastify.pg.connect();

  try {
    const taskId = await resolvePublicTracking(client, token);
    if (!taskId || !/^[A-Za-z0-9_-]+$/.test(String(token))) {
      reply.type("text/html; charset=utf-8").code(404);
      return publicHtmlShell(
        lang,
        "TulipFleet — " + t.invalidLinkShort,
        "<h1>" + escapeHtml(t.invalidLink) + "</h1><p>" + escapeHtml(t.contactCompany) + "</p>"
      );
    }

    const { rows: taskRows } = await client.query(
      "SELECT task_no, title FROM tasks WHERE id = $1",
      [taskId]
    );
    const taskNo = taskRows[0]?.task_no || "";
    const pageTitle = "TulipFleet — " + taskNo;

    const routeUrl =
      (request.routeOptions && request.routeOptions.url) ||
      request.routerPath ||
      "";
    const jsonPath = String(routeUrl).startsWith("/v/")
      ? "/v/" + token + ".json"
      : "/public/track/" + token + ".json";
    reply.type("text/html; charset=utf-8");
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Segoe UI',Arial,sans-serif; background:#f5f7fa; color:#333; }
    .header { background:linear-gradient(135deg,#5E72E4,#825EE4); color:#fff; padding:16px 24px; display:flex; align-items:center; gap:12px; }
    .header h1 { font-size:18px; font-weight:600; }
    .header .badge { background:rgba(255,255,255,0.2); padding:4px 12px; border-radius:20px; font-size:12px; }
    .lang-select { margin-left:auto; background:rgba(255,255,255,0.2); border:none; color:#fff; padding:4px 8px; border-radius:8px; font-size:12px; cursor:pointer; }
    .lang-select option { color:#333; }
    .content { display:grid; grid-template-columns:1fr 350px; height:calc(100vh - 56px); }
    #map { width:100%; height:100%; }
    .sidebar { overflow-y:auto; padding:16px; background:#fff; border-left:1px solid #e9ecef; }
    .card { background:#f8f9fe; border-radius:12px; padding:16px; margin-bottom:12px; }
    .card-title { font-size:14px; font-weight:700; color:#5E72E4; margin-bottom:10px; }
    .info-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #f0f0f0; }
    .info-label { color:#8898AA; font-size:13px; }
    .info-value { font-weight:600; font-size:13px; }
    .wp-item { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #f0f0f0; }
    .wp-dot { width:12px; height:12px; border-radius:50%; }
    .wp-dot.pending { background:#FB6340; }
    .wp-dot.arrived { background:#11CDEF; }
    .wp-dot.departed { background:#FFD600; }
    .wp-dot.completed { background:#2DCE89; }
    .wp-name { font-size:13px; font-weight:500; }
    .wp-status { font-size:11px; color:#8898AA; margin-left:auto; }
    .ev-item { padding:8px 0; border-bottom:1px solid #f0f0f0; display:flex; gap:8px; align-items:flex-start; }
    .ev-dot { width:8px; height:8px; border-radius:50%; background:#5E72E4; margin-top:5px; flex-shrink:0; }
    .ev-type { font-size:12px; font-weight:600; }
    .ev-time { font-size:11px; color:#8898AA; }
    .update-bar { text-align:center; padding:8px; font-size:11px; color:#8898AA; background:#f8f9fe; }
    .status-badge { display:inline-block; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600; }
    .status-in_progress { background:#E8DAFF; color:#825EE4; }
    .status-completed { background:#D4EDDA; color:#2DCE89; }
    .status-accepted { background:#D1ECF1; color:#11CDEF; }
    .status-pending_review { background:#FFF3CD; color:#FB6340; }
    @media(max-width:768px) {
      .content { grid-template-columns:1fr; grid-template-rows:50vh 1fr; }
      .sidebar { border-left:none; border-top:1px solid #e9ecef; }
    }
  </style>
</head>
<body>
  <div class="header">
    <ion-icon name="bus" style="font-size:22px;"></ion-icon>
    <h1>${escapeHtml(pageTitle)}</h1>
    <span class="badge" id="statusBadge">${t.loading}</span>
    <select class="lang-select" onchange="location.href='?lang='+this.value">
      <option value="tr" ${lang === "tr" ? "selected" : ""}>🇹🇷 TR</option>
      <option value="en" ${lang === "en" ? "selected" : ""}>🇬🇧 EN</option>
      <option value="ku" ${lang === "ku" ? "selected" : ""}>KU</option>
      <option value="nl" ${lang === "nl" ? "selected" : ""}>🇳🇱 NL</option>
      <option value="bg" ${lang === "bg" ? "selected" : ""}>🇧🇬 BG</option>
      <option value="it" ${lang === "it" ? "selected" : ""}>🇮🇹 IT</option>
      <option value="es" ${lang === "es" ? "selected" : ""}>🇪🇸 ES</option>
    </select>
  </div>
  <div class="content">
    <div id="map"></div>
    <div class="sidebar">
      <div class="card" id="liveNote" hidden></div>
      <div class="card">
        <div class="card-title"><ion-icon name="timer-outline" style="vertical-align:middle;margin-right:6px;color:#5E72E4;"></ion-icon> ETA</div>
        <div id="etaInfo">-</div>
      </div>   
      <div class="card">
        <div class="card-title">${t.taskInfo}</div>
        <div id="taskInfo">${t.loading}</div>
      </div>
      <div class="card">
        <div class="card-title">${t.stops}</div>
        <div id="waypointsList">${t.loading}</div>
      </div>
      <div class="card">
        <div class="card-title">${t.progress}</div>
        <div id="eventsList">${t.loading}</div>
      </div>
      <div class="update-bar" id="updateBar">—</div>
    </div>
  </div>

  <script>
    const TOKEN = '${token}';
    const JSON_PATH = '${jsonPath}';
    const T = ${JSON.stringify(t)};
    const STATUS_TR = ${JSON.stringify(PUBLIC_TRACK_STATUS_TR)};
    const LIVE_STATUS = ${JSON.stringify({ in_progress: true })};
    const LOCALE = '${locale}';
    const map = L.map('map').setView([39.9, 32.8], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:'&copy; OpenStreetMap',
      referrerPolicy: 'strict-origin'
    }).addTo(map);

    let vehicleMarker = null;
    let wpMarkers = [];
    let firstLoad = true;

    function statusColor(s) {
      const m = {pending:'#FB6340',arrived:'#11CDEF',departed:'#FFD600',completed:'#2DCE89'};
      return m[s] || '#8898AA';
    }

    function tr(key) { return T[key] || key; }

    async function fetchData() {
      try {
        const r = await fetch(JSON_PATH);
        if (!r.ok) { document.getElementById('updateBar').textContent = tr('invalidLinkShort'); return; }
        const d = await r.json();
        renderTask(d.task);
        renderWaypoints(d.waypoints, d.route);
        renderEvents(d.events);
        renderETA(d.eta);
        renderLocation(d.last_location, d.waypoints, d.task && d.task.status, d.route);
        document.getElementById('updateBar').textContent = tr('lastUpdate') + ': ' + new Date().toLocaleString(LOCALE);
      } catch(e) {
        document.getElementById('updateBar').textContent = tr('connError');
      }
    }

    function statusLabel(s) { return STATUS_TR[s] || s; }

    function renderTask(task) {
      var s = task.status;
      document.getElementById('statusBadge').textContent = statusLabel(s);
      document.getElementById('statusBadge').className = 'badge status-' + s;
      document.getElementById('taskInfo').innerHTML =
        '<div class="info-row"><span class="info-label">' + tr('taskNo') + '</span><span class="info-value">' + (task.task_no||'-') + '</span></div>' +
        '<div class="info-row"><span class="info-label">' + tr('vehicle') + '</span><span class="info-value">' + (task.vehicle_plate||'-') + '</span></div>' +
        '<div class="info-row"><span class="info-label">' + tr('route') + '</span><span class="info-value">' + (task.start_location||'') + ' → ' + (task.end_location||'') + '</span></div>' +
        '<div class="info-row"><span class="info-label">' + tr('status') + '</span><span class="info-value"><span class="status-badge status-' + s + '">' + statusLabel(s) + '</span></span></div>';
    }

    function renderWaypoints(wps, route) {
      var rows = [];
      if (route && route.origin) rows.push({ name: route.origin.label, status: 'pending' });
      if (route && route.destination) rows.push({ name: route.destination.label, status: 'pending' });
      (wps || []).forEach(function(wp) {
        rows.push({ name: wp.name || wp.label, status: wp.status || 'pending' });
      });
      if (!rows.length) { document.getElementById('waypointsList').textContent = tr('noStops'); return; }
      document.getElementById('waypointsList').innerHTML = rows.map(function(wp) {
        var s = wp.status || 'pending';
        return '<div class="wp-item"><div class="wp-dot ' + s + '"></div><span class="wp-name">' + (wp.name||'-') + '</span><span class="wp-status">' + (tr(s)||s) + '</span></div>';
      }).join('');
    }

    function renderEvents(evs) {
      if (!evs || !evs.length) { document.getElementById('eventsList').textContent = tr('noProgress'); return; }
      document.getElementById('eventsList').innerHTML = evs.slice(-20).reverse().map(function(ev) {
        return '<div class="ev-item"><div class="ev-dot"></div><div><div class="ev-type">' + (tr(ev.type)||ev.type.replace(/_/g,' ')) + '</div><div class="ev-time">' + new Date(ev.created_at).toLocaleString(LOCALE) + '</div></div></div>';
      }).join('');
    }

    function renderETA(eta) {
      var el = document.getElementById('etaInfo');
      if (!eta || eta.minutes == null || !eta.arrival_at) { el.textContent = tr('noEta'); return; }
      var when = new Date(eta.arrival_at);
      if (isNaN(when.getTime())) { el.textContent = tr('noEta'); return; }
      var hh = String(when.getHours()).padStart(2, '0');
      var mm = String(when.getMinutes()).padStart(2, '0');
      var text = 'ETA ' + hh + ':' + mm + ' (~' + eta.minutes + ' min)';
      if (eta.stale) text += ' · ' + tr('etaStale');
      el.textContent = text;
    }

    function usablePoint(p) {
      if (!p) return null;
      var lat = Number(p.lat != null ? p.lat : p.latitude);
      var lng = Number(p.lng != null ? p.lng : p.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      if (lat === 0 && lng === 0) return null;
      return [lat, lng];
    }

    function stopIcon(kind) {
      var color = kind === 'origin' ? '#11CDEF' : '#2DCE89';
      var cls = kind === 'origin' ? 'stop-marker stop-origin' : 'stop-marker stop-destination';
      return L.divIcon({
        className: cls,
        html: '<div style="width:16px;height:16px;border-radius:50%;background:' + color + ';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
    }

    function renderLocation(loc, wps, taskStatus, route) {
      var note = document.getElementById('liveNote');
      if (!LIVE_STATUS[taskStatus]) {
        note.hidden = false;
        note.textContent = T.liveNote;
      } else {
        note.hidden = true;
        note.textContent = '';
      }
      wpMarkers.forEach(function(m) { map.removeLayer(m); });
      wpMarkers = [];
      var bounds = [];
      var origin = route ? usablePoint(route.origin) : null;
      var dest = route ? usablePoint(route.destination) : null;
      if (origin) {
        wpMarkers.push(L.marker(origin, { icon: stopIcon('origin') }).addTo(map).bindPopup(route.origin.label || ''));
        bounds.push(origin);
      }
      if (dest) {
        wpMarkers.push(L.marker(dest, { icon: stopIcon('destination') }).addTo(map).bindPopup(route.destination.label || ''));
        bounds.push(dest);
      }
      var line = null;
      if (route && route.geometry && route.geometry.length >= 2) {
        line = [];
        route.geometry.forEach(function(p) {
          if (!p || p.length < 2) return;
          var pt = usablePoint({ lat: p[0], lng: p[1] });
          if (pt) line.push(pt);
        });
        if (line.length < 2) line = null;
      }
      if (line) {
        wpMarkers.push(L.polyline(line, { color: '#5E72E4', weight: 4, opacity: 0.9 }).addTo(map));
        line.forEach(function(pt) { bounds.push(pt); });
      } else if (origin && dest) {
        wpMarkers.push(L.polyline([origin, dest], { color: '#5E72E4', weight: 4, opacity: 0.9 }).addTo(map));
      }
      if (wps && wps.length) {
        wps.forEach(function(wp) {
          var pt = usablePoint(wp);
          if (!pt) return;
          var s = wp.status || 'pending';
          var m = L.circleMarker(pt, {
            radius: 8, fillColor: statusColor(s), color:'#fff', weight:2, fillOpacity:0.9
          }).addTo(map).bindPopup('<b>' + (wp.name||'-') + '</b><br>' + (tr(s)||s));
          wpMarkers.push(m);
          bounds.push(pt);
        });
      }

      var vehiclePt = null;
      if (LIVE_STATUS[taskStatus]) vehiclePt = usablePoint(loc);
      if (vehiclePt) {
        if (vehicleMarker) {
          vehicleMarker.setLatLng(vehiclePt);
        } else {
          vehicleMarker = L.marker(vehiclePt, {
            icon: L.divIcon({
              html:'<ion-icon name="bus" style="font-size:28px;color:#5E72E4;"></ion-icon>',
              iconSize:[32,32], iconAnchor:[16,16], className:'vehicle-marker'
            })
          }).addTo(map).bindPopup(tr('vehicleLocation'));
        }
        bounds.push(vehiclePt);
      } else if (vehicleMarker) {
        map.removeLayer(vehicleMarker);
        vehicleMarker = null;
      }

      if (firstLoad && bounds.length) {
        if (bounds.length === 1) map.setView(bounds[0], 13);
        else map.fitBounds(bounds, { padding: [40, 40] });
        firstLoad = false;
      }
    }

    fetchData();
    setInterval(fetchData, 15000);
  <\/script>
</body>
</html>`;
  } catch (err) {
    request.log.error(err);
    reply.type("text/html; charset=utf-8").code(500);
    return publicHtmlShell(lang, "TulipFleet — " + t.serverError, "<h1>" + escapeHtml(t.serverError) + "</h1>");
  } finally {
    client.release();
  }
}

function publicTrackRateLimitError() {
  const err = new Error("Too many requests");
  err.statusCode = 429;
  return err;
}

const publicReadLimit = {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
    },
  },
};

function publicReferrerPolicy(url) {
  const path = String(url || "").split("?")[0];
  return path.endsWith(".json")
    ? "no-referrer"
    : "strict-origin-when-cross-origin";
}

// Warm the HERE road cache for a task outside the public page.
// Called best-effort by the driver start endpoint so the mobile navigation
// screen and the tracking page read the same route_json.public_route geometry.
// Never throws; returns the geometry or null. Takes its own pool client.
async function warmPublicRoute(fastify, taskId, logger) {
  if (!fastify || !fastify.pg || !taskId) return null;
  let client;
  try {
    client = await fastify.pg.connect();
    const { rows } = await client.query(
      `SELECT t.start_location, t.end_location, t.route_json,
              d.pickup_location, d.dropoff_location
       FROM tasks t
       LEFT JOIN enterprise.dispatch_tasks d ON d.id = t.enterprise_dispatch_task_id
       WHERE t.id = $1`,
      [taskId]
    );
    if (!rows.length) return null;
    const task = rows[0];
    const routeJson = asObject(task.route_json) || {};
    const existing = cachedGeometry(routeJson);
    if (existing) return existing;
    const route = {
      origin: resolveRoutePoint(
        routeJson.origin,
        task.pickup_location,
        task.start_location || null
      ),
      destination: resolveRoutePoint(
        routeJson.destination,
        task.dropoff_location,
        task.end_location || null
      ),
    };
    if (!route.origin || !route.destination) return null;
    return await ensureRoadGeometry(
      client,
      taskId,
      route,
      routeJson,
      trackProvider(fastify),
      logger
    );
  } catch (err) {
    logOnce(
      ROUTE_FAIL_LOGGED,
      "warm:" + String(taskId),
      logger,
      "warn",
      "public route warm failed",
      { code: err && err.code ? err.code : "WARM" }
    );
    return null;
  } finally {
    if (client && typeof client.release === "function") client.release();
  }
}

async function publicTrackRoutes(fastify) {
  fastify.addHook("onRequest", async (request, reply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", publicReferrerPolicy(request.url));
  });
  await fastify.register(rateLimit, {
    global: false,
    max: 60,
    timeWindow: "1 minute",
    errorResponseBuilder: publicTrackRateLimitError,
  });
  const json = (request, reply) => publicTrackJson(fastify, request, reply);
  const html = (request, reply) => publicTrackHtml(fastify, request, reply);
  fastify.get("/public/track/:token.json", publicReadLimit, json);
  fastify.get("/v/:token.json", publicReadLimit, json);
  fastify.get("/public/track/:token", publicReadLimit, html);
  fastify.get("/v/:token", publicReadLimit, html);
}

module.exports = publicTrackRoutes;
module.exports.publicTrackUrl = publicTrackUrl;
module.exports.revokePublicTrackingBestEffort = revokePublicTrackingBestEffort;
module.exports.PUBLIC_TRACK_CLOSED = PUBLIC_TRACK_CLOSED;
module.exports.timingSafeTokenEqual = timingSafeTokenEqual;
module.exports.warmPublicRoute = warmPublicRoute;
