"use strict";

const crypto = require("crypto");
const rateLimit = require("@fastify/rate-limit");

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

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getNextWaypoint(waypoints) {
  if (!Array.isArray(waypoints)) return null;
  return (
    waypoints.find(
      (wp) => String(wp?.status || "").toLowerCase() !== "completed"
    ) || null
  );
}

async function getRecentAvgSpeedKmh(client, deviceId) {
  if (!deviceId) return 0;
  const { rows } = await client.query(
    `SELECT AVG(COALESCE(speed,0))::float AS avg_speed
     FROM locations
     WHERE device_id = $1 AND time > NOW() - INTERVAL '5 minutes'`,
    [deviceId]
  );
  const avg = Number(rows?.[0]?.avg_speed ?? 0);
  if (!Number.isFinite(avg) || avg < 3) return 0;
  return avg;
}

async function estimateSpeedFromLastTwoPointsKmh(client, deviceId) {
  if (!deviceId) return 0;
  const { rows } = await client.query(
    `SELECT latitude, longitude, time
     FROM locations
     WHERE device_id = $1
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY time DESC
     LIMIT 2`,
    [deviceId]
  );
  if (rows.length < 2) return 0;
  const p1 = rows[0];
  const p2 = rows[1];
  const t1 = Date.parse(p1.time);
  const t2 = Date.parse(p2.time);
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 <= t2) return 0;
  const dtSeconds = (t1 - t2) / 1000;
  if (dtSeconds < 5 || dtSeconds > 600) return 0;
  const lat1 = Number(p1.latitude),
    lon1 = Number(p1.longitude);
  const lat2 = Number(p2.latitude),
    lon2 = Number(p2.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const distKm = haversineDistanceKm(lat1, lon1, lat2, lon2);
  if (distKm < 0.03) return 0;
  const speedKmh = (distKm / dtSeconds) * 3600;
  if (!Number.isFinite(speedKmh) || speedKmh < 3) return 0;
  if (speedKmh > 160) return 160;
  return speedKmh;
}

async function hasRecentStopDelayedEvent(client, taskId, stopId) {
  const { rows } = await client.query(
    `SELECT 1
     FROM task_events
     WHERE task_id = $1 AND stop_id = $2 AND type = 'STOP_DELAYED'
       AND created_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1`,
    [String(taskId), String(stopId)]
  );
  return rows.length > 0;
}

