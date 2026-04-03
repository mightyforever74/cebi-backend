// /opt/fleet/backend/services/geofenceService.js  (v2 — contract v1 uyumlu)
'use strict';

const CONFIG_VERSION_CACHE = new Map(); // chipId → last published version

// ── Helper: MQTT publish — promisify garantisi (Fix 8) ───────
// fastify.mqtt.publishAsync varsa kullan, yoksa callback → Promise dönüştür
function mqttPublish(fastify, topic, payload, opts) {
  if (typeof fastify.mqtt.publishAsync === 'function') {
    return fastify.mqtt.publishAsync(topic, payload, opts);
  }
  // callback tabanlı API → Promise wrapper
  return new Promise((resolve, reject) => {
    fastify.mqtt.publish(topic, payload, opts, (err) => {
      if (err) reject(err);
      else     resolve();
    });
  });
}

// ── Helper: company timezone offset (saat farkı, UTC+N) ──────
// Fix 5: companies tablosunda timezone_offset kolonu varsa kullan
// Yoksa TR default: +3
const TIMEZONE_CACHE = new Map(); // company_id → offsetHours
async function getCompanyTimezoneOffset(client, companyId) {
  if (TIMEZONE_CACHE.has(companyId)) return TIMEZONE_CACHE.get(companyId);
  try {
    const res = await client.query(
      `SELECT timezone_offset FROM companies WHERE id = $1`, [companyId]
    );
    const offset = (res.rows[0]?.timezone_offset) ?? 3; // default UTC+3 (TR)
    TIMEZONE_CACHE.set(companyId, offset);
    return offset;
  } catch {
    return 3; // fallback
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Config payload builder — contract v1 ──────────────────────
async function buildConfigPayload(pgClient, companyId) {
  const { rows } = await pgClient.query(
    `SELECT id, name, fence_type, coordinates, radius,
            alert_on_entry, alert_on_exit, is_active, zone_key,
            category, csrd_tracked, start_hour, end_hour,
            config_version
     FROM geofences
     WHERE company_id = $1 AND is_active = true
     ORDER BY created_at ASC`,
    [companyId]
  );

  const zones = rows.map(z => {
    // zone_key zorunlu — yoksa UUID prefix ile fallback
    const zoneKey = z.zone_key || z.id.substring(0, 8);
    const base = {
      zone_key:      zoneKey,
      name:          z.name,
      type:          z.fence_type || 'circle',
      active:        z.is_active,
      alert_on_entry: z.alert_on_entry,
      alert_on_exit:  z.alert_on_exit,
      csrd_tracked:  z.csrd_tracked || false,
      start_hour:    z.start_hour,   // null = no restriction
      end_hour:      z.end_hour,
    };

    if (z.fence_type === 'circle' || !z.fence_type) {
      const coord = z.coordinates || {};
      base.lat    = parseFloat(coord.lat || coord.latitude  || 0);
      base.lng    = parseFloat(coord.lng || coord.longitude || 0);
      base.radius = parseFloat(z.radius || coord.radius || 200);
    }
    if (z.fence_type === 'polygon') {
      base.coords = z.coordinates;
    }
    return base;
  });

  // Fix 9: config_version — zone row version'u değil, company-level snapshot version
  // Kural: MAX(zone config_version) tüm aktif zone'lardan → snapshot için tutarlı
  // Zone ekleme/güncelleme/silme → ilgili zone.config_version artar → MAX artar → ESP yeniler
  // Zone bazlı version (z.config_version) ile snapshot version (payload.config_version) farklı kavramlar:
  //   - z.config_version: o zone son ne zaman değişti
  //   - payload.config_version: bu snapshot kaç kez değişti (herhangi bir zone dahil)
  // Basit ve çalışan: MAX(zone config_version). Company-level sayaç tablosu daha temiz ama
  // mevcut şemada fazladan tablo gerektiriyor. Şimdilik MAX yeterli.
  const version = rows.reduce((m, r) => Math.max(m, r.config_version || 1), 1);

  return {
    config_version: version,                          // Contract v1 primary field
    generated_at:   new Date().toISOString(),         // ISO8601 UTC
    zones,
  };
}

// ── Config publisher ──────────────────────────────────────────
async function publishConfigToDevice(fastify, chipId, companyId) {
  const client = await fastify.pg.connect();
  try {
    const payload = await buildConfigPayload(client, companyId);
    const topic   = `fleet/device/${chipId}/config`;
    const json    = JSON.stringify(payload);

    await mqttPublish(fastify, topic, json, { qos: 1, retain: true });

    CONFIG_VERSION_CACHE.set(chipId, payload.config_version);
    fastify.log.info(`[GF] Config → ${topic} v${payload.config_version} zones=${payload.zones.length}`);
  } catch (err) {
    fastify.log.error({ err }, '[GF] publishConfigToDevice failed');
  } finally {
    client.release();
  }
}

async function publishConfigToAllDevices(fastify, companyId) {
  const client = await fastify.pg.connect();
  try {
    const { rows } = await client.query(
      `SELECT d.esp_chip_id
       FROM devices d
       JOIN vehicles v ON v.id = d.vehicle_id
       WHERE v.company_id = $1
         AND d.status = 'ACTIVATED'
         AND d.esp_chip_id IS NOT NULL`,
      [companyId]
    );
    for (const row of rows) {
      await publishConfigToDevice(fastify, row.esp_chip_id, companyId);
    }
    fastify.log.info(`[GF] Broadcast to ${rows.length} devices (company ${companyId})`);
  } catch (err) {
    fastify.log.error({ err }, '[GF] Broadcast failed');
  } finally {
    client.release();
  }
}

// ── MQTT Consumer — contract v1 ───────────────────────────────
async function handleGeofenceEvent(fastify, topic, message) {
  const parts  = topic.split('/');
  const chipId = parts[2];     // fleet/device/{chipId}/geofence_event

  let event;
  try { event = JSON.parse(message.toString()); }
  catch (e) { fastify.log.warn(`[GF] Invalid JSON from ${chipId}`); return; }

  // Contract v1: event_type = "geofence_entry" | "geofence_exit"
  const { event_type, zone_key, zone_id, config_version: evtVersion,
          lat, lng, speed, timestamp, fw_version, vehicle_serial } = event;

  // event_type validation — hem "geofence_entry" hem "entry" kabul et (geriye uyum)
  const rawType = (event_type || '').replace('geofence_', ''); // entry | exit
  if (!['entry', 'exit'].includes(rawType)) {
    fastify.log.warn(`[GF] Unknown event_type '${event_type}' from ${chipId}`);
    return;
  }

  // ── Zorunlu alan validasyonu (Contract v1) ──────────────
  if (!zone_key && !zone_id) {
    fastify.log.warn(`[GF] Missing zone_key and zone_id from ${chipId}`);
    return;
  }
  // chip_id kontrolü (zaten üstten geliyor ama explicit)
  if (!chipId) {
    fastify.log.warn('[GF] Missing chip_id in event');
    return;
  }
  // lat/lng: Number.isFinite garantisi (0 geçerli koordinat)
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    fastify.log.warn(`[GF] Invalid coordinates lat=${lat} lng=${lng} from ${chipId}`);
    return;
  }
  // timestamp zorunlu — eksikse Date.now() fallback + WARN
  if (!timestamp) {
    fastify.log.warn(`[GF] Missing timestamp from ${chipId} — using server time`);
    // event objesine ekleme: aşağıdaki eventMs hesabı Date.now() fallback kullanır
  }

  const client = await fastify.pg.connect();
  try {

    // ── 1. Device resolve ────────────────────────────────────
    const devRes = await client.query(
      `SELECT d.id AS device_id, d.vehicle_id,
              v.company_id, v.plate_no
       FROM devices d
       LEFT JOIN vehicles v ON v.id = d.vehicle_id
       WHERE d.esp_chip_id = $1 AND d.status = 'ACTIVATED'
       LIMIT 1`,
      [chipId]
    );
    if (devRes.rows.length === 0) {
      fastify.log.warn(`[GF] Unknown/inactive device: ${chipId}`);
      return;
    }
    const { vehicle_id, company_id, plate_no } = devRes.rows[0];

    // ── 2. Zone resolve — zone_key PRIMARY, zone_id fallback ─
    let zoneRes;
    if (zone_key) {
      zoneRes = await client.query(
        `SELECT * FROM geofences WHERE zone_key = $1 LIMIT 1`, [zone_key]
      );
    }
    // zone_key ile bulunamadıysa zone_id ile dene
    if ((!zoneRes || zoneRes.rows.length === 0) && zone_id) {
      zoneRes = await client.query(
        `SELECT * FROM geofences WHERE id = $1 LIMIT 1`, [zone_id]
      );
    }

    if (!zoneRes || zoneRes.rows.length === 0) {
      fastify.log.warn(`[GF] Zone not found: key=${zone_key} id=${zone_id}`);
      // Config'i yenile — cihazın zone listesi güncel değil
      await publishConfigToDevice(fastify, chipId, company_id);
      return;
    }
    const zone = zoneRes.rows[0];

    // ── 3. Güvenlik kontrolleri ──────────────────────────────
    if (zone.company_id !== company_id) {
      fastify.log.warn(`[GF] Cross-company event: zone=${zone.company_id} device=${company_id}`);
      return;
    }
    if (!zone.is_active) { return; }

    // ── 3b. Scope kontrolü — vehicle-scope zone başka araca tetiklenmemeli
    if (zone.scope_type === 'vehicle' && zone.vehicle_id) {
      if (zone.vehicle_id !== vehicle_id) {
        fastify.log.debug(
          `[GF] Scope mismatch: zone vehicle_id=${zone.vehicle_id} event vehicle_id=${vehicle_id} — skipped`
        );
        return;
      }
    }

    const alertEnabled = rawType === 'entry' ? zone.alert_on_entry : zone.alert_on_exit;
    if (!alertEnabled) { return; }

    // ── 4. Config version check — stale event drop ──────────
    // CONTRACT_STRICT_MODE = false  →  Geçiş süreci: eksik config_version WARN + kabul
    // CONTRACT_STRICT_MODE = true   →  Final contract: eksik/stale → DROP
    // Sunset: sahadaki tüm cihazlar v4.7.0+ firmware olunca true yap
    const CONTRACT_STRICT_MODE = false;

    if (evtVersion === undefined || evtVersion === null) {
      // config_version alanı hiç yok (eski firmware)
      if (CONTRACT_STRICT_MODE) {
        fastify.log.warn(
          `[GF] STRICT: missing config_version from ${chipId} — DROP. ` +
          `Firmware v4.7.0+ gerekli.`
        );
        await publishConfigToDevice(fastify, chipId, company_id);
        return; // DROP
      } else {
        fastify.log.warn(
          `[GF] TRANSITION: missing config_version from ${chipId} — ` +
          `accepted (gecis sureci). Cihazi v4.7.0+ firmware ile guncelle.`
        );
        // Geçiş süreci: işlemeye devam
      }
    } else if (zone.config_version && evtVersion < zone.config_version) {
      // config_version mevcut ama stale
      fastify.log.warn(
        `[GF] STALE EVENT: event v${evtVersion} < db v${zone.config_version} ` +
        `zone="${zone.name}" device=${chipId} — DROP + republish`
      );
      await publishConfigToDevice(fastify, chipId, company_id);
      return; // DROP
    }

    // ── 5. Saat kısıtı ──────────────────────────────────────
    if (zone.start_hour !== null && zone.end_hour !== null) {
      // Fix 5: UTC+3 hardcode yerine company timezone kullan
      // companies tablosunda timezone yoksa UTC+3 (TR) default
      const tzOffset = await getCompanyTimezoneOffset(client, company_id);
      const nowH     = ((new Date().getUTCHours() + tzOffset) % 24 + 24) % 24;
      const inWindow = zone.start_hour <= zone.end_hour
        ? nowH >= zone.start_hour && nowH < zone.end_hour
        : nowH >= zone.start_hour || nowH < zone.end_hour; // gece yarısı geçen
      if (!inWindow) {
        fastify.log.debug(`[GF] Outside time window (${nowH}h not in ${zone.start_hour}-${zone.end_hour})`);
        return;
      }
    }

    // ── 6. Haversine cross-check ─────────────────────────────
    let suspicious = false;
    // Fix 7: lat=0 veya lng=0 geçerli koordinat olabilir — falsy kontrolü yanlış
    // lat/lng yukarıda validate edildi — latNum/lngNum kullan
    if (zone.fence_type !== 'polygon') {
      const coord = zone.coordinates || {};
      const zLat  = parseFloat(coord.lat || 0);
      const zLng  = parseFloat(coord.lng || 0);
      const zRad  = parseFloat(zone.radius || 200);
      const dist  = haversine(latNum, lngNum, zLat, zLng);

      if (rawType === 'entry' && dist > zRad * 2) {
        fastify.log.warn(`[GF] Suspicious entry: dist=${dist.toFixed(0)}m >> r=${zRad}m device=${chipId}`);
        suspicious = true;
        await publishConfigToDevice(fastify, chipId, company_id);
      }
      if (rawType === 'exit' && dist < zRad * 0.5) {
        fastify.log.warn(`[GF] Suspicious exit: dist=${dist.toFixed(0)}m << r=${zRad}m device=${chipId}`);
        suspicious = true;
        await publishConfigToDevice(fastify, chipId, company_id);
      }
    }

    // ── 7. Dedup ─────────────────────────────────────────────
    // Fix 6: Event zamanını kullan — Date.now() değil
    // ISO8601 string → ms. Parse hata verirse Date.now() fallback
    let eventMs;
    try {
      eventMs = timestamp ? new Date(timestamp).getTime() : Date.now();
      if (isNaN(eventMs)) eventMs = Date.now();
    } catch { eventMs = Date.now(); }
    const unixMin  = Math.floor(eventMs / 60000);
    const dedupKey = `${zone.id}:${chipId}:${rawType}:${unixMin}`;

    const dedupCheck = await client.query(
      `SELECT id FROM geofence_violations WHERE dedup_key = $1 LIMIT 1`,
      [dedupKey]
    );
    if (dedupCheck.rows.length > 0) {
      fastify.log.info(`[GF] Dedup hit: ${dedupKey}`);
      return;
    }

    // ── 8. Violation INSERT ──────────────────────────────────
    await client.query(
      `INSERT INTO geofence_violations
         (company_id, geofence_id, vehicle_id, device_id,
          violation_type, occurred_at,
          location_lat, location_lng, speed,
          fw_version, raw_event, dedup_key)
       VALUES ($1,$2,$3,$4, $5,$6, $7,$8,$9, $10,$11,$12)`,
      [
        company_id, zone.id, vehicle_id, chipId,
        rawType,
        timestamp ? new Date(timestamp) : new Date(),
        latNum || null, lngNum || null, speed || null,
        fw_version || null,
        JSON.stringify({ ...event, _suspicious: suspicious }),
        dedupKey,
      ]
    );

    // ── 9. Alert INSERT ──────────────────────────────────────
    const alertType   = rawType === 'entry' ? 'geofence_entry' : 'geofence_exit';
    const severity    = zone.category === 'emission_zone' ? 'warning' : 'info';
    const title       = rawType === 'entry'
      ? `Bölgeye Giriş: ${zone.name}` : `Bölgeden Çıkış: ${zone.name}`;

    const alertRes = await client.query(
      `INSERT INTO alerts
         (company_id, alert_type, severity, device_id, task_id,
          title, description, is_resolved)
       VALUES ($1,$2,$3,$4,$5, $6,$7, false)
       RETURNING id`,
      [
        company_id, alertType, severity, chipId, null,
        title,
        `${plate_no} — ${zone.name} (${zone.category || 'general'}) lat=${latNum} lng=${lngNum}`,
      ]
    );

    fastify.log.info(`[GF] Recorded: ${rawType} zone="${zone.name}" vehicle=${plate_no}`);

    // ── 10. FCM push ─────────────────────────────────────────
    if (fastify.fcm && alertRes.rows.length > 0) {
      const tokens = await getAdminFcmTokens(client, company_id);
      if (tokens.length > 0) {
        await fastify.fcm.sendMulticast({
          tokens, title,
          body: `${plate_no} — ${zone.name}`,
          data: {
            type: alertType, alert_id: alertRes.rows[0].id,
            zone_id: zone.id, zone_key: zone.zone_key,
            vehicle_id: vehicle_id || '',
          },
        }).catch(e => fastify.log.warn({ e }, '[GF] FCM failed'));
      }
    }

    // ── 11. CSRD log ─────────────────────────────────────────
    if (zone.csrd_tracked && rawType === 'entry') {
      fastify.log.info(`[GF][CSRD] ${plate_no} entered emission zone "${zone.name}"`);
      // TODO: csrd_zone_entries insert (v2)
    }

  } catch (err) {
    fastify.log.error({ err }, '[GF] handleGeofenceEvent failed');
  } finally {
    client.release();
  }
}

async function getAdminFcmTokens(client, companyId) {
  try {
    const { rows } = await client.query(
      `SELECT fcm_token FROM users
       WHERE company_id = $1 AND role = 'company_admin' AND fcm_token IS NOT NULL`,
      [companyId]
    );
    return rows.map(r => r.fcm_token);
  } catch { return []; }
}

function startGeofenceConsumer(fastify) {
  const wildcard = 'fleet/device/+/geofence_event';
  fastify.mqtt.subscribe(wildcard, { qos: 1 }, (err) => {
    if (err) fastify.log.error({ err }, '[GF] Subscribe failed');
    else     fastify.log.info(`[GF] Subscribed: ${wildcard}`);
  });

  fastify.mqtt.on('message', (topic, message) => {
    if (topic.endsWith('/geofence_event')) {
      handleGeofenceEvent(fastify, topic, message)
        .catch(err => fastify.log.error({ err }, '[GF] Consumer error'));
    }
  });
}

module.exports = {
  publishConfigToDevice,
  publishConfigToAllDevices,
  startGeofenceConsumer,
  buildConfigPayload,
};