async function insertTaskEventTx(
  client,
  {
    taskId,
    type,
    message = null,
    stopId = null,
    legIndex = null,
    createdByUserId = null,
    createdByRole = null,
  }
) {
  try {
    if (process.env.FEATURE_TASK_EVENTS === "false") return;
    if (!taskId || !type) return;
    const { rows } = await client.query(
      `INSERT INTO task_events
       (task_id, stop_id, leg_index, type, message, created_by_user_id, created_by_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        String(taskId),
        stopId != null ? String(stopId) : null,
        Number.isFinite(legIndex) ? legIndex : null,
        String(type),
        message != null ? String(message) : null,
        createdByUserId != null ? String(createdByUserId) : null,
        createdByRole != null ? String(createdByRole) : null,
      ]
    );
    return rows?.[0]?.id;
  } catch (_) {
    return;
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
              t.waypoints, t.actual_start, t.actual_end,
              v.plate_no as vehicle_plate
       FROM tasks t
       LEFT JOIN vehicles v ON t.vehicle_id = v.id
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

    // Waypoints parse
    let waypoints = task.waypoints || [];
    if (typeof waypoints === "string") {
      try {
        waypoints = JSON.parse(waypoints);
      } catch {
        waypoints = [];
      }
    }

    let eta = null;

    const nextWp = live ? getNextWaypoint(waypoints) : null;

    if (nextWp && lastLocation?.latitude && lastLocation?.longitude) {
      const wpLat = numOrNull(nextWp.latitude ?? nextWp.lat);
      const wpLng = numOrNull(nextWp.longitude ?? nextWp.lng);

      if (wpLat != null && wpLng != null) {
        const vLat = Number(lastLocation.latitude);
        const vLng = Number(lastLocation.longitude);

        const distanceKm = haversineDistanceKm(vLat, vLng, wpLat, wpLng);

        const deviceId = vRows?.[0]?.esp32_device_id || null;
        let speedKmh = await getRecentAvgSpeedKmh(client, deviceId);

        if (!speedKmh) {
          const s = Number(lastLocation.speed ?? 0);
          speedKmh = Number.isFinite(s) ? s : 0;
        }
        if (!speedKmh) {
          speedKmh = await estimateSpeedFromLastTwoPointsKmh(client, deviceId);
        }

        if (speedKmh >= 3) {
          const minutes = Math.max(1, Math.round((distanceKm / speedKmh) * 60));
          const arrivalTimeIso = new Date(
            Date.now() + minutes * 60 * 1000
          ).toISOString();

          const plannedIso =
            nextWp.planned_arrival ||
            nextWp.eta ||
            nextWp.scheduled_time ||
            null;

          let delayed = false;
          const toleranceMin = 10;

          if (plannedIso) {
            const plannedMs = Date.parse(plannedIso);
            if (!Number.isNaN(plannedMs)) {
              delayed =
                Date.now() + minutes * 60 * 1000 >
                plannedMs + toleranceMin * 60 * 1000;
            }
          }

          eta = {
            next_stop_id: nextWp.id,
            next_stop_label: nextWp.label || nextWp.name || null,
            distance_km: Number(distanceKm.toFixed(2)),
            speed_kmh: Number(speedKmh.toFixed(1)),
            minutes,
            arrival_time: arrivalTimeIso,
            planned_time: plannedIso,
            delayed,
          };

          if (delayed && plannedIso) {
            const already = await hasRecentStopDelayedEvent(
              client,
              taskId,
              nextWp.id
            );
            if (!already) {
              await insertTaskEventTx(client, {
                taskId: taskId,
                stopId: nextWp.id,
                type: "STOP_DELAYED",
                message: `Delay risk. ETA=${minutes}min`,
                createdByUserId: null,
                createdByRole: "system",
              });
            }
          }
        } else {
          eta = {
            next_stop_id: nextWp.id,
            next_stop_label: nextWp.label || nextWp.name || null,
            distance_km: Number(distanceKm.toFixed(2)),
            speed_kmh: 0,
            minutes: null,
            arrival_time: null,
            planned_time:
              nextWp.planned_arrival ||
              nextWp.eta ||
              nextWp.scheduled_time ||
              null,
            delayed: false,
            reason: "no_speed",
          };
        }
      }
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
        renderWaypoints(d.waypoints);
        renderEvents(d.events);
        renderETA(d.eta);
        renderLocation(d.last_location, d.waypoints, d.task && d.task.status);
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

    function renderWaypoints(wps) {
      if (!wps || !wps.length) { document.getElementById('waypointsList').textContent = tr('noStops'); return; }
      document.getElementById('waypointsList').innerHTML = wps.map(function(wp) {
        var s = wp.status || 'pending';
        return '<div class="wp-item"><div class="wp-dot ' + s + '"></div><span class="wp-name">' + (wp.name||wp.id||'-') + '</span><span class="wp-status">' + (tr(s)||s) + '</span></div>';
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
      if (!eta || !eta.next_stop_label) { el.innerHTML = tr('noEta'); return; }
      var html = '<div class="info-row"><span class="info-label">' + (tr('nextStop')) + '</span><span class="info-value">' + eta.next_stop_label + '</span></div>';
      html += '<div class="info-row"><span class="info-label">' + (tr('distance')) + '</span><span class="info-value">' + eta.distance_km + ' km</span></div>';
      if (eta.minutes) {
        html += '<div class="info-row"><span class="info-label">ETA</span><span class="info-value">' + eta.minutes + ' ' + (tr('min')) + '</span></div>';
      } else {
        html += '<div class="info-row"><span class="info-label">ETA</span><span class="info-value">' + (eta.reason === 'no_speed' ? (tr('noSpeed')) : '-') + '</span></div>';
      }
      if (eta.delayed) {
        html += '<div style="background:#FDE8E8;color:#E53E3E;padding:8px 12px;border-radius:8px;margin-top:8px;font-weight:600;text-align:center;"><ion-icon name="warning" style="vertical-align:middle;margin-right:4px;"></ion-icon> ' + (tr('delayRisk')) + '</div>';
      }
      el.innerHTML = html;
    }

    function renderLocation(loc, wps, taskStatus) {
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
      if (wps && wps.length) {
        wps.forEach(function(wp) {
          if (wp.latitude && wp.longitude) {
            var s = wp.status || 'pending';
            var m = L.circleMarker([wp.latitude, wp.longitude], {
              radius: 8, fillColor: statusColor(s), color:'#fff', weight:2, fillOpacity:0.9
            }).addTo(map).bindPopup('<b>' + (wp.name||'-') + '</b><br>' + (tr(s)||s));
            wpMarkers.push(m);
          }
        });
      }

      if (loc && loc.latitude && loc.longitude) {
        if (vehicleMarker) {
          vehicleMarker.setLatLng([loc.latitude, loc.longitude]);
        } else {
          vehicleMarker = L.marker([loc.latitude, loc.longitude], {
            icon: L.divIcon({
              html:'<ion-icon name="bus" style="font-size:28px;color:#5E72E4;"></ion-icon>',
              iconSize:[32,32], iconAnchor:[16,16], className:''
            })
          }).addTo(map).bindPopup(tr('vehicleLocation'));
        }
        if (firstLoad) {
          map.setView([loc.latitude, loc.longitude], 10);
          firstLoad = false;
        }
      } else if (firstLoad && wps && wps.length) {
        var bounds = wps.filter(function(w){return w.latitude&&w.longitude;}).map(function(w){return [w.latitude,w.longitude];});
        if (bounds.length) { map.fitBounds(bounds, {padding:[40,40]}); firstLoad = false; }
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
