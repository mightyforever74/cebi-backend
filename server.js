require("dotenv").config();
const fastify = require("fastify")({ logger: true });
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const mqtt = require("mqtt");
const bcrypt = require("bcryptjs");
const { acknowledgeAlert } = require("./routes/alertsHelpers");
const { fetchVehicleTrack } = require("./routes/vehicleTrackHelpers");
const { parseVehicleCapacityFields } = require("./routes/vehicleCapacityHelpers");
const { checkVehicleQuota } = require("./routes/vehicleQuotaHelpers");
const {
  scheduleDailyTelematicsBatch,
} = require("./FEAT-007-EXT-virtual-telematics/06-cron/dailyTelematicsScheduler");
// 11 Ekim 2026: legacy sunucu-taraflı geofence kontrol fonksiyonu
// (routes/geofenceCheckHelpers.js) kaldırıldı — bozuk sorgu (var olmayan
// kolonlar), hiçbir zaman çalışmıyordu (prod geofence_events = 0 satır).
// Tek yetkili geofence tespit mercii artık v2-contract
// services/geofenceService.js (cihaz-taraflı tespit + sunucu doğrulama/dedup).
const { startGeofenceConsumer } = require("./services/geofenceService");
const {
  applyRouteBypass,
  safeWaypoints,
} = require("./services/waypointGeofenceHelpers");
const { createProvider } = require("./services/routing/factory");
const routingProvider = createProvider();
const crypto = require("crypto");
const {
  publicTrackUrl,
  revokePublicTrackingBestEffort,
  PUBLIC_TRACK_CLOSED,
  warmPublicRoute,
} = require("./routes/publicTrack");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;

// MQTT Configuration
const MQTT_OPTIONS = {
  host: process.env.MQTT_BROKER || "localhost",
  port: parseInt(process.env.MQTT_PORT) || 1883,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtt",
  rejectUnauthorized: false,
};

// MQTT Client
const mqttClient = mqtt.connect(MQTT_OPTIONS);

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("fleet/+/+/location");
  mqttClient.subscribe("fleet/+/+/telemetry");
  mqttClient.subscribe("fleet/+/+/alerts");
});

mqttClient.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const parts = topic.split("/");
    const [_, companyId, vehicleId, dataType] = parts;

    if (dataType === "location") {
      await saveLocationData(vehicleId, data);
    } else if (dataType === "telemetry") {
      await saveTelemetryData(vehicleId, data);
    } else if (dataType === "alerts") {
      await saveAlertData(vehicleId, data);
    }
  } catch (err) {
    console.error("MQTT error:", {
      message: err.message,
      code: err.code,
      detail: err.detail,
      table: err.table,
      column: err.column,
      constraint: err.constraint,
    });
  }
});

async function saveLocationData(deviceId, data) {
  // Skip if no valid GPS coordinates
  if (!data.latitude || !data.longitude) {
    console.log(
      "[MQTT] GPS waiting: " +
        deviceId +
        " (" +
        (data.satellites || 0) +
        " satellites)"
    );
    return;
  }
  // Skip unreliable GPS fix (cold start artifacts)
  if ((data.satellites || 0) < 4 || (data.hdop || 99) > 25) {
    console.log(
      "[MQTT] GPS low quality: " +
        deviceId +
        " sats=" +
        (data.satellites || 0) +
        " hdop=" +
        (data.hdop || 99)
    );
    return;
  }
  const client = await fastify.pg.connect();
  try {
    // Validate timestamp - use NOW() if invalid
    let timestamp = new Date();
    if (data.timestamp) {
      const parsed = new Date(data.timestamp);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020) {
        timestamp = parsed;
      }
    }

    // Speed: firmware v4.3.2+ sends speed_kmh, older sends speed (knots)
    const speed = data.speed_kmh ?? data.speed ?? 0;

    // 0. Resolve company_id from linked vehicle (read path + tenant filter need it)
    let companyId = null;
    try {
      const vres = await client.query(
        "SELECT company_id FROM vehicles WHERE esp32_device_id = $1 LIMIT 1",
        [deviceId]
      );
      if (vres.rows.length > 0) companyId = vres.rows[0].company_id;
    } catch (e) {
      /* location yazimini asla bloklama */
    }

    // 1. Insert location data
    await client.query(
      "INSERT INTO locations (time, device_id, latitude, longitude, speed, heading, altitude, accuracy, satellite_count, hdop, accel_x, accel_y, accel_z, company_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [
        timestamp,
        deviceId,
        data.latitude,
        data.longitude,
        speed,
        data.heading || 0,
        data.altitude || 0,
        data.accuracy || 0,
        data.satellites || 0,
        data.hdop || 0,
        data.accel_x || null,
        data.accel_y || null,
        data.accel_z || null,
        companyId,
      ]
    );

    // 2. Update device status AND auto-link esp_chip_id
    const upd = await client.query(
      `UPDATE devices SET 
                is_online = true, 
                last_seen_at = NOW(), 
                last_latitude = $2, 
                last_longitude = $3, 
                wifi_rssi = COALESCE($4, wifi_rssi), 
                firmware_version = COALESCE($5, firmware_version), 
                first_telemetry_at = COALESCE(first_telemetry_at, NOW()),
                esp_chip_id = COALESCE(esp_chip_id, $1),
                updated_at = NOW() 
            WHERE serial = $1 OR serial_number = $1 OR device_code = $1 OR esp_chip_id = $1`,
      [
        deviceId,
        data.latitude,
        data.longitude,
        data.wifi_rssi || null,
        data.fw_version || null,
      ]
    );

    // 3. Auto-update vehicles.esp32_device_id if device found and linked to vehicle
    if (upd.rowCount > 0) {
      await client.query(
        `UPDATE vehicles v SET esp32_device_id = $1, updated_at = NOW()
                 FROM devices d 
                 WHERE d.vehicle_id = v.id 
                   AND (d.serial = $1 OR d.serial_number = $1 OR d.device_code = $1 OR d.esp_chip_id = $1)
                   AND (v.esp32_device_id IS NULL OR v.esp32_device_id != $1)`,
        [deviceId]
      );
    }

    if (upd.rowCount === 0) {
      console.log("[DEV] device not found for id=" + deviceId);
    }

    console.log(
      "[MQTT] Location: " +
        deviceId +
        " @ " +
        data.latitude +
        "," +
        data.longitude +
        " | spd=" +
        speed +
        " | online=true"
    );

    // 11 Ekim 2026: legacy sunucu-taraflı geofence kontrol fonksiyonu
    // (ve Redis previousLat/previousLng teleport koruması) kaldırıldı. Geofence
    // tespiti artık tamamen v2-contract: cihaz firmware'i (v4.7.0+) kendi
    // tespitini yapıp `fleet/device/{id}/geofence_event` topic'ine yayınlıyor,
    // services/geofenceService.js:handleGeofenceEvent() bunu işliyor. Bu
    // konum (location) ingest akışının geofence ile ilgisi kalmadı.
  } finally {
    client.release();
  }
}

async function saveTelemetryData(deviceId, data) {
  const client = await fastify.pg.connect();
  try {
    const result = await client.query(
      "UPDATE devices SET is_online = true, last_seen_at = NOW(), firmware_version = COALESCE($2, firmware_version), wifi_rssi = COALESCE($3, wifi_rssi), updated_at = NOW() WHERE serial = $1 OR serial_number = $1 OR esp_chip_id = $1",
      [deviceId, data.fw_version || null, data.wifi_rssi || null]
    );
  } catch (err) {
    console.error("[TELEMETRY ERROR]", err.message, err.stack);
  } finally {
    client.release();
  }
}

// Rate limit cache: deviceId:alertType -> timestamp
const alertRateLimit = new Map();
const ALERT_COOLDOWN_MS = 30000; // 30 saniye

async function saveAlertData(deviceId, data) {
  // Rate limit kontrolü
  const rateKey = `${deviceId}:${data.type}`;
  const lastAlert = alertRateLimit.get(rateKey);
  const now = Date.now();

  if (lastAlert && now - lastAlert < ALERT_COOLDOWN_MS) {
    console.log("[ALERT] Rate limited:", data.type, "for", deviceId);
    return;
  }
  alertRateLimit.set(rateKey, now);

  const client = await fastify.pg.connect();
  try {
    const { rows } = await client.query(
      "SELECT v.company_id FROM vehicles v WHERE v.esp32_device_id = $1",
      [deviceId]
    );
    const companyId = rows[0]?.company_id || null;

    await client.query(
      `
            INSERT INTO alerts (alert_type, severity, device_id, title, description, company_id, latitude, longitude, speed, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
      [
        data.type,
        data.severity || "warning",
        deviceId,
        data.title || data.type || "Alert",
        data.description || "",
        companyId,
        data.latitude || null,
        data.longitude || null,
        data.speed || null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ]
    );
    console.log("[ALERT] Saved:", data.type, "for", deviceId);
  } finally {
    client.release();
  }
}

// Plugins
fastify.register(cors, { origin: "*" });
// SEC (14.10.2026): eskiden process.env.JWT_SECRET || "FleetJWT2024..." idi —
// yani JWT_SECRET ortam değişkeni herhangi bir sebeple (yanlış deploy,
// eksik .env, yeni ortam) tanımsız kalırsa sunucu, repoda AÇIK METİN olarak
// duran SABİT bir secret ile sessizce ayağa kalkıyordu (CWE-798). Bu durumda
// bu kaynak koduna erişebilen HERKES geçerli JWT üretebilir (super_admin
// dahil) — "fiilen güvenlik yok" demek. Fallback kaldırıldı: JWT_SECRET
// tanımlı değilse süreç HEMEN ve GÜRÜLTÜLÜ şekilde durur, zayıf bir
// varsayılanla asla devam etmez.
if (!process.env.JWT_SECRET) {
  fastify.log.error(
    "[SEC] JWT_SECRET ortam değişkeni tanımlı değil. Bilinen/sabit bir secret ile " +
      "ASLA devam edilmez (CWE-798). .env içinde güçlü, rastgele bir JWT_SECRET " +
      "tanımlayın (örn. `openssl rand -hex 32`) ve süreci yeniden başlatın."
  );
  process.exit(1);
}
fastify.register(jwt, {
  secret: process.env.JWT_SECRET,
});
fastify.register(require("@fastify/postgres"), { connectionString: DB_URL });

// Register route modules moved below after auth decoration

// ==========================================
// JWT AUTHENTICATION WITH MULTI-TENANT
// ==========================================

fastify.decorate("authenticate", async function (request, reply) {
  try {
    await request.jwtVerify();

    if (!request.user) {
      fastify.log.error("JWT verified but request.user is undefined");
      return reply.code(401).send({ error: "Unauthorized - No user in JWT" });
    }

    const user = request.user;

    if (user.role === "super_admin") {
      request.isSuperAdmin = true;
      request.isCompanyAdmin = false;
      request.companyId =
        request.query?.company_id || request.body?.company_id || null;

      fastify.log.info(
        {
          user: user.email,
          role: "super_admin",
          targetCompany: request.companyId,
        },
        "Super admin access"
      );
      return;
    }

    if (!user.company_id) {
      fastify.log.error({ user: user.email }, "User has no company assigned");
      return reply.code(403).send({ error: "No company assigned to user" });
    }

    request.companyId = user.company_id;
    request.isCompanyAdmin = user.role === "company_admin";
    request.isSuperAdmin = false;

    fastify.log.debug(
      { user: user.email, role: user.role, company: request.companyId },
      "User authenticated"
    );
  } catch (err) {
    fastify.log.error({ err }, "Authentication failed");
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// Tenant Filter Helper
fastify.decorate("tenantFilter", function (request) {
  if (request.isSuperAdmin && request.companyId) {
    return { company_id: request.companyId };
  }

  if (request.isSuperAdmin && !request.companyId) {
    return {};
  }

  return { company_id: request.companyId };
});

// ============================================
// FEATURE FLAGS
// ============================================
const FEATURE_TASK_EVENTS = process.env.FEATURE_TASK_EVENTS !== "false";

// ============================================
// TASK EVENTS (Progress / Moves) — NO-THROW HELPER
// ============================================
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
    if (!FEATURE_TASK_EVENTS) return;
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
  } catch (e) {
    fastify.log.error({ err: e, taskId, type }, "task_event_insert_failed");
  }
}

// ============================================
// STOP EVENT EMAIL HELPER — NO-THROW
// ============================================
async function sendStopEventEmail(fastify, { taskId, eventId, stopId, type }) {
  try {
    if (!eventId) return;
    const client = await fastify.pg.connect();
    try {
      // 1. Task + company admin email bul
      const { rows: taskRows } = await client.query(
        `SELECT t.task_no, t.title, t.company_id, t.start_location, t.end_location,
                v.plate_no as vehicle_plate
         FROM tasks t
         LEFT JOIN vehicles v ON t.vehicle_id = v.id
         WHERE t.id = $1`,
        [taskId]
      );
      if (!taskRows.length) return;
      const task = taskRows[0];

      const { rows: adminRows } = await client.query(
        `SELECT u.email, u.first_name FROM users u
         WHERE u.company_id = $1 AND u.role = 'company_admin'
         LIMIT 1`,
        [task.company_id]
      );
      if (!adminRows.length) return;
      const adminEmail = adminRows[0].email;
      const adminName = adminRows[0].first_name || "Admin";

      // 2. Dedup kontrolü
      const { rows: dedupCheck } = await client.query(
        `SELECT id FROM task_event_notifications WHERE task_event_id = $1 AND email = $2`,
        [eventId, adminEmail]
      );
      if (dedupCheck.length) return; // zaten gönderilmiş

      // 3. Email gönder
      const typeLabel =
        type === "STOP_ARRIVED"
          ? "Durağa Varış"
          : type === "STOP_DEPARTED"
          ? "Duraktan Ayrılış"
          : type === "WAYPOINT_COMPLETED"
          ? "Durak Tamamlandı"
          : type;

      const subject = `[TulipFleet] ${typeLabel} — ${
        task.task_no || task.title || taskId
      }`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#5E72E4;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
            <h2 style="margin:0;">${typeLabel}</h2>
          </div>
          <div style="padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
            <p>Merhaba ${adminName},</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px;font-weight:bold;color:#666;">Görev:</td><td style="padding:8px;">${
                task.task_no || "-"
              }</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#666;">Araç:</td><td style="padding:8px;">${
                task.vehicle_plate || "-"
              }</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#666;">Durak ID:</td><td style="padding:8px;">${
                stopId || "-"
              }</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#666;">Güzergah:</td><td style="padding:8px;">${
                task.start_location || "-"
              } → ${task.end_location || "-"}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;color:#666;">Zaman:</td><td style="padding:8px;">${new Date().toLocaleString(
                "tr-TR"
              )}</td></tr>
            </table>
            <p style="color:#999;font-size:12px;">Bu otomatik bir bildirimdir — TulipFleet</p>
          </div>
        </div>
      `;

      if (fastify.transporter) {
        await fastify.transporter.sendMail({
          from: process.env.SMTP_FROM || "noreply@tulipfleet.com",
          to: adminEmail,
          subject,
          html,
        });
      }

      // 4. Dedup kayıt
      await client.query(
        `INSERT INTO task_event_notifications (task_event_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [eventId, adminEmail]
      );

      fastify.log.info(
        { taskId, eventId, email: adminEmail, type },
        "stop_event_email_sent"
      );
    } finally {
      client.release();
    }
  } catch (e) {
    fastify.log.error(
      { err: e, taskId, eventId, type },
      "stop_event_email_failed"
    );
  }
}

// Register route modules (after auth decoration so preHandler works)
const adminFuelRoutes = require("./routes/adminFuel"); // Mevcut route import'larının yanına ekle
fastify.register(require("./routes/superadmin.companies"));
fastify.register(require("./routes/superadmin.subscriptions")); // FEAT-SaaS S2-E2
fastify.register(require("./routes/auth.publicSignup")); // FEAT-SAAS-2 S-O1
fastify.register(require("./routes/fuel"), { prefix: "/api/fuel" });
fastify.register(require("./routes/trips"));
fastify.register(adminFuelRoutes, { prefix: "/api/admin" }); // Mevcut app.use satırlarının yanına ekle

// ============================================================================
// DEVICE MANAGEMENT ROUTES (QR Code System)
// ============================================================================
fastify.register(require("./routes/devices")); // QR Scan endpoint
fastify.register(require("./routes/superadmin.devices")); // SuperAdmin QR management

// ── KETENREGIE İNCE KÖPRÜ API ENTEGRASYONU (SIRA 6 / TASK 2) ──
fastify.register(require("./routes/internalBridge"));

fastify.register(require("./routes/driver"), { prefix: "/api/driver" }); // Driver endpoints: assign-device, available-vehicles
fastify.register(require("./routes/company-plan")); // S5: GET /api/company/plan
fastify.register(require("./routes/companyBranding")); // §10 MVP-2: GET/PUT /api/company/branding (logo/renk)
fastify.register(require("./plugins/etag-cache")); // S6: ETag/304 cache for polling endpoints
fastify.register(require("./routes/geofences")); // Geofence CRUD + edge events
fastify.register(require("./routes/reports")); // Operations Report

// ============================================
// HEALTH & SYSTEM
// ============================================
fastify.get("/health", async (request, reply) => {
  let dbStatus = "disconnected";
  try {
    const client = await fastify.pg.connect();
    await client.query("SELECT 1");
    client.release();
    dbStatus = "connected";
  } catch (e) {
    dbStatus = "disconnected";
  }
  return {
    status: "ok",
    timestamp: new Date(),
    database: dbStatus,
    mqtt: mqttClient.connected ? "connected" : "disconnected",
    redis: "connected",
    uptime: process.uptime(),
    version: "3.0.0",
  };
});

// ============================================
// AUTHENTICATION
// ============================================

fastify.post("/api/auth/login", async (request, reply) => {
  const { email, password } = request.body;

  if (!email || !password) {
    return reply.code(400).send({ error: "Email and password required" });
  }

  const client = await fastify.pg.connect();

  try {
    const { rows } = await client.query(
      "SELECT id, email, password_hash, role, company_id, language, first_name, last_name, phone FROM users WHERE email = $1",
      [email]
    );

    if (!rows.length) {
      fastify.log.warn({ email }, "Login attempt with non-existent user");
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      fastify.log.warn({ email }, "Login attempt with wrong password");
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    let company = null;
    if (user.company_id) {
      const { rows: companyRows } = await client.query(
        "SELECT id, name, slug, features FROM companies WHERE id = $1",
        [user.company_id]
      );
      company = companyRows[0] || null;
    }

    const token = fastify.jwt.sign({
      id: user.id,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
    });

    fastify.log.info(
      { user: user.email, role: user.role, company: company?.name },
      "User logged in"
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        company: company
          ? { id: company.id, name: company.name, slug: company.slug }
          : null,
      },
    };
  } finally {
    client.release();
  }
});

fastify.post("/api/auth/register", async (request, reply) => {
  const { email, password, role = "driver", language = "tr" } = request.body;

  if (!email || !password) {
    return reply.code(400).send({ error: "Email and password required" });
  }

  const client = await fastify.pg.connect();
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, role, language) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, email, role, language`,
      [email, hashedPassword, role, language]
    );

    const token = fastify.jwt.sign({
      id: rows[0].id,
      email: rows[0].email,
      role: rows[0].role,
    });

    return reply.code(201).send({ token, user: rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return reply.code(409).send({ error: "Email already exists" });
    }
    throw err;
  } finally {
    client.release();
  }
});

fastify.post(
  "/api/auth/logout",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    return { success: true, message: "Logged out successfully" };
  }
);

// ============================================
// PASSWORD RESET (Email OTP)
// ============================================
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER || "noreply@tulipfleet.com",
    pass: process.env.SMTP_PASS || "",
  },
});

// Email transporter doğrulama (startup'ta)
emailTransporter.verify((error) => {
  if (error) {
    fastify.log.error({ error }, "SMTP connection failed");
  } else {
    fastify.log.info("SMTP connection ready");
  }
});
fastify.decorate("transporter", emailTransporter);
// ============================================
// ETA + DELAY INTELLIGENCE HELPERS
// ============================================

// ─────────────────────────────────────────────
// HELPER: OTP email gönder
// ─────────────────────────────────────────────
async function sendOTPEmail(email, otpCode, language = "tr") {
  const subjects = {
    tr: "TulipFleet - Şifre Sıfırlama Kodu",
    en: "TulipFleet - Password Reset Code",
    nl: "TulipFleet - Wachtwoord Reset Code",
    bg: "TulipFleet - Код за нулиране на парола",
    es: "TulipFleet - Código de restablecimiento",
    it: "TulipFleet - Codice di ripristino",
    ku: "TulipFleet - Koda Nûvekirina Şîfreyê",
  };

  const subject = subjects[language] || subjects.en;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #5e72e4; margin: 0; font-size: 28px; letter-spacing: 2px;">TULIPFLEET</h1>
      </div>
      <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; text-align: center;">
        <h2 style="color: #333; margin-top: 0;">
          ${language === "tr" ? "Şifre Sıfırlama Kodu" : "Password Reset Code"}
        </h2>
        <p style="color: #666; font-size: 14px;">
          ${
            language === "tr"
              ? "Şifrenizi sıfırlamak için aşağıdaki kodu kullanın:"
              : "Use the code below to reset your password:"
          }
        </p>
        <div style="background: #5e72e4; color: white; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 16px 24px; border-radius: 8px; display: inline-block; margin: 16px 0;">
          ${otpCode}
        </div>
        <p style="color: #999; font-size: 12px; margin-top: 16px;">
          ${
            language === "tr"
              ? "Bu kod 10 dakika içinde geçerliliğini yitirecektir."
              : "This code will expire in 10 minutes."
          }
        </p>
        <p style="color: #999; font-size: 12px;">
          ${
            language === "tr"
              ? "Bu işlemi siz yapmadıysanız, bu e-postayı görmezden gelin."
              : "If you did not request this, please ignore this email."
          }
        </p>
      </div>
      <p style="color: #ccc; font-size: 11px; text-align: center; margin-top: 24px;">
        © 2026 TulipFleet - Fleet Management System
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"TulipFleet" <${process.env.SMTP_USER || "noreply@tulipfleet.com"}>`,
    to: email,
    subject: subject,
    html: htmlContent,
  });
}

async function checkResetRateLimit(client, email, ip) {
  const emailCheck = await client.query(
    "SELECT COUNT(*) as cnt FROM password_reset_tokens WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [email]
  );
  if (parseInt(emailCheck.rows[0].cnt) >= 5) return { limited: true };
  if (ip) {
    const ipCheck = await client.query(
      "SELECT COUNT(*) as cnt FROM password_reset_tokens WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '1 minute'",
      [ip]
    );
    if (parseInt(ipCheck.rows[0].cnt) >= 3) return { limited: true };
  }
  return { limited: false };
}

// ═════════════════════════════════════════════
// ENDPOINT 1: POST /api/auth/forgot-password
// ═════════════════════════════════════════════
fastify.post("/api/auth/forgot-password", async (request, reply) => {
  const { email } = request.body;

  if (!email) {
    return reply.code(400).send({ error: "Email required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const ipAddress = request.headers["x-forwarded-for"] || request.ip;
  const client = await fastify.pg.connect();

  try {
    // 1. Rate limit kontrolü
    const rateLimit = await checkRateLimit(client, normalizedEmail, ipAddress);
    if (rateLimit.limited) {
      fastify.log.warn(
        { email: normalizedEmail, reason: rateLimit.reason },
        "Rate limit hit"
      );
      return reply.code(429).send({ error: "Too many requests. Please wait." });
    }

    // 2. Kullanıcıyı bul (ama sonucu her durumda 200 dön)
    const { rows: userRows } = await client.query(
      "SELECT id, email, language FROM users WHERE email = $1 AND is_active = true",
      [normalizedEmail]
    );

    // 3. Kullanıcı varsa OTP oluştur ve email gönder
    if (userRows.length > 0) {
      const user = userRows[0];

      // 6 haneli OTP üret
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // OTP'yi hashle
      const bcrypt = require("bcrypt");
      const otpHash = await bcrypt.hash(otp, 10);

      // Eski kullanılmamış token'ları invalidate et
      await client.query(
        `UPDATE password_reset_tokens SET used = true 
         WHERE email = $1 AND used = false`,
        [normalizedEmail]
      );

      // Yeni token kaydet
      await client.query(
        `INSERT INTO password_reset_tokens (email, token_hash, expires_at, ip_address)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes', $3)`,
        [normalizedEmail, otpHash, ipAddress]
      );

      // Email gönder
      try {
        await sendOTPEmail(normalizedEmail, otp, user.language || "tr");
        fastify.log.info({ email: normalizedEmail }, "OTP email sent");
      } catch (emailErr) {
        fastify.log.error(
          { error: emailErr.message },
          "Failed to send OTP email"
        );
        // Email gönderilemese bile 200 dön (güvenlik)
      }
    } else {
      fastify.log.info(
        { email: normalizedEmail },
        "Forgot password for non-existent email (ignored)"
      );
    }

    // 4. Her durumda aynı yanıt (enumeration engeli)
    return { ok: true };
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// HELPER: Rate limit kontrolü
// ─────────────────────────────────────────────
async function checkRateLimit(client, email, ipAddress) {
  // Email bazlı: Son 1 saatte max 5 OTP
  const emailCheck = await client.query(
    `SELECT COUNT(*) as cnt FROM password_reset_tokens 
     WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [email]
  );
  if (parseInt(emailCheck.rows[0].cnt) >= 5) {
    return { limited: true, reason: "email_limit" };
  }

  // IP bazlı: Son 1 dakikada max 3 istek
  if (ipAddress) {
    const ipCheck = await client.query(
      `SELECT COUNT(*) as cnt FROM password_reset_tokens 
       WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
      [ipAddress]
    );
    if (parseInt(ipCheck.rows[0].cnt) >= 3) {
      return { limited: true, reason: "ip_limit" };
    }
  }

  return { limited: false };
}

// ═════════════════════════════════════════════
// ENDPOINT 2: POST /api/auth/reset-password
// ═════════════════════════════════════════════
fastify.post("/api/auth/reset-password", async (request, reply) => {
  const { email, code, newPassword } = request.body;

  if (!email || !code || !newPassword) {
    return reply
      .code(400)
      .send({ error: "Email, code and new password required" });
  }

  if (newPassword.length < 6) {
    return reply
      .code(400)
      .send({ error: "Password must be at least 6 characters" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const client = await fastify.pg.connect();

  try {
    await client.query("BEGIN");

    // 1. En son geçerli (kullanılmamış, süresi dolmamış) token'ı bul
    const { rows: tokenRows } = await client.query(
      `SELECT id, token_hash, attempts FROM password_reset_tokens 
       WHERE email = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedEmail]
    );

    if (tokenRows.length === 0) {
      await client.query("ROLLBACK");
      fastify.log.warn(
        { email: normalizedEmail },
        "Reset attempt with no valid token"
      );
      return reply.code(400).send({ error: "Invalid or expired code" });
    }

    const tokenRecord = tokenRows[0];

    // 2. Attempt limit kontrolü (max 5)
    if (tokenRecord.attempts >= 5) {
      // Token'ı kullanılmış olarak işaretle
      await client.query(
        "UPDATE password_reset_tokens SET used = true WHERE id = $1",
        [tokenRecord.id]
      );
      await client.query("COMMIT");

      fastify.log.warn(
        { email: normalizedEmail },
        "OTP attempt limit exceeded"
      );
      return reply.code(400).send({ error: "Too many attempts" });
    }

    // 3. Attempt sayısını artır
    await client.query(
      "UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id = $1",
      [tokenRecord.id]
    );

    // 4. OTP doğrula
    const bcrypt = require("bcrypt");
    const isValid = await bcrypt.compare(code, tokenRecord.token_hash);

    if (!isValid) {
      await client.query("COMMIT");
      fastify.log.warn(
        { email: normalizedEmail, attempts: tokenRecord.attempts + 1 },
        "Invalid OTP attempt"
      );
      return reply.code(400).send({ error: "Invalid or expired code" });
    }

    // 5. Şifreyi güncelle
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await client.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2",
      [newPasswordHash, normalizedEmail]
    );

    // 6. Token'ı kullanılmış olarak işaretle
    await client.query(
      "UPDATE password_reset_tokens SET used = true WHERE id = $1",
      [tokenRecord.id]
    );

    // 7. Eski refresh token'ları invalidate et (varsa)
    await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = (
        SELECT id FROM users WHERE email = $1
      )`,
      [normalizedEmail]
    );

    await client.query("COMMIT");

    fastify.log.info({ email: normalizedEmail }, "Password reset successful");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    fastify.log.error({ error: error.message }, "Reset password error");
    return reply.code(500).send({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// CLEANUP ENDPOINT (opsiyonel - eski token'ları temizle)
// Cron job veya admin endpoint olarak kullanılabilir
// ─────────────────────────────────────────────
fastify.delete(
  "/api/auth/cleanup-tokens",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const client = await fastify.pg.connect();
    try {
      const result = await client.query(
        "DELETE FROM password_reset_tokens WHERE created_at < NOW() - INTERVAL '24 hours'"
      );
      return { ok: true, deleted: result.rowCount };
    } finally {
      client.release();
    }
  }
);

// ── GET /api/users/profile ───────────────────────────────
fastify.get(
  "/api/users/profile",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const userId = request.user.id;
    try {
      const result = await fastify.pg.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
              u.role, u.language, u.is_active, u.company_id,
              u.push_enabled, u.created_at, u.updated_at,
              d.id AS driver_id, d.status AS driver_status,
              d.assigned_vehicle_id, d.license_no,
              v.plate_no AS vehicle_plate, v.brand AS vehicle_brand, v.model AS vehicle_model
       FROM users u
       LEFT JOIN drivers d ON d.user_id = u.id
       LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
       WHERE u.id = $1`,
        [userId]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }
      return { user: result.rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to get profile" });
    }
  }
);

// ============================================
// USER PROFILE ENDPOINTS
// ============================================

fastify.put(
  "/api/users/profile",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const { firstName, lastName, phone } = request.body;
    const userId = request.user.id;

    try {
      const result = await fastify.pg.query(
        `UPDATE users 
       SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, first_name, last_name, phone`,
        [firstName, lastName, phone, userId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      return { success: true, user: result.rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update profile" });
    }
  }
);

fastify.put(
  "/api/users/password",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const { currentPassword, newPassword } = request.body;
    const userId = request.user.id;

    if (!currentPassword || !newPassword) {
      return reply
        .code(400)
        .send({ error: "Current and new password required" });
    }

    if (newPassword.length < 6) {
      return reply
        .code(400)
        .send({ error: "Password must be at least 6 characters" });
    }

    try {
      const userResult = await fastify.pg.query(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId]
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const valid = await bcrypt.compare(
        currentPassword,
        userResult.rows[0].password_hash
      );
      if (!valid) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 10);

      await fastify.pg.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [newHash, userId]
      );

      return { success: true, message: "Password updated successfully" };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update password" });
    }
  }
);
// ============================================
// ALIAS ENDPOINTS (user -> users uyumlulugu)
// ============================================

// GET /api/user/profile — self-scoped; company_name for dispatcher/mobile
fastify.get(
  "/api/user/profile",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const userId = request.user.id;
    try {
      const result = await fastify.pg.query(
        `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone,
                u.language, u.company_id, c.name AS company_name
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }
      const row = result.rows[0];
      // Mobile AdminSettings/EditProfile: firstName || first_name; PUT wraps { user }.
      // Dispatcher BasicInfo reads firstName/email/phone on the JSON root.
      const user = {
        ...row,
        firstName: row.first_name,
        lastName: row.last_name,
      };
      return {
        user,
        id: row.id,
        email: row.email,
        role: row.role,
        first_name: row.first_name,
        last_name: row.last_name,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        language: row.language,
        company_id: row.company_id,
        company_name: row.company_name,
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to get profile" });
    }
  }
);

// PUT /api/user/profile -> /api/users/profile alias
fastify.put(
  "/api/user/profile",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const { firstName, lastName, phone, language } = request.body;
    const userId = request.user.id;

    try {
      // P1-3b (10 Eki): mobil dil degistirince (i18n.changeLanguage) backend'e
      // de yazsin diye eklendi. COALESCE: alan gonderilmezse (eski mobil
      // surumu, ya da yalniz ad/soyad guncelleyen cagri) mevcut dil DEGISMEZ -
      // onceki firstName/lastName/phone davranisinin aksine burada sessiz
      // NULL'a dusme riski yok.
      const result = await fastify.pg.query(
        `UPDATE users
       SET first_name = $1, last_name = $2, phone = $3,
           language = COALESCE($4, language), updated_at = NOW()
       WHERE id = $5
       RETURNING id, email, first_name, last_name, phone, language`,
        [firstName, lastName, phone, language || null, userId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      return { success: true, user: result.rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update profile" });
    }
  }
);

// PUT /api/user/password -> /api/users/password alias
fastify.put(
  "/api/user/password",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const { currentPassword, newPassword } = request.body;
    const userId = request.user.id;

    try {
      const userResult = await fastify.pg.query(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId]
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        userResult.rows[0].password_hash
      );
      if (!validPassword) {
        return reply.code(400).send({ error: "Current password is incorrect" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await fastify.pg.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [hashedPassword, userId]
      );

      return { success: true, message: "Password updated successfully" };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update password" });
    }
  }
);

// ============================================
// DRIVER ENDPOINTS
// ============================================

fastify.get(
  "/api/driver/tasks",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const userId = request.user.id;
    const { status } = request.query; // ?status=completed için
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        "SELECT id, company_id FROM drivers WHERE user_id = $1",
        [userId]
      );

      if (!driverRows.length) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const driverId = driverRows[0].id;
      const driverCompanyId = driverRows[0].company_id;

      // Status filter: active (default) veya completed
      let statusFilter;
      if (status === "completed") {
        statusFilter = `t.status IN ('completed', 'rejected', 'cancelled')`;
      } else {
        // Aktif görevler (YENİ: pending_review ve accepted eklendi)
        statusFilter = `t.status IN ('pending', 'pending_review', 'accepted', 'assigned', 'in_progress')`;
      }

      const { rows } = await client.query(
        `
      SELECT 
        t.id, t.task_no, t.status, t.title, t.description, t.priority,
        t.start_location, t.end_location, t.route_json, t.waypoints,
        t.scheduled_start, t.scheduled_end, t.planned_start, t.planned_end,
        t.actual_start, t.actual_end, t.total_distance_km,
        t.created_at, t.updated_at, t.notes,
        v.plate_no as vehicle_plate, v.id as vehicle_id
      FROM tasks t
      LEFT JOIN vehicles v ON t.vehicle_id = v.id
      WHERE t.driver_id = $1 AND t.company_id = $2 AND ${statusFilter}
      ORDER BY 
        CASE t.status 
          WHEN 'pending_review' THEN 1
          WHEN 'accepted' THEN 2
          WHEN 'in_progress' THEN 3
          ELSE 4
        END,
        t.scheduled_start ASC NULLS LAST,
        t.created_at DESC
    `,
        [driverId, driverCompanyId]
      );

      return { tasks: rows };
    } catch (err) {
      request.log.error({ err }, "failed to fetch driver tasks");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.get(
  "/api/driver/stats",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        "SELECT id, company_id, safety_score, total_km_driven FROM drivers WHERE user_id = $1",
        [userId]
      );

      if (!driverRows.length) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const driver = driverRows[0];
      const driverId = driver.id;
      const driverCompanyId = driver.company_id;

      const { rows: taskStats } = await client.query(
        `
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
        COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress'))::int AS active_tasks,
        COALESCE(SUM(actual_distance_km) FILTER (
          WHERE status = 'completed'
          AND DATE(actual_end) = CURRENT_DATE
        ), 0)::numeric AS today_km,
        COALESCE(SUM(actual_distance_km) FILTER (
          WHERE status = 'completed'
          AND actual_end >= DATE_TRUNC('month', CURRENT_DATE)
        ), 0)::numeric AS month_km
      FROM tasks 
      WHERE driver_id = $1 AND company_id = $2
    `,
        [driverId, driverCompanyId]
      );

      const stats = {
        completed_tasks: taskStats[0]?.completed_tasks || 0,
        active_tasks: taskStats[0]?.active_tasks || 0,
        today_km: parseFloat(taskStats[0]?.today_km) || 0,
        month_km: parseFloat(taskStats[0]?.month_km) || 0,
        safety_score: parseFloat(driver.safety_score) || 5.0,
        fuel_efficiency: 0,
      };

      return { stats };
    } catch (err) {
      request.log.error({ err }, "failed to fetch driver stats");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.get(
  "/api/driver/vehicle",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        "SELECT assigned_vehicle_id, company_id FROM drivers WHERE user_id = $1 LIMIT 1",
        [userId]
      );

      if (!driverRows.length || !driverRows[0].assigned_vehicle_id) {
        return reply.code(404).send({ error: "No vehicle assigned" });
      }

      const vehicleId = driverRows[0].assigned_vehicle_id;
      const driverCompanyId = driverRows[0].company_id;

      const { rows: vehicleRows } = await client.query(
        `SELECT
          v.id, v.plate_no, v.model, v.brand, v.year, v.fuel_type,
          v.current_fuel_level, v.fuel_capacity, v.total_km, v.status, v.esp32_device_id,
          d.serial            AS device_serial,
          d.status            AS device_status,
          d.setup_required    AS device_setup_required,
          d.setup_required_at AS device_setup_required_at
       FROM vehicles v
       LEFT JOIN LATERAL (
          SELECT serial, status, setup_required, setup_required_at
          FROM devices
          WHERE vehicle_id = v.id
          ORDER BY assigned_at DESC NULLS LAST, updated_at DESC
          LIMIT 1
       ) d ON true
       WHERE v.id = $1 AND v.company_id = $2`,
        [vehicleId, driverCompanyId]
      );

      if (!vehicleRows.length) {
        return reply.code(404).send({ error: "Vehicle not found" });
      }

      const v = vehicleRows[0];

      const devicePending =
        !v.device_serial ||
        ["pending", "CREATED", "PRINTED", "IN_STOCK"].includes(v.device_status);
      const setupRequired =
        !!v.device_setup_required || !v.esp32_device_id || devicePending;
      request.log.info(
        {
          tag: "driver_vehicle_debug",
          userId,
          vehicleId: v.id,
          plate: v.plate_no,
          esp32_device_id: v.esp32_device_id,
          device_serial: v.device_serial,
          device_status: v.device_status,
          device_setup_required: v.device_setup_required,
          setupRequired,
        },
        "driver_vehicle_debug"
      );
      request.log.info(
        {
          tag: "driver_vehicle_debug",
          userId,
          vehicleId: v.id,
          plate: v.plate_no,
          esp32_device_id: v.esp32_device_id,
          device_serial: v.device_serial,
          device_status: v.device_status,
          device_setup_required: v.device_setup_required,
          setupRequired,
        },
        "driver_vehicle_debug"
      );

      return reply.send({
        setup_required: setupRequired,
        setup_required_at: v.device_setup_required_at ?? null,
        vehicle: {
          id: v.id,
          plate: v.plate_no,
          plate_no: v.plate_no, // alias
          model: v.model,
          brand: v.brand,
          year: v.year,
          fuelType: v.fuel_type,
          fuel_type: v.fuel_type, // alias
          fuelLevel: Number(v.current_fuel_level ?? 0),
          fuel_level: Number(v.current_fuel_level ?? 0), // alias
          current_fuel_level: Number(v.current_fuel_level ?? 0), // alias
          fuelCapacity: Number(v.fuel_capacity ?? 0),
          fuel_capacity: Number(v.fuel_capacity ?? 0), // alias
          odometer: Number(v.total_km ?? 0),
          total_km: Number(v.total_km ?? 0), // alias
          current_km: Number(v.total_km ?? 0), // alias
          status: v.status,
          esp32Status: {
            connected: !!v.esp32_device_id,
            deviceId: v.esp32_device_id,
            serial: v.device_serial,
            deviceStatus: v.device_status,
          },
          lastLocation: null, // ← BU SATIRI EKLE
        },
      });
    } catch (err) {
      request.log.error({ err }, "failed to fetch driver vehicle");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.put(
  "/api/driver/task/:id/status",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { status } = request.body;
    const userId = request.user.id;

    // YENİ: accepted ve rejected eklendi
    const validStatuses = [
      "accepted",
      "rejected",
      "in_progress",
      "completed",
      "cancelled",
    ];
    if (!validStatuses.includes(status)) {
      return reply.code(400).send({ error: "Invalid status" });
    }

    const client = await fastify.pg.connect();

    try {
      await client.query("BEGIN");

      // Driver bilgisini al
      const { rows: driverRows } = await client.query(
        `SELECT d.id, d.company_id, u.first_name, u.last_name, u.email 
       FROM drivers d 
       JOIN users u ON d.user_id = u.id 
       WHERE d.user_id = $1`,
        [userId]
      );

      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }

      const driver = driverRows[0];
      const driverId = driver.id;
      const driverName =
        `${driver.first_name || ""} ${driver.last_name || ""}`.trim() ||
        driver.email;

      // Task bilgisini al
      const { rows: taskRows } = await client.query(
        `SELECT t.*, v.plate_no as vehicle_plate 
       FROM tasks t 
       LEFT JOIN vehicles v ON t.vehicle_id = v.id 
       WHERE t.id = $1 AND t.driver_id = $2`,
        [id, driverId]
      );

      if (taskRows.length === 0) {
        await client.query("ROLLBACK");
        return reply
          .code(404)
          .send({ error: "Task not found or unauthorized" });
      }

      const task = taskRows[0];
      const taskNo =
        task.task_no ||
        (typeof task.id === "string" ? task.id.slice(0, 8) : String(task.id));

      // Task status güncelle
      // in_progress gecisinde: baska aktif gorev var mi kontrol et
      if (status === "in_progress") {
        const { rows: activeRows } = await client.query(
          `SELECT id FROM tasks WHERE driver_id = $1 AND status = 'in_progress' AND id != $2`,
          [driverId, id]
        );
        if (activeRows.length > 0) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: "TASK_CONFLICT",
            message:
              "Zaten devam eden bir gorev var. Once mevcut gorevi tamamlayin.",
            active_task_id: activeRows[0].id,
          });
        }
      }

      const updateFields = ["status = $1", "updated_at = CURRENT_TIMESTAMP"];
      const params = [status];

      if (status === "in_progress") {
        updateFields.push("actual_start = CURRENT_TIMESTAMP");
        const odomStart = parseFloat(request.body.odometer_start);
        if (!isNaN(odomStart) && odomStart >= 0) {
          params.push(odomStart);
          updateFields.push("odometer_start = $" + params.length);
        }
      } else if (status === "completed") {
        updateFields.push("actual_end = CURRENT_TIMESTAMP");
      }

      params.push(id, driverId);

      const { rows } = await client.query(
        `
      UPDATE tasks 
      SET ${updateFields.join(", ")}
      WHERE id = $${params.length - 1} AND driver_id = $${params.length}
      RETURNING *
    `,
        params
      );
      if (PUBLIC_TRACK_CLOSED.has(String(status || ""))) {
        await revokePublicTrackingBestEffort(client, id, request.log);
      }
      await client.query("COMMIT");
      return { locations: rows };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return reply.code(409).send({
          error: "TASK_CONFLICT",
          message:
            "Zaten devam eden bir gorev var. Once mevcut gorevi tamamlayin.",
        });
      }
      request.log.error(error);
      console.error("[TASK STATUS ERROR]", error.message);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// PUT /api/driver/vehicle/:id/fuel - Yakıt güncelle
fastify.put(
  "/api/driver/vehicle/:id/fuel",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { fuel_level } = request.body || {};
    const userId = request.user.id;

    if (fuel_level === undefined || isNaN(Number(fuel_level))) {
      return reply.code(400).send({ error: "Geçerli bir fuel_level gerekli" });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows: driverCheck } = await client.query(
        `SELECT d.id FROM drivers d WHERE d.user_id = $1 AND d.assigned_vehicle_id = $2`,
        [userId, id]
      );

      if (driverCheck.length === 0) {
        return reply.code(403).send({ error: "Bu araca erişim yetkiniz yok" });
      }

      const { rows } = await client.query(
        `UPDATE vehicles SET current_fuel_level = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [Number(fuel_level), id]
      );

      console.log(`✅ Fuel updated: Vehicle ${id} -> ${fuel_level}L`);
      return { success: true, vehicle: rows[0] };
    } catch (error) {
      console.error("Fuel update error:", error);
      return reply.code(500).send({ error: "Yakıt güncellenemedi" });
    } finally {
      client.release();
    }
  }
);

// PUT /api/driver/vehicle/:id/odometer - KM güncelle
fastify.put(
  "/api/driver/vehicle/:id/odometer",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { odometer } = request.body || {};
    const userId = request.user.id;

    if (odometer === undefined || isNaN(Number(odometer))) {
      return reply.code(400).send({ error: "Geçerli bir odometer gerekli" });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows: driverCheck } = await client.query(
        `SELECT d.id FROM drivers d WHERE d.user_id = $1 AND d.assigned_vehicle_id = $2`,
        [userId, id]
      );

      if (driverCheck.length === 0) {
        return reply.code(403).send({ error: "Bu araca erişim yetkiniz yok" });
      }

      const { rows } = await client.query(
        `UPDATE vehicles SET total_km = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [Number(odometer), id]
      );

      console.log(`✅ Odometer updated: Vehicle ${id} -> ${odometer}km`);
      return { success: true, vehicle: rows[0] };
    } catch (error) {
      console.error("Odometer update error:", error);
      return reply.code(500).send({ error: "KM güncellenemedi" });
    } finally {
      client.release();
    }
  }
);

/**
 * PUT /api/driver/vehicle/:id/settings
 * Araç yakıt tipi ve depo kapasitesi güncelleme (Driver)
 */
fastify.put(
  "/api/driver/vehicle/:id/settings",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const { user } = request;
    const { id } = request.params;
    const { fuel_type, fuel_capacity, color } = request.body;

    try {
      // Driver'ın bu araca erişim yetkisi var mı?
      const checkResult = await fastify.pg.query(
        `
      SELECT v.id 
      FROM vehicles v
      JOIN drivers d ON d.assigned_vehicle_id = v.id
      WHERE d.user_id = $1 AND v.id = $2
    `,
        [user.id, id]
      );

      if (checkResult.rows.length === 0) {
        return reply
          .status(403)
          .send({ error: "Bu araca erişim yetkiniz yok" });
      }

      // Validation
      const validFuelTypes = ["diesel", "gasoline", "lpg", "electric"];
      if (fuel_type && !validFuelTypes.includes(fuel_type)) {
        return reply.status(400).send({ error: "Geçersiz yakıt tipi" });
      }

      if (fuel_capacity && (fuel_capacity < 10 || fuel_capacity > 500)) {
        return reply
          .status(400)
          .send({ error: "Depo kapasitesi 10-500L arası olmalı" });
      }

      // Güncelle
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      if (fuel_type) {
        updateFields.push(`fuel_type = $${paramIndex}`);
        updateValues.push(fuel_type);
        paramIndex++;
      }

      if (fuel_capacity) {
        updateFields.push(`fuel_capacity = $${paramIndex}`);
        updateValues.push(fuel_capacity);
        paramIndex++;
      }

      if (color) {
        updateFields.push(`color = $${paramIndex}`);
        updateValues.push(color);
        paramIndex++;
      }

      if (updateFields.length === 0) {
        return reply
          .status(400)
          .send({ error: "Güncellenecek alan belirtilmedi" });
      }

      updateFields.push(`updated_at = NOW()`);
      updateValues.push(id);

      const result = await fastify.pg.query(
        `
      UPDATE vehicles 
      SET ${updateFields.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING id, plate_no, fuel_type, fuel_capacity, color
    `,
        updateValues
      );

      return reply.send({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Güncelleme başarısız" });
    }
  }
);

// (moved richer implementations near server start)

// ============================================
// ADMIN ENDPOINTS
// ============================================

fastify.get(
  "/api/admin/fleet-stats",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const role = request.user?.role;
      const companyId = request.user?.company_id ?? request.companyId ?? null;

      if (role !== "super_admin" && !companyId) {
        return reply.code(400).send({ error: "Company context required" });
      }

      const isSuper = role === "super_admin";
      const params = isSuper ? [] : [companyId];
      const whereClause = isSuper ? "" : "WHERE company_id = $1";

      const vehicleStats = await client.query(
        `SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE status = 'available')::int as available,
            COUNT(*) FILTER (WHERE status = 'in_use')::int as in_use,
            COUNT(*) FILTER (WHERE status = 'maintenance')::int as maintenance
          FROM vehicles ${whereClause}`,
        params
      );

      const driverStats = await client.query(
        `SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE status IN ('on_task','task_pending'))::int as on_duty,
            COUNT(*) FILTER (WHERE status = 'available')::int as available,
            COUNT(*) FILTER (WHERE status = 'on_leave')::int as on_leave,
            COUNT(*) FILTER (WHERE status = 'offline')::int as offline
          FROM drivers ${whereClause}`,
        params
      );

      const taskStats = await client.query(
        `SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
            COUNT(*) FILTER (WHERE status IN ('accepted','assigned','in_progress','pending_review'))::int as active,
            COUNT(*) FILTER (WHERE status = 'completed' AND DATE(updated_at) = CURRENT_DATE)::int as completed_today
          FROM tasks ${whereClause}`,
        params
      );

      const alertStats = await client.query(
        `SELECT
            COUNT(*) FILTER (WHERE is_resolved = false)::int as unresolved,
            COUNT(*) FILTER (WHERE severity = 'critical' AND is_resolved = false)::int as critical
          FROM alerts ${whereClause}`,
        params
      );

      const onlineSql = isSuper
        ? `SELECT COUNT(DISTINCT v.id)::int as online
             FROM locations l
             JOIN vehicles v ON l.device_id = v.esp32_device_id
             WHERE l.time > NOW() - INTERVAL '5 minutes'`
        : `SELECT COUNT(DISTINCT v.id)::int as online
             FROM locations l
             JOIN vehicles v ON l.device_id = v.esp32_device_id
             WHERE v.company_id = $1 AND l.time > NOW() - INTERVAL '5 minutes'`;

      const onlineRes = await client.query(onlineSql, params);
      const onlineVehicles = onlineRes.rows[0]?.online ?? 0;

      // --- DELAY STATS (task_events) ---
      // super_admin + companyId scope: eger super_admin bir sirket secmisse filtrele
      const delayParams = isSuper && !companyId ? [] : [companyId];
      const delayJoin =
        isSuper && !companyId
          ? ""
          : "JOIN tasks t ON te.task_id = t.id::text AND t.company_id = $1";

      // Son 24 saat gecikme sayisi
      const delayed24hRes = await client.query(
        `SELECT COUNT(*)::int as cnt
           FROM task_events te
           ${delayJoin}
           WHERE te.type = 'STOP_DELAYED'
             AND te.created_at > NOW() - INTERVAL '24 hours'`,
        delayParams
      );

      // Onceki 24 saat (trend karsilastirmasi icin)
      const delayedPrev24hRes = await client.query(
        `SELECT COUNT(*)::int as cnt
           FROM task_events te
           ${delayJoin}
           WHERE te.type = 'STOP_DELAYED'
             AND te.created_at BETWEEN NOW() - INTERVAL '48 hours'
                                  AND NOW() - INTERVAL '24 hours'`,
        delayParams
      );

      // Su an aktif geciken duraklar
      // STOP_DELAYED var ama ayni stop icin WAYPOINT_COMPLETED gelmemis
      const activeDelayJoin =
        isSuper && !companyId
          ? "JOIN tasks t ON te.task_id = t.id::text"
          : "JOIN tasks t ON te.task_id = t.id::text AND t.company_id = $1";

      const delayedActiveRes = await client.query(
        `SELECT COUNT(DISTINCT te.stop_id)::int as cnt
           FROM task_events te
           ${activeDelayJoin}
           WHERE te.type = 'STOP_DELAYED'
             AND te.stop_id IS NOT NULL
             AND t.status IN ('in_progress', 'accepted')
             AND NOT EXISTS (
               SELECT 1 FROM task_events te2
               WHERE te2.task_id = te.task_id
                 AND te2.stop_id = te.stop_id
                 AND te2.type = 'WAYPOINT_COMPLETED'
                 AND te2.created_at > te.created_at
             )`,
        delayParams
      );

      const delayed24h = delayed24hRes.rows[0]?.cnt ?? 0;
      const delayedPrev24h = delayedPrev24hRes.rows[0]?.cnt ?? 0;
      const delayedActiveNow = delayedActiveRes.rows[0]?.cnt ?? 0;

      const v = vehicleStats.rows[0];
      const d = driverStats.rows[0];
      const t = taskStats.rows[0];
      const a = alertStats.rows[0];

      return {
        totals: {
          vehicles: v.total,
          drivers: d.total,
          active_tasks: t.active,
          pending_tasks: t.pending,
          alerts: a.unresolved,
        },
        breakdown: {
          vehicles: {
            available: v.available,
            in_use: v.in_use,
            maintenance: v.maintenance,
          },
          drivers: {
            on_duty: d.on_duty,
            available: d.available,
            on_leave: d.on_leave,
            offline: d.offline,
          },
          tasks: { total: t.total, completed_today: t.completed_today },
          alerts: { unresolved: a.unresolved, critical: a.critical },
        },
        health: {
          online_vehicles: onlineVehicles,
          offline_vehicles: Math.max(0, v.total - onlineVehicles),
        },
        delays: {
          last_24h: delayed24h,
          prev_24h: delayedPrev24h,
          active_now: delayedActiveNow,
          delta: delayed24h - delayedPrev24h,
        },
      };
    } finally {
      client.release();
    }
  }
);

fastify.get(
  "/api/admin/vehicles",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();

    try {
      if (request.user.role !== "company_admin" && !request.isSuperAdmin) {
        return reply.code(403).send({ error: "Admin access required" });
      }

      let query = `
            SELECT 
                v.id, v.plate_no, v.model, v.brand, v.year, v.status,
                v.current_fuel_level as fuel_level, v.total_km as odometer,
                d.license_no as driver_license, u.email as driver_email,
                l.latitude, l.longitude, l.speed, l.time as last_location_time,
                CASE WHEN dev.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online
            FROM vehicles v
            LEFT JOIN drivers d ON v.id = d.assigned_vehicle_id
            LEFT JOIN users u ON d.user_id = u.id
            LEFT JOIN devices dev ON dev.esp_chip_id = v.esp32_device_id OR dev.serial = v.esp32_device_id OR dev.device_code = v.esp32_device_id
            LEFT JOIN LATERAL (
                SELECT * FROM locations 
                WHERE device_id = v.esp32_device_id 
                ORDER BY time DESC 
                LIMIT 1
            ) l ON true
        `;

      let params = [];

      if (!request.isSuperAdmin || request.companyId) {
        query += ` WHERE v.company_id = $1`;
        params.push(request.companyId);
      }

      query += ` ORDER BY v.plate_no`;

      const { rows } = await client.query(query, params);

      return { vehicles: rows };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.get(
  "/api/admin/activities",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      if (request.user.role !== "company_admin" && !request.isSuperAdmin) {
        return reply.code(403).send({ error: "Admin access required" });
      }

      const hasCompanyFilter = !request.isSuperAdmin || request.companyId;
      const taskCompanyCondition = hasCompanyFilter
        ? "AND t.company_id = $1"
        : "";
      const alertCompanyCondition = hasCompanyFilter
        ? "AND a.company_id = $1"
        : "";
      const params = hasCompanyFilter ? [request.companyId] : [];

      const { rows } = await client.query(
        `
        SELECT
            'task' as activity_type,
            t.id::text as id,
            t.task_no as identifier,
            t.status,
            t.created_at as timestamp,
            u.email as user_email,
            v.plate_no as vehicle_plate,
            NULL::text as severity
        FROM tasks t
        LEFT JOIN drivers d ON t.driver_id = d.id
        LEFT JOIN users u ON d.user_id = u.id
        LEFT JOIN vehicles v ON t.vehicle_id = v.id
        WHERE t.created_at > NOW() - INTERVAL '24 hours' ${taskCompanyCondition}

        UNION ALL

        SELECT
            'alert' as activity_type,
            a.id::text as id,
            a.alert_type as identifier,
            a.severity as status,
            a.created_at as timestamp,
            NULL as user_email,
            a.device_id as vehicle_plate,
            a.severity as severity
        FROM alerts a
        WHERE a.created_at > NOW() - INTERVAL '24 hours' ${alertCompanyCondition}

        UNION ALL

        SELECT
            'delay' as activity_type,
            te.id::text as id,
            'STOP_DELAYED' as identifier,
            'warning' as status,
            te.created_at as timestamp,
            u.email as user_email,
            v.plate_no as vehicle_plate,
            'warning' as severity
        FROM task_events te
        JOIN tasks t ON t.id::text = te.task_id
        LEFT JOIN drivers d ON t.driver_id = d.id
        LEFT JOIN users u ON d.user_id = u.id
        LEFT JOIN vehicles v ON t.vehicle_id = v.id
        WHERE te.type = 'STOP_DELAYED'
          AND te.created_at > NOW() - INTERVAL '24 hours'
          ${hasCompanyFilter ? "AND t.company_id = $1" : ""}

        ORDER BY timestamp DESC
        LIMIT 20
      `,
        params
      );

      return { activities: rows };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// VEHICLES
// ============================================

fastify.get(
  "/api/vehicles",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();

    try {
      const filters = fastify.tenantFilter(request);

      const where = [];
      const params = [];

      if (filters.company_id) {
        where.push(`v.company_id = $${params.length + 1}`);
        params.push(filters.company_id);
      }

      const query = `
      SELECT 
        v.*, d.license_no as driver_license, u.email as driver_email,
        loc.latitude, loc.longitude, loc.speed, loc.heading, loc.time as last_location_time,
        (SELECT COUNT(*) FROM tasks t WHERE t.vehicle_id = v.id AND t.status = 'in_progress') as active_task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.vehicle_id = v.id AND t.status IN ('pending', 'in_progress')) as pending_task_count
      FROM vehicles v
      LEFT JOIN drivers d ON v.id = d.assigned_vehicle_id AND d.company_id = v.company_id
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT latitude, longitude, speed, heading, time
        FROM locations
        WHERE device_id = v.esp32_device_id
        ORDER BY time DESC
        LIMIT 1
      ) loc ON true
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY v.plate_no
    `;

      const { rows } = await client.query(query, params);

      const vehiclesWithBusy = rows.map((vehicle) => ({
        ...vehicle,
        is_busy: parseInt(vehicle.active_task_count, 10) > 0,
        has_pending: parseInt(vehicle.pending_task_count, 10) > 0,
      }));

      return { vehicles: vehiclesWithBusy };
    } catch (err) {
      request.log.error({ err }, "failed to fetch vehicles");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.post(
  "/api/vehicles",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { plate_no, esp32_device_id, model, brand, year, fuel_type } =
      request.body;
    if (!plate_no || !esp32_device_id) {
      return reply
        .code(400)
        .send({ error: "plate_no and esp32_device_id required" });
    }

    // FEAT-020 Phase 1.1 bug fix (2026-10-14 gatekeeping bulgusu): bu
    // validasyon hic eklenmemisti -- asagidaki INSERT "capacity" degiskenini
    // kullaniyordu ama hicbir yerde tanimlanmamisti, bu yuzden POST
    // /api/vehicles HER cagrida ReferenceError ile 500 donuyordu (yeni arac
    // eklenemiyordu, ne mobil ne dispatcher). PUT /api/vehicles/:id'deki
    // ayni desen burada da uygulaniyor. CREATE oldugu icin PUT'taki
    // "body'de yoksa NULL gonder (COALESCE eski degeri korur)" triki
    // gerekmiyor -- yeni satirda korunacak eski deger yok, parseVehicleCapacityFields'in
    // varsayilanlari (volumeM3/weightKg null, hazmatClasses []) doğrudan kullanilir.
    const capacity = parseVehicleCapacityFields(request.body);
    if (!capacity.ok) {
      return reply.code(400).send({ error: capacity.error });
    }

    const companyId = request.companyId;
    if (!companyId && !request.isSuperAdmin) {
      return reply.code(400).send({ error: "Company context required" });
    }
    const client = await fastify.pg.connect();
    try {
      // TulipFleet Connect Tier A - "Plaka/Kota Korumasi" (Cem, 2026-10-11)
      if (companyId) {
        const quota = await checkVehicleQuota(client, companyId);
        if (!quota.allowed) {
          return reply.code(403).send({
            error: "quota_exceeded",
            message: `Vehicle quota reached (${quota.activeCount}/${quota.maxVehicles}). Request a quota increase via POST /api/subscription/requests.`,
            active_count: quota.activeCount,
            max_vehicles: quota.maxVehicles,
          });
        }
      }

      // Multi-tenant task code: CCC-YY-NNNNN
      const year = new Date().getFullYear() % 100; // 25

      // Get company code
      const { rows: companyRows } = await client.query(
        "SELECT code FROM companies WHERE id = $1",
        [request.companyId]
      );
      const companyCode = companyRows[0]?.code || "TLP";

      // Get and increment counter (with row lock)
      const { rows: counterRows } = await client.query(
        `
            INSERT INTO company_task_counters (company_id, year, last_number)
            VALUES ($1, $2, 1)
            ON CONFLICT (company_id, year) 
            DO UPDATE SET last_number = company_task_counters.last_number + 1, updated_at = NOW()
            RETURNING last_number
        `,
        [request.companyId, 2000 + year]
      );

      const taskNumber = counterRows[0].last_number;
      const task_code = `${companyCode}-${year}-${String(taskNumber).padStart(
        5,
        "0"
      )}`;

      const { rows } = await client.query(
        `
            INSERT INTO vehicles (plate_no, esp32_device_id, model, brand, year, fuel_type, status, company_id, cargo_capacity_volume_m3, cargo_capacity_weight_kg, hazmat_certified_classes)
            VALUES ($1, $2, $3, $4, $5, $6, 'available', $7, $8, $9, $10)
            RETURNING *
        `,
        [
          plate_no,
          esp32_device_id,
          model,
          brand,
          year,
          fuel_type,
          companyId,
          capacity.volumeM3,
          capacity.weightKg,
          capacity.hazmatClasses,
        ]
      );

      return reply.code(201).send({ vehicle: rows[0] });
    } catch (err) {
      if (err.code === "23505") {
        return reply.code(409).send({ error: "Vehicle exists" });
      }
      throw err;
    } finally {
      client.release();
    }
  }
);

fastify.put(
  "/api/vehicles/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { plate_no, esp32_device_id, model, brand, year, fuel_type, status } =
      request.body;

    const companyId = request.companyId;
    if (!companyId && !request.isSuperAdmin) {
      return reply.code(400).send({ error: "Company context required" });
    }

    // FEAT-020 Phase 1.1 (2026-10-12): bkz. POST /api/vehicles ustundeki not.
    // hazmat_certified_classes icin COALESCE'a dogrudan capacity.hazmatClasses
    // VERILMEZ: alan hic gonderilmediginde parseVehicleCapacityFields bos []
    // doner (talep tarafiyla simetrik varsayilan), ama COALESCE'ta [] NULL
    // DEGILDIR ve mevcut veriyi her partial PUT'ta sessizce siler. Bu yuzden
    // alan body'de YOKSA SQL'e NULL gonderilir (COALESCE eski degeri korur);
    // VARSA (bos array dahil, bilerek temizleme) capacity.hazmatClasses gider.
    const capacity = parseVehicleCapacityFields(request.body);
    if (!capacity.ok) {
      return reply.code(400).send({ error: capacity.error });
    }
    const hazmatClassesParam =
      request.body.hazmat_certified_classes !== undefined ? capacity.hazmatClasses : null;

    const client = await fastify.pg.connect();
    try {
      const { rows: existing } = await client.query(
        "SELECT id FROM vehicles WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Vehicle not found" });
      }

      const { rows } = await client.query(
        `
      UPDATE vehicles
      SET plate_no = COALESCE($1, plate_no),
          esp32_device_id = COALESCE($2, esp32_device_id),
          model = COALESCE($3, model),
          brand = COALESCE($4, brand),
          year = COALESCE($5, year),
          fuel_type = COALESCE($6, fuel_type),
          status = COALESCE($7, status),
          cargo_capacity_volume_m3 = COALESCE($8, cargo_capacity_volume_m3),
          cargo_capacity_weight_kg = COALESCE($9, cargo_capacity_weight_kg),
          hazmat_certified_classes = COALESCE($10::text[], hazmat_certified_classes)
      WHERE id = $11 AND company_id = $12
      RETURNING *
    `,
        [
          plate_no,
          esp32_device_id,
          model,
          brand,
          year,
          fuel_type,
          status,
          capacity.volumeM3,
          capacity.weightKg,
          hazmatClassesParam,
          id,
          companyId,
        ]
      );

      return { vehicle: rows[0] };
    } catch (err) {
      if (err.code === "23505") {
        return reply.code(409).send({ error: "Plate number already exists" });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update vehicle" });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/vehicles/:id - Araç sil
fastify.delete(
  "/api/vehicles/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;

    const client = await fastify.pg.connect();
    try {
      // Check if vehicle exists and belongs to company
      const { rows: existing } = await client.query(
        "SELECT id FROM vehicles WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Vehicle not found" });
      }

      // Check if vehicle has active tasks
      const { rows: activeTasks } = await client.query(
        `SELECT id FROM tasks WHERE vehicle_id = $1 AND status IN ('assigned', 'in_progress')`,
        [id]
      );

      if (activeTasks.length > 0) {
        return reply.code(400).send({
          error:
            "Bu araca atanmış aktif görevler var. Önce görevleri tamamlayın veya iptal edin.",
        });
      }

      // === devices.vehicle_id FK üzerinden bağlı cihaz kontrolü ===
      // idx_devices_vehicle indexini kullanır, JOIN gereksiz.
      // Sadece ASSIGNED ve ACTIVATED gerçek araç bağlılığı sayılır;
      // pending/CREATED/PRINTED/IN_STOCK aşamasındaki cihazlar block etmez.
      const { rows: attachedDevices } = await client.query(
        `SELECT serial, esp_chip_id, status
          FROM devices
          WHERE vehicle_id = $1
            AND status IN ('ASSIGNED', 'ACTIVATED')
          LIMIT 1`,
        [id]
      );

      if (attachedDevices.length > 0) {
        return reply.code(409).send({
          error:
            "Bu araçta bağlı bir cihaz var. Silmeden önce cihazı araçtan ayırın.",
          code: "DEVICE_ATTACHED",
          deviceSerial: attachedDevices[0].serial,
        });
      }
      // === /devices.vehicle_id FK üzerinden ===

      // Remove vehicle assignment from drivers
      await client.query(
        "UPDATE drivers SET assigned_vehicle_id = NULL WHERE assigned_vehicle_id = $1",
        [id]
      );

      await client.query("DELETE FROM vehicles WHERE id = $1", [id]);

      return { success: true, message: "Vehicle deleted successfully" };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to delete vehicle" });
    } finally {
      client.release();
    }
  }
);

// GET /api/vehicles/:id/location - Tek araç son konum (ESP32'den)
fastify.get(
  "/api/vehicles/:id/location",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const client = await fastify.pg.connect();
    try {
      const result = await client.query(
        `
      SELECT l.latitude, l.longitude, l.speed, l.heading, l.time, l.accuracy, l.satellite_count
      FROM locations l
      JOIN vehicles v ON l.device_id = v.esp32_device_id
      WHERE v.id = $1
      ORDER BY l.time DESC
      LIMIT 1
    `,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: "No location data",
          message: "ESP32 henuz konum gondermedi",
        });
      }
      return result.rows[0];
    } finally {
      client.release();
    }
  }
);

// GET /api/vehicles/:id/locations - Araç geçmiş rotası (history)
fastify.get(
  "/api/vehicles/:id/locations",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { start, end, limit } = request.query;
    const client = await fastify.pg.connect();

    try {
      // §9.7: fetchVehicleTrack DESC+LIMIT ile en SON N noktayı garanti
      // alıp ASC'ye çevirir — rotanın bitişi (güncel kısmı) her zaman
      // korunur (bkz. routes/vehicleTrackHelpers.js üstteki yorum).
      return await fetchVehicleTrack(client, { vehicleId: id, start, end, limit });
    } finally {
      client.release();
    }
  }
);

// ============================================
// DEVICE COMMAND ENDPOINT
// ============================================

// POST /api/devices/:id/command - Cihaza uzaktan komut gönder
fastify.post(
  "/api/devices/:id/command",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { id } = request.params;
    const { command } = request.body;

    const validCommands = [
      "RESET",
      "REBOOT",
      "STATUS",
      "CLEAR_WIFI",
      "RECALIBRATE",
    ];
    if (!validCommands.includes(command)) {
      return reply.code(400).send({ error: "Geçersiz komut", validCommands });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        "SELECT serial, esp_chip_id FROM devices WHERE id = $1",
        [id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: "Cihaz bulunamadı" });
      }

      const serialNo = rows[0].serial;
      const espChipId = rows[0].esp_chip_id;

      if (!espChipId) {
        return reply.code(400).send({ error: "Chip ID bilgisi yok" });
      }

      // DUZELTME 17 Eki 2026: Eski kod yanlis topic'e (fleet/truck/{serial}/command)
      // ve firmware'in tanimadigi komut string'lerine yaziyordu — hicbir komut
      // cihaza ulasmiyordu. Firmware sadece fleet/device/{espChipId}/commands
      // topic'ini dinliyor ve mesaj govdesinde "RESET_PROVISION" alt-string'ini
      // ariyor (bkz. fleet_tracker_v5_0_4.ino, MQTT command handler). CLEAR_WIFI
      // butonunun gercek anlami budur: NVS temizle, BLE moduna don.
      const firmwareCommand =
        command === "CLEAR_WIFI" || command === "RESET"
          ? "RESET_PROVISION"
          : command;

      const topic = `fleet/device/${espChipId}/commands`;
      const payload = JSON.stringify({ command: firmwareCommand });

      try {
        await new Promise((resolve, reject) => {
          mqttClient.publish(topic, payload, { qos: 1 }, (err) =>
            err ? reject(err) : resolve()
          );
        });
        console.log(`[CMD] Sent ${command} (${firmwareCommand}) to ${serialNo} (${espChipId})`);
        return {
          success: true,
          mqtt_sent: true,
          message: `${command} komutu gönderildi`,
          device: serialNo,
        };
      } catch (mqttErr) {
        console.warn(`[CMD] MQTT publish failed for ${serialNo}:`, mqttErr.message);
        return reply.send({
          success: false,
          mqtt_sent: false,
          message: "Cihaz offline, BLE ile reprovision yapin",
        });
      }
    } finally {
      client.release();
    }
  }
);

// ============================================
// REPORTS ENDPOINTS
// ============================================

// GET /api/reports/vehicles - Araç raporu (görev ve uyarı sayılarıyla)
fastify.get(
  "/api/reports/vehicles",
  { preHandler: [fastify.authenticate] },
  async (request) => {
    const client = await fastify.pg.connect();
    try {
      const companyId = request.companyId;
      const { rows } = await client.query(
        `
            SELECT 
                v.*,
                COALESCE(t.total_tasks, 0)::int as total_tasks,
                COALESCE(t.completed_tasks, 0)::int as completed_tasks,
                COALESCE(a.total_alerts, 0)::int as total_alerts
            FROM vehicles v
            LEFT JOIN (
                SELECT vehicle_id, 
                       COUNT(*) as total_tasks,
                       COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks
                FROM tasks
                GROUP BY vehicle_id
            ) t ON v.id = t.vehicle_id
            LEFT JOIN (
                SELECT device_id, COUNT(*) as total_alerts
                FROM alerts
                GROUP BY device_id
            ) a ON v.esp32_device_id = a.device_id
            WHERE v.company_id = $1
            ORDER BY v.plate_no
        `,
        [companyId]
      );
      return { vehicles: rows };
    } finally {
      client.release();
    }
  }
);

// GET /api/reports/drivers - Sürücü raporu
fastify.get(
  "/api/reports/drivers",
  { preHandler: [fastify.authenticate] },
  async (request) => {
    const client = await fastify.pg.connect();
    try {
      const companyId = request.companyId;
      const { rows } = await client.query(
        `
            SELECT 
                d.*,
                u.first_name,
                u.last_name,
                u.email,
                COALESCE(t.total_tasks, 0)::int as total_tasks,
                COALESCE(t.completed_tasks, 0)::int as completed_tasks,
                v.plate_no as vehicle_plate
            FROM drivers d
            LEFT JOIN users u ON d.user_id = u.id
            LEFT JOIN vehicles v ON d.assigned_vehicle_id = v.id
            LEFT JOIN (
                SELECT driver_id,
                       COUNT(*) as total_tasks,
                       COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks
                FROM tasks
                GROUP BY driver_id
            ) t ON d.id = t.driver_id
            WHERE d.company_id = $1
            ORDER BY u.first_name
        `,
        [companyId]
      );
      return { drivers: rows };
    } finally {
      client.release();
    }
  }
);

// ============================================
// ALERTS
// ============================================

fastify.get(
  "/api/alerts",
  { preHandler: [fastify.authenticate] },
  async (request) => {
    const client = await fastify.pg.connect();
    try {
      const hasCompanyFilter = !request.isSuperAdmin || request.companyId;
      const companyCondition = hasCompanyFilter ? "WHERE company_id = $1" : "";
      const params = hasCompanyFilter ? [request.companyId] : [];

      const { rows } = await client.query(
        `
            SELECT 
                a.*,
                v.plate_no as vehicle_plate,
                COALESCE(u.first_name || ' ' || u.last_name, 'Atanmamış') as driver_name
            FROM alerts a
            LEFT JOIN vehicles v ON a.device_id = v.esp32_device_id
            LEFT JOIN drivers d ON v.id = d.assigned_vehicle_id
            LEFT JOIN users u ON d.user_id = u.id
            ${companyCondition.replace("WHERE", "WHERE a.")}
            ORDER BY a.created_at DESC
            LIMIT 50
        `,
        params
      );
      return { alerts: rows };
    } finally {
      client.release();
    }
  }
);

// PUT /api/alerts/:id/resolve - Uyarı çözümle
fastify.put(
  "/api/alerts/:id/resolve",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;
    const userId = request.user.id;

    const client = await fastify.pg.connect();
    try {
      // Verify alert belongs to company
      const { rows: existing } = await client.query(
        "SELECT id, is_resolved FROM alerts WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Alert not found" });
      }

      if (existing[0].is_resolved) {
        return reply.code(400).send({ error: "Alert already resolved" });
      }

      const { rows } = await client.query(
        `
            UPDATE alerts 
            SET is_resolved = true,
                resolved_at = NOW(),
                resolved_by = $1
            WHERE id = $2 AND company_id = $3
            RETURNING *
        `,
        [userId, id, companyId]
      );

      return { success: true, alert: rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to resolve alert" });
    } finally {
      client.release();
    }
  }
);

// POST /api/alerts/:id/ack - Uyarıyı onayla (dispatcher "Onayla" aksiyonu)
fastify.post(
  "/api/alerts/:id/ack",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;
    const userId = request.user.id;

    const client = await fastify.pg.connect();
    try {
      const result = await acknowledgeAlert(client, {
        alertId: id,
        companyId,
        userId,
      });

      if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({ error: "Alert not found" });
      }
      if (!result.ok && result.reason === "already_acknowledged") {
        return reply.code(400).send({ error: "Alert already acknowledged" });
      }

      return { success: true, alert: result.alert };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to acknowledge alert" });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/alerts - Tüm uyarıları sil (company bazlı)
fastify.delete(
  "/api/alerts",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const user = request.user;
      let query = "DELETE FROM alerts";
      let params = [];
      if (user.role === "company_admin") {
        query += " WHERE company_id = $1";
        params = [user.company_id];
      } else if (user.role !== "super_admin") {
        return reply.status(403).send({ error: "Yetkiniz yok" });
      }
      const result = await client.query(query, params);
      return { success: true, deleted: result.rowCount };
    } finally {
      client.release();
    }
  }
);
// DELETE /api/alerts/:id - Uyarı sil
fastify.delete(
  "/api/alerts/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;

    const client = await fastify.pg.connect();
    try {
      const { rows: existing } = await client.query(
        "SELECT id FROM alerts WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Alert not found" });
      }

      await client.query("DELETE FROM alerts WHERE id = $1", [id]);

      return { success: true, message: "Alert deleted successfully" };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to delete alert" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// DRIVERS
// ============================================

fastify.get(
  "/api/drivers",
  { preHandler: [fastify.authenticate] },
  async (request) => {
    const client = await fastify.pg.connect();
    try {
      const hasCompanyFilter = !request.isSuperAdmin || request.companyId;
      const companyCondition = hasCompanyFilter
        ? "WHERE d.company_id = $1"
        : "";
      const params = hasCompanyFilter ? [request.companyId] : [];

      const { rows } = await client.query(
        `
            SELECT d.*, u.email, u.language, u.first_name, u.last_name,
                   (SELECT COUNT(*) FROM tasks t WHERE t.driver_id = d.id AND t.status = 'in_progress') as active_task_count,
                   (SELECT COUNT(*) FROM tasks t WHERE t.driver_id = d.id AND t.status IN ('pending', 'in_progress')) as pending_task_count
            FROM drivers d 
            JOIN users u ON d.user_id = u.id 
            ${companyCondition}
            ORDER BY d.license_no
        `,
        params
      );

      const driversWithBusy = rows.map((driver) => ({
        ...driver,
        is_busy: parseInt(driver.active_task_count, 10) > 0,
        has_pending: parseInt(driver.pending_task_count, 10) > 0,
      }));

      return { drivers: driversWithBusy };
    } finally {
      client.release();
    }
  }
);

fastify.post(
  "/api/drivers",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { user_id, license_no, license_expiry, phone, emergency_contact } =
      request.body;

    if (!user_id || !license_no || !license_expiry) {
      return reply
        .code(400)
        .send({ error: "user_id, license_no, license_expiry required" });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `
            INSERT INTO drivers (user_id, license_no, license_expiry, phone, emergency_contact, status, company_id) 
            VALUES ($1, $2, $3, $4, $5, 'available', $6) 
            RETURNING *
        `,
        [
          user_id,
          license_no,
          license_expiry,
          phone,
          emergency_contact,
          request.companyId,
        ]
      );

      return reply.code(201).send({ driver: rows[0] });
    } catch (err) {
      if (err.code === "23505") {
        return reply.code(409).send({ error: "Driver exists" });
      }
      throw err;
    } finally {
      client.release();
    }
  }
);

fastify.post(
  "/api/drivers/create-with-user",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const {
      email,
      password,
      first_name,
      last_name,
      phone,
      license_no,
      license_expiry,
      emergency_contact,
    } = request.body;

    if (!email || !password || !license_no) {
      return reply
        .code(400)
        .send({ error: "email, password, license_no required" });
    }

    const companyId = request.companyId;
    if (!companyId && !request.isSuperAdmin) {
      return reply.code(400).send({ error: "Company context required" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");

      const hashedPassword = await bcrypt.hash(password, 10);
      const { rows: userRows } = await client.query(
        `
      INSERT INTO users (email, password_hash, role, company_id, first_name, last_name, phone)
      VALUES ($1, $2, 'driver', $3, $4, $5, $6)
      RETURNING id, email, first_name, last_name, phone
    `,
        [email, hashedPassword, companyId, first_name, last_name, phone]
      );

      const user = userRows[0];

      const { rows: driverRows } = await client.query(
        `
      INSERT INTO drivers (user_id, license_no, license_expiry, phone, emergency_contact, status, company_id)
      VALUES ($1, $2, $3, $4, $5, 'available', $6)
      RETURNING *
    `,
        [
          user.id,
          license_no,
          license_expiry || null,
          phone,
          emergency_contact,
          companyId,
        ]
      );

      await client.query("COMMIT");

      return reply.code(201).send({
        user: user,
        driver: driverRows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "23505") {
        if (err.constraint?.includes("email")) {
          return reply.code(409).send({ error: "Email already exists" });
        }
        if (err.constraint?.includes("license")) {
          return reply
            .code(409)
            .send({ error: "License number already exists" });
        }
        return reply.code(409).send({ error: "Driver already exists" });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to create driver" });
    } finally {
      client.release();
    }
  }
);

fastify.put(
  "/api/drivers/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const {
      first_name,
      last_name,
      phone,
      license_no,
      license_expiry,
      emergency_contact,
      status,
    } = request.body;

    const companyId = request.companyId;

    const client = await fastify.pg.connect();
    try {
      const { rows: driverRows } = await client.query(
        "SELECT user_id FROM drivers WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (driverRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const userId = driverRows[0].user_id;

      await client.query("BEGIN");

      await client.query(
        `
      UPDATE users 
      SET first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          phone = COALESCE($3, phone)
      WHERE id = $4
    `,
        [first_name, last_name, phone, userId]
      );

      const { rows } = await client.query(
        `
      UPDATE drivers 
      SET license_no = COALESCE($1, license_no),
          license_expiry = $2,
          phone = COALESCE($3, phone),
          emergency_contact = COALESCE($4, emergency_contact),
          status = COALESCE($5, status)
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `,
        [
          license_no,
          license_expiry || null,
          phone,
          emergency_contact,
          status,
          id,
          companyId,
        ]
      );

      await client.query("COMMIT");

      return { driver: rows[0] };
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update driver" });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/drivers/:id - Sürücü sil
fastify.delete(
  "/api/drivers/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;

    const client = await fastify.pg.connect();
    try {
      // SEC: ownership first (cross-tenant oracle fix, 13.09.2026)
      const { rows: ownRows } = await client.query(
        "SELECT id FROM drivers WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );
      if (ownRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      // Check if driver has active tasks
      const { rows: activeTasks } = await client.query(
        `SELECT id FROM tasks WHERE driver_id = $1 AND status IN ('assigned', 'in_progress')`,
        [id]
      );

      if (activeTasks.length > 0) {
        return reply.code(400).send({
          error:
            "Bu sürücüye atanmış aktif görevler var. Önce görevleri tamamlayın veya iptal edin.",
        });
      }

      // Get driver info
      const { rows: driverRows } = await client.query(
        "SELECT user_id FROM drivers WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (driverRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const userId = driverRows[0].user_id;

      await client.query("BEGIN");

      // Delete driver
      await client.query("DELETE FROM drivers WHERE id = $1", [id]);

      // Delete user account
      await client.query("DELETE FROM users WHERE id = $1", [userId]);

      await client.query("COMMIT");

      return { success: true, message: "Driver deleted successfully" };
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to delete driver" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// TASKS
// ============================================

fastify.get(
  "/api/tasks",
  { preHandler: [fastify.authenticate] },
  async (request) => {
    const { status, driver_id } = request.query;
    const client = await fastify.pg.connect();
    try {
      const hasCompanyFilter = !request.isSuperAdmin || request.companyId;
      const params = [];

      let query = `
            SELECT t.*, 
                   d.license_no as driver_license, 
                   v.plate_no as vehicle_plate,
                   u.first_name as driver_first_name,
                   u.last_name as driver_last_name,
                   u.email as driver_email
            FROM tasks t
            LEFT JOIN drivers d ON t.driver_id = d.id
            LEFT JOIN users u ON d.user_id = u.id
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            WHERE 1=1
        `;

      if (hasCompanyFilter) {
        params.push(request.companyId);
        query += ` AND t.company_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        query += ` AND t.status = $${params.length}`;
      }
      if (driver_id) {
        params.push(driver_id);
        query += ` AND t.driver_id = $${params.length}`;
      }
      query += " ORDER BY t.created_at DESC LIMIT 50";
      const { rows } = await client.query(query, params);
      return { tasks: rows };
    } finally {
      client.release();
    }
  }
);
// ============================================
// GET /api/tasks/:id/events — Admin/Driver Task Events
// ============================================
fastify.get(
  "/api/tasks/:id/events",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        "SELECT id, company_id FROM drivers WHERE user_id = $1",
        [userId]
      );

      if (driverRows.length > 0) {
        // Driver: sadece kendi task'ının event'lerini görebilir
        const driverId = driverRows[0].id;
        const { rows: taskCheck } = await client.query(
          "SELECT id FROM tasks WHERE id = $1 AND driver_id = $2",
          [id, driverId]
        );
        if (!taskCheck.length)
          return reply.code(404).send({ error: "Task not found" });
      } else {
        // Admin: company_id kontrolü
        const companyId = request.companyId;
        const { rows: taskCheck } = await client.query(
          "SELECT id FROM tasks WHERE id = $1 AND company_id = $2",
          [id, companyId]
        );
        if (!taskCheck.length)
          return reply.code(404).send({ error: "Task not found" });
      }

      const { rows } = await client.query(
        `SELECT id, task_id, stop_id, leg_index, type, message,
              created_at, created_by_user_id, created_by_role
       FROM task_events
       WHERE task_id = $1
       ORDER BY created_at ASC
       LIMIT 500`,
        [String(id)]
      );

      return reply.send({ success: true, events: rows });
    } catch (err) {
      request.log.error({ err }, "failed to fetch task events");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /api/tasks/:id - Görev detayı (Driver için)
// ═══════════════════════════════════════════════════════════════
fastify.get(
  "/api/tasks/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      // Driver mı kontrol et
      const { rows: driverRows } = await client.query(
        "SELECT id, company_id FROM drivers WHERE user_id = $1",
        [userId]
      );

      let query, params;

      if (driverRows.length > 0) {
        // Driver: sadece kendi görevlerini görebilir
        const driverId = driverRows[0].id;
        query = `
        SELECT 
          t.*, 
          v.plate_no as vehicle_plate, v.brand as vehicle_brand, v.model as vehicle_model,
          u.first_name as driver_first_name, u.last_name as driver_last_name, u.email as driver_email
        FROM tasks t
        LEFT JOIN vehicles v ON t.vehicle_id = v.id
        LEFT JOIN drivers d ON t.driver_id = d.id
        LEFT JOIN users u ON d.user_id = u.id
        WHERE t.id = $1 AND t.driver_id = $2
      `;
        params = [id, driverId];
      } else {
        // Admin: company_id kontrolü
        const companyId = request.companyId;
        query = `
        SELECT 
          t.*, 
          v.plate_no as vehicle_plate, v.brand as vehicle_brand, v.model as vehicle_model,
          u.first_name as driver_first_name, u.last_name as driver_last_name, u.email as driver_email
        FROM tasks t
        LEFT JOIN vehicles v ON t.vehicle_id = v.id
        LEFT JOIN drivers d ON t.driver_id = d.id
        LEFT JOIN users u ON d.user_id = u.id
        WHERE t.id = $1 AND t.company_id = $2
      `;
        params = [id, companyId];
      }

      const { rows } = await client.query(query, params);

      if (rows.length === 0) {
        return reply.code(404).send({ error: "Task not found" });
      }

      const task = rows[0];

      return {
        task: {
          ...task,
          driver: task.driver_first_name
            ? {
                firstName: task.driver_first_name,
                lastName: task.driver_last_name,
                email: task.driver_email,
              }
            : null,
          vehicle: task.vehicle_plate
            ? {
                plate: task.vehicle_plate,
                brand: task.vehicle_brand,
                model: task.vehicle_model,
              }
            : null,
        },
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /api/tasks/:id/waypoint-summary - Waypoint Geofence Faz 1
// Read-only rollup: total/visited/bypassed/required-missed counts.
// ═══════════════════════════════════════════════════════════════
fastify.get(
  "/api/tasks/:id/waypoint-summary",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        "SELECT id FROM drivers WHERE user_id = $1",
        [userId]
      );

      let query, params;
      if (driverRows.length > 0) {
        query = "SELECT waypoints FROM tasks WHERE id = $1 AND driver_id = $2";
        params = [id, driverRows[0].id];
      } else {
        query = "SELECT waypoints FROM tasks WHERE id = $1 AND company_id = $2";
        params = [id, request.companyId];
      }

      const { rows } = await client.query(query, params);
      if (rows.length === 0) {
        return reply.code(404).send({ error: "Task not found" });
      }

      const waypoints = safeWaypoints(rows[0].waypoints);
      const total = waypoints.length;
      const visited = waypoints.filter((wp) => wp.visited === true).length;
      const bypassed = waypoints.filter(
        (wp) => wp.completion_reason === "route_bypass"
      ).length;
      const requiredMissed = waypoints.filter(
        (wp) => wp.required === true && wp.visited !== true && wp.completion_reason !== "route_bypass"
      ).length;

      return {
        task_id: id,
        total_waypoints: total,
        visited_count: visited,
        bypassed_count: bypassed,
        required_missed_count: requiredMissed,
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

fastify.post(
  "/api/tasks",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const {
      driver_id,
      vehicle_id,
      title,
      description,
      start_location,
      end_location,
      route_json,
      waypoints,
      scheduled_start,
      scheduled_end,
      priority,
    } = request.body;

    const hasDriver = driver_id != null && String(driver_id).trim() !== "";
    const hasVehicle = vehicle_id != null && String(vehicle_id).trim() !== "";
    if (!hasDriver && !hasVehicle) {
      return reply.code(400).send({
        error: "driver_or_vehicle_required",
        message: "At least one of driver_id or vehicle_id is required",
      });
    }

    const client = await fastify.pg.connect();
    try {
      // S5: Subscription status + waypoint tier limit check
      const { rows: tierRows } = await client.query(
        "SELECT subscription_tier, subscription_status FROM companies WHERE id = $1",
        [request.companyId]
      );
      const companyTier = tierRows[0]?.subscription_tier || "starter";
      const companyStatus = tierRows[0]?.subscription_status || "trial";
      const BLOCKED_STATUSES = ["suspended", "expired", "cancelled"];
      if (BLOCKED_STATUSES.includes(companyStatus)) {
        return reply.code(403).send({
          error: "subscription_inactive",
          message: `Your subscription is ${companyStatus}. Task creation is disabled.`,
          status: companyStatus,
        });
      }
      if (Array.isArray(waypoints) && waypoints.length > 0) {
        const TIER_MAX_STOPS = {
          starter: 3,
          professional: 10,
          enterprise: 25,
          custom: 25,
        };
        const maxStops = TIER_MAX_STOPS[companyTier] || 3;
        if (waypoints.length > maxStops) {
          return reply.code(403).send({
            error: "waypoint_limit_exceeded",
            message: `${companyTier} plan allows max ${maxStops} stops. You sent ${waypoints.length}.`,
            maxStops,
            tier: companyTier,
          });
        }
      }

      // BUG-1 Faz B-mobil (2026-08-02): zaman penceresi çakışma denetimi.
      // Mobil admin kanalı SERT 409 — override YOKTUR (Spec v3 §B kanal ayrımı).
      // Yalnız vehicle_id + her iki pencere doluysa koşulur (karar 2b: NULL muaf).
      // Numaratörden ÖNCE koşulur — 409'da task_no sayacı yanmaz.
      if (hasVehicle && scheduled_start && scheduled_end) {
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
          return reply.code(409).send({
            error: "Conflict",
            message: `Bu araca belirtilen aralıkta atanmış görev var (${confRows[0].task_no}, çakışma ~${confRows[0].overlap_minutes} dk).`,
            conflict_metadata: {
              conflicting_task_no: confRows[0].task_no,
              overlap_minutes: confRows[0].overlap_minutes,
            },
          });
        }
      }

      // Multi-tenant task code: CCC-YY-NNNNN
      const year = new Date().getFullYear() % 100; // 25

      // Get company code
      const { rows: companyRows } = await client.query(
        "SELECT code FROM companies WHERE id = $1",
        [request.companyId]
      );
      const companyCode = companyRows[0]?.code || "TLP";

      // Get and increment counter (with row lock)
      const { rows: counterRows } = await client.query(
        `
            INSERT INTO company_task_counters (company_id, year, last_number)
            VALUES ($1, $2, 1)
            ON CONFLICT (company_id, year) 
            DO UPDATE SET last_number = company_task_counters.last_number + 1, updated_at = NOW()
            RETURNING last_number
        `,
        [request.companyId, 2000 + year]
      );

      const taskNumber = counterRows[0].last_number;
      const task_code = `${companyCode}-${year}-${String(taskNumber).padStart(
        5,
        "0"
      )}`;

      // Server-side geocoding for waypoints
      const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
      let geocodedWaypoints = Array.isArray(waypoints) ? waypoints : [];
      if (!GMAPS_KEY) {
        request.log.warn(
          "GOOGLE_MAPS_API_KEY missing; skipping waypoint geocoding"
        );
      } else {
        for (let i = 0; i < geocodedWaypoints.length; i++) {
          const wp = geocodedWaypoints[i];
          const hasLat = wp.latitude !== null && wp.latitude !== undefined;
          const hasLng = wp.longitude !== null && wp.longitude !== undefined;
          if (hasLat && hasLng) continue;
          const addr = wp.address || wp.name;
          if (!addr) continue;
          try {
            const geoRes = await fetch(
              `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
                addr
              )}&key=${GMAPS_KEY}&language=tr&region=tr`
            );
            const geoData = await geoRes.json();
            if (
              geoData.status === "OK" &&
              geoData.results?.[0]?.geometry?.location
            ) {
              geocodedWaypoints[i] = {
                ...wp,
                latitude: geoData.results[0].geometry.location.lat,
                longitude: geoData.results[0].geometry.location.lng,
              };
            }
          } catch (e) {
            request.log.error({ err: e }, "geocoding failed for: " + addr);
          }
        }
      }

      const { rows } = await client.query(
        `
          INSERT INTO tasks (task_no, driver_id, vehicle_id, title, description, start_location, end_location, route_json, waypoints, scheduled_start, scheduled_end, priority, created_by, status, company_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending_review', $14)
            RETURNING *
        `,
        [
          task_code,
          driver_id,
          vehicle_id,
          title || null,
          description || null,
          start_location || null,
          end_location || null,
          route_json ? JSON.stringify(route_json) : null,
          geocodedWaypoints.length > 0
            ? JSON.stringify(geocodedWaypoints)
            : null,
          scheduled_start || null,
          scheduled_end || null,
          priority || "normal",
          request.user.id,
          request.companyId,
        ]
      );

      return reply.code(201).send({ task: rows[0] });
    } finally {
      client.release();
    }
  }
);

fastify.put(
  "/api/tasks/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const {
      driver_id,
      vehicle_id,
      title,
      description,
      start_location,
      end_location,
      waypoints,
      scheduled_start,
      scheduled_end,
      priority,
      status,
    } = request.body;
    const companyId = request.companyId;
    const client = await fastify.pg.connect();
    try {
      // S5: Subscription status + waypoint tier limit check
      const { rows: tierRows } = await client.query(
        "SELECT subscription_tier, subscription_status FROM companies WHERE id = $1",
        [companyId]
      );
      const companyTier = tierRows[0]?.subscription_tier || "starter";
      const companyStatus = tierRows[0]?.subscription_status || "trial";
      const BLOCKED_STATUSES = ["suspended", "expired", "cancelled"];
      if (BLOCKED_STATUSES.includes(companyStatus)) {
        return reply.code(403).send({
          error: "subscription_inactive",
          message: `Your subscription is ${companyStatus}. Task creation is disabled.`,
          status: companyStatus,
        });
      }
      if (Array.isArray(waypoints) && waypoints.length > 0) {
        const TIER_MAX_STOPS = {
          starter: 3,
          professional: 10,
          enterprise: 25,
          custom: 25,
        };
        const maxStops = TIER_MAX_STOPS[companyTier] || 3;
        if (waypoints.length > maxStops) {
          return reply.code(403).send({
            error: "waypoint_limit_exceeded",
            message: `${companyTier} plan allows max ${maxStops} stops. You sent ${waypoints.length}.`,
            maxStops,
            tier: companyTier,
          });
        }
      }

      const { rows: existing } = await client.query(
        // BUG-1 Faz B-mobil: efektif araç hesabı için vehicle_id de çekilir
        "SELECT id, vehicle_id FROM tasks WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );
      if (existing.length === 0) {
        return reply.code(404).send({ error: "Task not found" });
      }
      // BUG-1 Faz B-mobil (2026-08-02): UPDATE kanalında da SERT 409, override yok.
      // Efektif değerler: araç = body ?? mevcut (COALESCE), pencereler = body
      // değeri (düz SET — koddan kanıtlı). Kendisi hariç (id <> $4).
      {
        const effVehicleId =
          vehicle_id != null && String(vehicle_id).trim() !== ""
            ? vehicle_id
            : existing[0].vehicle_id;
        const effStart = scheduled_start || null;
        const effEnd = scheduled_end || null;
        if (effVehicleId && effStart && effEnd) {
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
             AND id <> $4
             ORDER BY scheduled_start ASC
             LIMIT 1`,
            [effVehicleId, effStart, effEnd, id]
          );
          if (confRows.length > 0) {
            return reply.code(409).send({
              error: "Conflict",
              message: `Bu araca belirtilen aralıkta atanmış görev var (${confRows[0].task_no}, çakışma ~${confRows[0].overlap_minutes} dk).`,
              conflict_metadata: {
                conflicting_task_no: confRows[0].task_no,
                overlap_minutes: confRows[0].overlap_minutes,
              },
            });
          }
        }
      }

      const wpJson = Array.isArray(waypoints)
        ? JSON.stringify(waypoints)
        : null;
      const { rows } = await client.query(
        `
            UPDATE tasks
            SET driver_id = COALESCE($1, driver_id),
                vehicle_id = COALESCE($2, vehicle_id),
                title = COALESCE($3, title),
                description = COALESCE($4, description),
                start_location = COALESCE($5, start_location),
                end_location = COALESCE($6, end_location),
                waypoints = COALESCE($7, waypoints),
                scheduled_start = $8,
                scheduled_end = $9,
                priority = COALESCE($10, priority),
                status = COALESCE($11, status),
                updated_at = NOW()
            WHERE id = $12 AND company_id = $13
            RETURNING *
        `,
        [
          driver_id,
          vehicle_id,
          title,
          description,
          start_location,
          end_location,
          wpJson,
          scheduled_start || null,
          scheduled_end || null,
          priority,
          status,
          id,
          companyId,
        ]
      );
      if (
        rows[0] &&
        PUBLIC_TRACK_CLOSED.has(String(rows[0].status || "").toLowerCase())
      ) {
        await revokePublicTrackingBestEffort(client, id, request.log);
      }
      return { task: rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update task" });
    } finally {
      client.release();
    }
  }
);

// POST /api/tasks/:id/offer - Görevi sürücüye gönder
fastify.post(
  "/api/tasks/:id/offer",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { driver_id } = request.body || {};
    const companyId = request.companyId;
    const client = await fastify.pg.connect();

    try {
      await client.query("BEGIN");

      const { rows: taskRows } = await client.query(
        "SELECT id, status, driver_id, task_no, title FROM tasks WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (!taskRows.length) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }

      const task = taskRows[0];
      const targetDriverId = driver_id || task.driver_id;
      if (!targetDriverId) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "No driver assigned" });
      }

      // Task status güncelle
      await client.query(
        "UPDATE tasks SET driver_id = $1, status = $2, updated_at = NOW() WHERE id = $3",
        [targetDriverId, "pending_review", id]
      );

      // Driver status güncelle
      await client.query("UPDATE drivers SET status = $1 WHERE id = $2", [
        "task_pending",
        targetDriverId,
      ]);

      // Alert oluştur
      await client.query(
        "INSERT INTO alerts (company_id, alert_type, severity, task_id, title, description) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          companyId,
          "task_offered",
          "info",
          id,
          "Görev Teklifi",
          "Görev teklif edildi: " + (task.task_no || task.title),
        ]
      );

      // Task event ekle
      await insertTaskEventTx(client, {
        taskId: id,
        type: "TASK_OFFERED",
        message: "Görev sürücüye teklif edildi",
        createdByUserId: request.user.id,
        createdByRole: request.user.role || "company_admin",
      });

      await client.query("COMMIT");

      return reply.send({
        success: true,
        message: "Task offered to driver",
        task_no: task.task_no,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to offer task" });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/tasks/:id - Görev sil
fastify.delete(
  "/api/tasks/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const companyId = request.companyId;

    const client = await fastify.pg.connect();
    try {
      // Verify task belongs to company
      const { rows: existing } = await client.query(
        "SELECT id, status, driver_id, vehicle_id FROM tasks WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Task not found" });
      }

      const task = existing[0];

      // If task is in_progress, free up driver and vehicle first
      if (task.status === "in_progress") {
        await client.query(
          "UPDATE drivers SET status = $1, assigned_vehicle_id = NULL WHERE id = $2",
          ["available", task.driver_id]
        );
        await client.query("UPDATE vehicles SET status = $1 WHERE id = $2", [
          "available",
          task.vehicle_id,
        ]);
      }

      await client.query("DELETE FROM tasks WHERE id = $1", [id]);

      return { success: true, message: "Task deleted successfully" };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to delete task" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// START SERVER
// ============================================

// ============================================================
// ============================================================
// MVP DEVICE PROVISIONING ENDPOINTS
// Tarih: 2026-01-05
// Not: vehicles.reprovision_required migration uygulanmış varsayılır
// ============================================================
// ============================================================

// ============================================================
// 1. DRIVER: ASSIGNED DEVICE
// GET /api/drivers/me/assigned-device
// Zincir: user_id → drivers → vehicles → devices
// FIX: assigned_vehicle_id var ama tenant join başarısızsa 404
// ============================================================
fastify.get(
  "/api/drivers/me/assigned-device",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "driver") {
      return reply.code(403).send({ error: "Forbidden - Driver only" });
    }

    const userId = request.user.id;
    const client = await fastify.pg.connect();

    try {
      const { rows: driverRows } = await client.query(
        `
      SELECT 
        dr.id as driver_id,
        dr.assigned_vehicle_id,
        dr.company_id,
        v.id as vehicle_id,
        v.plate_no,
        v.esp32_device_id,
        v.reprovision_required
      FROM drivers dr
      LEFT JOIN vehicles v ON v.id = dr.assigned_vehicle_id 
                          AND v.company_id = dr.company_id
      WHERE dr.user_id = $1
      LIMIT 1
    `,
        [userId]
      );

      if (!driverRows.length) {
        return reply.code(404).send({ error: "Driver profile not found" });
      }

      const driver = driverRows[0];

      // Araç atanmamış
      if (!driver.assigned_vehicle_id) {
        return reply.send({
          success: true,
          has_vehicle: false,
          has_device: false,
          setup_required: false,
          vehicle: null,
          device: null,
        });
      }

      // FIX: assigned_vehicle_id var ama tenant join yüzünden vehicle null ise
      if (driver.assigned_vehicle_id && !driver.vehicle_id) {
        return reply
          .code(404)
          .send({ error: "Assigned vehicle not found (tenant mismatch)" });
      }

      const { rows: deviceRows } = await client.query(
        `
      SELECT 
        d.id,
        d.device_code,
        d.serial,
        d.serial_number,
        d.mac_address,
        d.status,
        CASE WHEN d.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online,
        d.last_seen_at,
        d.firmware_version,
        d.wifi_rssi,
        d.last_latitude,
        d.last_longitude,
        d.is_quarantined,
        d.setup_required
      FROM devices d
      WHERE d.vehicle_id = $1
      ORDER BY d.assigned_at DESC NULLS LAST, d.updated_at DESC
      LIMIT 1
    `,
        [driver.vehicle_id]
      );

      const device = deviceRows.length > 0 ? deviceRows[0] : null;

      const devicePending =
        !device ||
        device.status === "pending" ||
        device.status === "CREATED" ||
        device.status === "PRINTED" ||
        device.status === "IN_STOCK";

      const setupRequired =
        !!driver.reprovision_required ||
        devicePending ||
        !!device?.setup_required;

      return reply.send({
        success: true,
        has_vehicle: true,
        has_device: !!device,
        setup_required: setupRequired,
        vehicle: {
          id: driver.vehicle_id,
          plate_no: driver.plate_no,
          reprovision_required: !!driver.reprovision_required,
          // Info-only (V3 kaynak devices tablosu)
          esp32_device_id: driver.esp32_device_id || null,
        },
        device: device
          ? {
              id: device.id,
              device_code: device.device_code,
              serial: device.serial || device.serial_number || null,
              mac_address: device.mac_address,
              status: device.status,
              is_online: device.is_online,
              last_seen_at: device.last_seen_at,
              firmware_version: device.firmware_version,
              wifi_rssi: device.wifi_rssi,
              last_location:
                device.last_latitude && device.last_longitude
                  ? {
                      latitude: parseFloat(device.last_latitude),
                      longitude: parseFloat(device.last_longitude),
                    }
                  : null,
              is_quarantined: device.is_quarantined,
            }
          : null,
      });
    } catch (err) {
      request.log.error({ err }, "failed to fetch assigned device");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// 2. COMPANY ADMIN: DEVICE LIST
// GET /api/admin/devices
// FIX: Sadece company_admin/super_admin erişir
// FIX: MVP güvenliği -> company_id zorunlu
// ============================================================
fastify.get(
  "/api/admin/devices",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (
      request.user.role !== "company_admin" &&
      request.user.role !== "super_admin"
    ) {
      return reply.code(403).send({ error: "Forbidden - Admin only" });
    }

    const companyId = request.companyId;
    if (!companyId) {
      return reply.code(400).send({
        error: "company_id required",
        hint: "Super admin should pass company_id as query param",
      });
    }

    const client = await fastify.pg.connect();

    try {
      const { rows: statsRows } = await client.query(
        `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE d.last_seen_at > NOW() - INTERVAL '180 seconds') as online,
        COUNT(*) FILTER (WHERE d.last_seen_at IS NULL OR d.last_seen_at <= NOW() - INTERVAL '180 seconds') as offline,
        COUNT(*) FILTER (WHERE d.is_quarantined = true) as quarantined,
        COUNT(*) FILTER (WHERE d.vehicle_id IS NULL) as unassigned
      FROM devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.company_id = $1 OR v.company_id = $1
    `,
        [companyId]
      );

      const stats = statsRows[0];

      const { rows } = await client.query(
        `
      SELECT 
        d.id,
        d.device_code,
        d.serial,
        d.serial_number,
        d.mac_address,
        d.status,
        CASE WHEN d.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online,
        d.last_seen_at,
        d.firmware_version,
        d.wifi_rssi,
        d.last_latitude,
        d.last_longitude,
        d.is_quarantined,
        d.total_uptime_minutes,
        d.total_alerts_sent,
        d.error_count,
        d.vehicle_id,
        d.company_id,
        v.plate_no,
        v.brand,
        v.model,
        v.reprovision_required,
        dr.id as driver_id,
        u.first_name || ' ' || u.last_name as driver_name,
        qrc.token as qr_token,
        qrc.used_at as qr_used,
        qrc.expires_at as qr_expires_at
      FROM devices d
      LEFT JOIN device_qr_codes qrc ON d.id = qrc.device_id AND qrc.used_at IS NULL
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN drivers dr ON dr.assigned_vehicle_id = v.id
      LEFT JOIN users u ON u.id = dr.user_id
      WHERE d.company_id = $1 OR v.company_id = $1
      ORDER BY d.last_seen_at DESC NULLS LAST, d.updated_at DESC
    `,
        [companyId]
      );

      return reply.send({
        success: true,
        stats: {
          total: parseInt(stats.total, 10),
          online: parseInt(stats.online, 10),
          offline: parseInt(stats.offline, 10),
          quarantined: parseInt(stats.quarantined, 10),
          unassigned: parseInt(stats.unassigned, 10),
        },
        devices: rows.map((d) => ({
          ...d,
          last_location:
            d.last_latitude && d.last_longitude
              ? {
                  latitude: parseFloat(d.last_latitude),
                  longitude: parseFloat(d.last_longitude),
                }
              : null,
          qr: {
            has_active: !!d.qr_token,
            used: !!d.qr_used,
            expires_at: d.qr_expires_at,
          },
        })),
      });
    } catch (err) {
      request.log.error({ err }, "failed to fetch admin devices");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// GET /api/admin/devices/search
// Serial numarasına göre cihaz ara
fastify.get(
  "/api/admin/devices/search",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    if (
      request.user.role !== "company_admin" &&
      request.user.role !== "super_admin"
    ) {
      return reply.code(403).send({ error: "Forbidden - Admin only" });
    }

    const { serial } = request.query;
    if (!serial || !serial.trim()) {
      return reply.code(400).send({ error: "Serial number required" });
    }

    const companyId = request.user.company_id;
    const searchTerm = serial.trim().toUpperCase();

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `
      SELECT 
        d.id, d.device_code, d.serial, d.serial_number, d.mac_address,
        d.status, d.vehicle_id, d.company_id,
        CASE WHEN d.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online,
        d.last_seen_at, d.firmware_version,
        v.plate_no, v.brand, v.model,
        u.first_name || ' ' || u.last_name as driver_name
      FROM devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN drivers dr ON dr.assigned_vehicle_id = v.id
      LEFT JOIN users u ON u.id = dr.user_id
      WHERE (d.company_id = $1 OR v.company_id = $1)
        AND UPPER(d.serial) LIKE $2
      ORDER BY d.updated_at DESC
      LIMIT 20
    `,
        [companyId, "%" + searchTerm + "%"]
      );

      return reply.send({ success: true, devices: rows });
    } catch (err) {
      request.log.error({ err }, "device search failed");
      return reply.code(500).send({ error: "Search failed" });
    } finally {
      client.release();
    }
  }
);

// POST /api/admin/devices/add-to-stock-by-serial
// Serial ile cihazı stoka ekle (QR scan veya manuel)
fastify.post(
  "/api/admin/devices/add-to-stock-by-serial",
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    const rawSerial = request.body?.serial;
    const userId = request.user.id;
    const userRole = request.user.role;
    const companyId = request.user.company_id;

    // Validation
    if (!rawSerial) {
      return reply.code(400).send({ error: "Serial number required" });
    }

    let serial = null;
    serial = rawSerial.trim().toUpperCase();

    // Serial format validation (TF-XXXX-XXXXX-X)
    const serialRegex = /^TF-\d{4}-\d{5}-[A-Z0-9]$/;
    if (!serialRegex.test(serial)) {
      return reply.code(400).send({
        error: "Invalid serial format",
        expected: "TF-XXXX-XXXXX-X",
      });
    }

    // Role kontrolü: admin, company_admin, super_admin
    if (
      userRole !== "admin" &&
      userRole !== "company_admin" &&
      userRole !== "super_admin"
    ) {
      return reply
        .code(403)
        .send({ error: "Forbidden - Admin access required" });
    }

    const client = await fastify.pg.connect();

    try {
      await client.query("BEGIN");

      // 1. Serial'dan cihazı bul (FOR UPDATE ile kilitle)
      const deviceResult = await client.query(
        `SELECT id, serial, status, company_id, vehicle_id 
       FROM devices 
       WHERE UPPER(serial) = $1
       FOR UPDATE`,
        [serial]
      );

      if (deviceResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({
          error: "Device not found",
          serial,
        });
      }

      const device = deviceResult.rows[0];

      // 2. Company kontrolü (company_admin sadece kendi şirketinin cihazlarını stoka ekleyebilir)
      if (
        userRole === "company_admin" &&
        device.company_id &&
        device.company_id !== companyId
      ) {
        await client.query("ROLLBACK");
        return reply.code(403).send({
          error: "Forbidden - Device belongs to another company",
        });
      }

      // 3. Zaten stokta mı? (Idempotent)
      if (device.status === "IN_STOCK" && !device.vehicle_id) {
        await client.query("ROLLBACK");
        return reply.send({
          success: true,
          message: "Device already in stock",
          device: {
            id: device.id,
            serial: device.serial,
            status: device.status,
          },
        });
      }

      const previousVehicleId = device.vehicle_id;
      const previousStatus = device.status;

      // 4. Cihazı stoka al (company_id set et)
      await client.query(
        `UPDATE devices 
       SET status = 'IN_STOCK',
           vehicle_id = NULL,
           company_id = COALESCE(company_id, $1),
           updated_at = NOW()
       WHERE id = $2`,
        [companyId, device.id]
      );

      // 5. Eğer araca atanmışsa, aracın durumunu 'available' yap
      if (previousVehicleId) {
        await client.query(
          `UPDATE vehicles 
         SET status = 'available',
             updated_at = NOW()
         WHERE id = $1`,
          [previousVehicleId]
        );
      }

      // 6. Audit log
      await client.query(
        `INSERT INTO device_bind_events 
       (device_id, event_type, performed_by, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
        [
          device.id,
          "ADD_TO_STOCK",
          userId,
          JSON.stringify({
            serial: device.serial,
            method: "serial_scan",
            previous_status: previousStatus,
            previous_vehicle_id: previousVehicleId,
            company_id: companyId,
          }),
        ]
      );

      await client.query("COMMIT");

      fastify.log.info({
        event: "device_added_to_stock",
        device_id: device.id,
        serial: device.serial,
        user_id: userId,
        previous_vehicle_id: previousVehicleId,
      });

      return reply.send({
        success: true,
        message: "Device added to stock successfully",
        device: {
          id: device.id,
          serial: device.serial,
          status: "IN_STOCK",
          company_id: companyId,
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      fastify.log.error({
        event: "add_to_stock_error",
        error: err.message,
        serial,
      });
      return reply.code(500).send({
        error: "Failed to add device to stock",
        details: err.message,
      });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// 3. COMPANY ADMIN: DEVICE REPROVISION FLAG
// PUT /api/admin/devices/:id/reprovision
// FIX: company_id zorunlu (super_admin da scope seçmiş olmalı)
// FIX: Flag vehicles.reprovision_required'a yazılır (TEK KAYNAK)
// FIX: vehicles tablosunda updated_at yoksa dokunma
// ============================================================
fastify.put(
  "/api/admin/devices/:id/reprovision",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (
      request.user.role !== "company_admin" &&
      request.user.role !== "super_admin"
    ) {
      return reply.code(403).send({ error: "Forbidden - Admin only" });
    }

    const { id } = request.params;
    const { reason, clear } = request.body || {};
    const companyId = request.companyId;

    if (!companyId) {
      return reply.code(400).send({
        error: "company_id required",
        hint: "Super admin should pass company_id as query param",
      });
    }

    const client = await fastify.pg.connect();

    try {
      const { rows: deviceRows } = await client.query(
        `
      SELECT d.*, v.company_id as vehicle_company_id, v.plate_no
      FROM devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.id = $1
      LIMIT 1
    `,
        [id]
      );

      if (!deviceRows.length) {
        return reply.code(404).send({ error: "Device not found" });
      }

      const device = deviceRows[0];

      if (!device.vehicle_id) {
        return reply
          .code(400)
          .send({ error: "Device has no vehicle assigned" });
      }

      // Tenant check: hem company_admin hem super_admin (scope seçtiği için)
      const belongs =
        device.company_id === companyId ||
        device.vehicle_company_id === companyId;
      if (!belongs) {
        // super_admin için bilgi sızmasını azalt: 404
        return reply
          .code(request.user.role === "super_admin" ? 404 : 403)
          .send({
            error:
              request.user.role === "super_admin"
                ? "Device not found"
                : "Forbidden",
          });
      }

      const newFlag = clear === true ? false : true;

      // vehicles.updated_at yok -> sadece reprovision_required güncelle
      await client.query(
        `
      UPDATE vehicles SET
        reprovision_required = $1
      WHERE id = $2
    `,
        [newFlag, device.vehicle_id]
      );

      // Opsiyonel: devices.metadata'ya log yaz
      await client.query(
        `
      UPDATE devices SET
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{reprovision_info}',
          $1::jsonb
        ),
        updated_at = NOW()
      WHERE id = $2
    `,
        [
          JSON.stringify({
            requested_at: new Date().toISOString(),
            requested_by: request.user.id,
            action: newFlag ? "set" : "clear",
            reason:
              reason ||
              (newFlag
                ? "Manual reprovision request"
                : "Reprovision completed"),
          }),
          id,
        ]
      );

      // Event log - constraint-safe values
      const actorType =
        request.user.role === "super_admin" ? "SUPERADMIN" : "ADMIN";
      const eventType = "STATUS_CHANGE";

      await client.query(
        `
      INSERT INTO device_bind_events (
        device_id, serial, esp_chip_id, event_type, 
        actor_user_id, actor_type, reason, previous_state, new_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
        [
          id,
          device.serial,
          device.esp_chip_id,
          eventType,
          request.user.id,
          actorType,
          reason ||
            (newFlag
              ? "Yeniden kurulum istendi"
              : "Yeniden kurulum tamamlandı"),
          JSON.stringify({ reprovision_required: !newFlag }),
          JSON.stringify({ reprovision_required: newFlag }),
        ]
      );

      return reply.send({
        success: true,
        message: newFlag
          ? "Cihaz yeniden kurulum için işaretlendi"
          : "Yeniden kurulum işareti kaldırıldı",
        vehicle_id: device.vehicle_id,
        plate_no: device.plate_no,
        reprovision_required: newFlag,
      });
    } catch (err) {
      request.log.error({ err }, "failed to set reprovision flag");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// 4. ALIAS: GET /api/devices (Backward compatibility)
// MVP güvenliği: company_id zorunlu
// ============================================================
fastify.get(
  "/api/devices",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const role = request.user.role;

    if (role === "driver") {
      return reply
        .code(403)
        .send({ error: "Forbidden - Driver cannot list devices" });
    }
    if (role !== "company_admin" && role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden - Admin only" });
    }

    const companyId = request.companyId || null;
    if (!companyId) {
      return reply.code(400).send({
        error: "company_id required",
        hint: "Super admin should pass company_id as query param",
      });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `
      SELECT
        d.id,
        d.device_code,
        d.serial,
        d.serial_number,
        d.mac_address,
        d.status,
        CASE WHEN d.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online,
        d.last_seen_at,
        d.is_quarantined,
        d.company_id,
        d.vehicle_id,
        v.plate_no
      FROM devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.company_id = $1 OR v.company_id = $1
      ORDER BY d.last_seen_at DESC NULLS LAST, d.updated_at DESC
    `,
        [companyId]
      );

      return reply.send({ success: true, devices: rows });
    } catch (err) {
      request.log.error({ err }, "failed to fetch /api/devices alias");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// 5. ALIAS: GET /api/devices/:id (Backward compatibility)
// MVP güvenliği: company_id zorunlu + belongs check
// ============================================================
fastify.get(
  "/api/devices/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const role = request.user.role;

    if (role === "driver") {
      return reply
        .code(403)
        .send({ error: "Forbidden - Driver cannot view device detail" });
    }
    if (role !== "company_admin" && role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden - Admin only" });
    }

    const { id } = request.params;
    const companyId = request.companyId || null;

    if (!companyId) {
      return reply.code(400).send({
        error: "company_id required",
        hint: "Super admin should pass company_id as query param",
      });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `
      SELECT
        d.*,
        v.plate_no,
        v.company_id AS vehicle_company_id
      FROM devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.id = $1
      LIMIT 1
    `,
        [id]
      );

      if (!rows.length) {
        return reply.code(404).send({ error: "Device not found" });
      }

      const d = rows[0];
      const belongs =
        d.company_id === companyId || d.vehicle_company_id === companyId;

      if (!belongs) {
        return reply.code(role === "super_admin" ? 404 : 403).send({
          error: role === "super_admin" ? "Device not found" : "Forbidden",
        });
      }

      return reply.send({ success: true, device: d });
    } catch (err) {
      request.log.error({ err }, "failed to fetch /api/devices/:id alias");
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// AUTH REFRESH TOKEN
// ═══════════════════════════════════════════════════════════════════

fastify.post("/api/auth/refresh", async (request, reply) => {
  const { refreshToken } = request.body || {};

  if (!refreshToken) {
    return reply.status(400).send({ error: "Refresh token required" });
  }

  const client = await fastify.pg.connect();
  try {
    // Refresh token'ı kontrol et
    const result = await client.query(
      "SELECT user_id, expires_at FROM refresh_tokens WHERE token = $1",
      [refreshToken]
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({ error: "Invalid refresh token" });
    }

    const tokenData = result.rows[0];

    if (new Date(tokenData.expires_at) < new Date()) {
      await client.query("DELETE FROM refresh_tokens WHERE token = $1", [
        refreshToken,
      ]);
      return reply.status(401).send({ error: "Refresh token expired" });
    }

    // Kullanıcıyı al
    const userResult = await client.query(
      "SELECT id, email, role, company_id, first_name, last_name FROM users WHERE id = $1",
      [tokenData.user_id]
    );

    if (userResult.rows.length === 0) {
      return reply.status(401).send({ error: "User not found" });
    }

    const user = userResult.rows[0];

    // Yeni access token oluştur
    const accessToken = fastify.jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
      },
      { expiresIn: "1h" }
    );

    return reply.send({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
      },
    });
  } catch (error) {
    console.error("[REFRESH] Error:", error.message);
    return reply.status(500).send({ error: "Token refresh failed" });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUSH NOTIFICATION REGISTER
// ═══════════════════════════════════════════════════════════════════

fastify.post("/api/push/register", async (request, reply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const decoded = fastify.jwt.verify(token);

    const { pushToken, platform } = request.body || {};

    if (!pushToken) {
      return reply.status(400).send({ error: "Push token required" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query(
        "UPDATE users SET expo_push_token = $1, updated_at = NOW() WHERE id = $2",
        [pushToken, decoded.id]
      );
    } finally {
      client.release();
    }

    console.log(
      `[PUSH] Token registered for user ${decoded.email}, platform: ${
        platform || "unknown"
      }`
    );

    return reply.send({ success: true, message: "Push token registered" });
  } catch (error) {
    console.error("[PUSH] Error:", error.message);
    return reply.status(500).send({ error: "Failed to register push token" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DEVICE SERIAL CHECK
// ═══════════════════════════════════════════════════════════════════

fastify.get("/api/devices/serial/:serial/check", async (request, reply) => {
  const { serial } = request.params || {};

  if (!serial) {
    return reply.status(400).send({ valid: false, error: "Serial required" });
  }

  const client = await fastify.pg.connect();
  try {
    const result = await client.query(
      "SELECT id, device_code, serial, status, vehicle_id, company_id FROM devices WHERE serial = $1",
      [serial]
    );

    if (result.rows.length === 0) {
      return reply.send({ valid: false, error: "Device not found" });
    }

    const device = result.rows[0];

    return reply.send({
      valid: true,
      device: {
        id: device.id,
        serial: device.serial,
        status: device.status,
        hasVehicle: !!device.vehicle_id,
      },
    });
  } catch (error) {
    console.error("[SERIAL CHECK] Error:", error.message);
    return reply.status(500).send({ valid: false, error: "Check failed" });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════
// DRIVER TASK ACTIONS - Accept/Reject/Start/Complete
// (Inserted above fastify.listen as requested)
// ═══════════════════════════════════════════════════════════════

// Accept Task
fastify.put(
  "/api/driver/tasks/:id/accept",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows: driverRows } = await client.query(
        "SELECT d.id, d.company_id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;
      const companyId = driverRows[0].company_id;
      const { rows } = await client.query(
        "UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND driver_id = $3 RETURNING *",
        ["accepted", id, driverId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }
      await client.query("UPDATE drivers SET status = $1 WHERE id = $2", [
        "task_pending",
        driverId,
      ]);
      await client.query(
        "INSERT INTO alerts (company_id, alert_type, severity, task_id, title, description) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          companyId,
          "task_accepted",
          "info",
          id,
          "Görev Kabul Edildi",
          "Görev kabul edildi: " + (rows[0].task_no || rows[0].id),
        ]
      );
      await insertTaskEventTx(client, {
        taskId: id,
        type: "TASK_ACCEPTED",
        message: "Task accepted: " + (rows[0].task_no || rows[0].id),
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });
      await client.query("COMMIT");
      return { success: true, task: rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// Reject Task
fastify.put(
  "/api/driver/tasks/:id/reject",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const { reason } = request.body || {};
    const userId = request.user.id;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows: driverRows } = await client.query(
        "SELECT d.id, d.company_id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;
      const companyId = driverRows[0].company_id;
      const { rows } = await client.query(
        "UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND driver_id = $3 RETURNING *",
        ["rejected", id, driverId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }
      await client.query("UPDATE drivers SET status = $1 WHERE id = $2", [
        "available",
        driverId,
      ]);
      await client.query(
        "INSERT INTO alerts (company_id, alert_type, severity, task_id, title, description) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          companyId,
          "task_rejected",
          "warning",
          id,
          "Görev Reddedildi",
          "Görev reddedildi: " + (rows[0].task_no || rows[0].id),
        ]
      );
      await insertTaskEventTx(client, {
        taskId: id,
        type: "TASK_REJECTED",
        message: reason ? "Task rejected: " + reason : "Task rejected",
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });
      await client.query("COMMIT");
      return { success: true, task: rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// Withdraw Task
fastify.put(
  "/api/driver/tasks/:taskId/withdraw",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { taskId } = request.params;
    const { reason, task_title } = request.body || {};
    const userId = request.user.id;
    const driverEmail = request.user.email;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");

      // 1. Get driver by logged-in user
      const { rows: driverRows } = await client.query(
        "SELECT d.id, d.company_id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;
      const companyId = driverRows[0].company_id;

      // 2. Find task belonging to this driver
      const { rows: taskRows } = await client.query(
        `SELECT t.*, u.first_name, u.last_name
       FROM tasks t
       LEFT JOIN drivers d ON t.driver_id = d.id
       LEFT JOIN users u ON d.user_id = u.id
       WHERE t.id = $1 AND t.driver_id = $2`,
        [taskId, driverId]
      );
      if (taskRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }
      const task = taskRows[0];

      const withdrawReason = reason || "No reason provided";

      // 3. Update task status to withdrawn
      await client.query(
        `UPDATE tasks 
       SET status = 'withdrawn', 
           withdrawn_at = NOW(),
           withdrawn_reason = $1,
           updated_at = NOW()
       WHERE id = $2 AND driver_id = $3`,
        [withdrawReason, taskId, driverId]
      );

      // 4. Set driver back to available
      await client.query("UPDATE drivers SET status = $1 WHERE id = $2", [
        "available",
        driverId,
      ]);

      // 5. Create alert for admins
      const driverName =
        task.first_name && task.last_name
          ? `${task.first_name} ${task.last_name}`
          : driverEmail;

      await client.query(
        `INSERT INTO alerts 
       (company_id, alert_type, severity, task_id, title, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          companyId,
          "task_withdrawn",
          "warning",
          taskId,
          `Görev Geri Çekildi: ${
            task_title || task.title || "Bilinmeyen Görev"
          }`,
          `Sürücü ${driverName} görevi geri çekti. Sebep: ${withdrawReason}`,
        ]
      );

      await insertTaskEventTx(client, {
        taskId: taskId,
        type: "TASK_WITHDRAWN",
        message: withdrawReason
          ? "Task withdrawn: " + withdrawReason
          : "Task withdrawn",
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });
      await revokePublicTrackingBestEffort(client, taskId, request.log);
      await client.query("COMMIT");

      return reply.send({
        success: true,
        message: "Task withdrawn successfully",
        task: {
          id: taskId,
          status: "withdrawn",
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// WAYPOINT STATUS CORE HELPERS
// ============================================

function normalizeWaypointStatus(s) {
  const v = String(s || "")
    .toLowerCase()
    .trim();
  if (["pending", "arrived", "departed", "completed"].includes(v)) return v;
  return null;
}

function getStatusRank(status) {
  switch (status) {
    case "pending":
      return 0;
    case "arrived":
      return 1;
    case "departed":
      return 2;
    case "completed":
      return 3;
    default:
      return 0;
  }
}

function eventTypeForWaypointStatus(status) {
  if (status === "arrived") return "STOP_ARRIVED";
  if (status === "departed") return "STOP_DEPARTED";
  if (status === "completed") return "WAYPOINT_COMPLETED";
  return null;
}

function applyTimestamp(wp, status, nowIso) {
  if (status === "arrived")
    return { ...wp, arrived_at: wp.arrived_at || nowIso };
  if (status === "departed")
    return { ...wp, departed_at: wp.departed_at || nowIso };
  if (status === "completed")
    return { ...wp, completed_at: wp.completed_at || nowIso };
  return wp;
}

async function updateWaypointStatusTx(
  client,
  { taskId, waypointId, userId, newStatus }
) {
  const { rows: driverRows } = await client.query(
    "SELECT id FROM drivers WHERE user_id = $1",
    [userId]
  );
  if (!driverRows.length)
    return { ok: false, code: 404, error: "Driver not found" };

  const driverId = driverRows[0].id;

  const { rows: taskRows } = await client.query(
    "SELECT waypoints FROM tasks WHERE id = $1 AND driver_id = $2",
    [taskId, driverId]
  );
  if (!taskRows.length)
    return { ok: false, code: 404, error: "Task not found" };

  let waypoints = taskRows[0].waypoints || [];
  if (typeof waypoints === "string") {
    try {
      waypoints = JSON.parse(waypoints);
    } catch {
      waypoints = [];
    }
  }
  if (!Array.isArray(waypoints)) waypoints = [];

  const index = waypoints.findIndex(
    (wp) => String(wp?.id) === String(waypointId)
  );
  if (index === -1)
    return { ok: false, code: 404, error: "Waypoint not found" };

  const current = waypoints[index];
  const currentStatus = normalizeWaypointStatus(current.status) || "pending";
  const nowIso = new Date().toISOString();

  if (currentStatus === newStatus) {
    return { ok: true, changed: false, waypoints };
  }

  const curRank = getStatusRank(currentStatus);
  const newRank = getStatusRank(newStatus);

  if (newRank < curRank) {
    return { ok: false, code: 409, error: "Invalid status progression" };
  }

  const updated = applyTimestamp(
    { ...current, status: newStatus },
    newStatus,
    nowIso
  );
  const updatedWaypoints = [...waypoints];
  updatedWaypoints[index] = updated;

  await client.query(
    "UPDATE tasks SET waypoints = $1::jsonb, updated_at = NOW() WHERE id = $2 AND driver_id = $3",
    [JSON.stringify(updatedWaypoints), taskId, driverId]
  );

  return { ok: true, changed: true, waypoints: updatedWaypoints };
}

// ============================================
// WAYPOINT STATUS UPDATE ENDPOINT
// ============================================
fastify.put(
  "/api/driver/tasks/:taskId/waypoints/:waypointId/status",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { taskId, waypointId } = request.params;
    const userId = request.user.id;
    const desired = normalizeWaypointStatus(request.body?.status);

    if (!desired || desired === "pending") {
      return reply.code(400).send({ error: "Invalid status" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");

      const result = await updateWaypointStatusTx(client, {
        taskId,
        waypointId,
        userId,
        newStatus: desired,
      });

      if (!result.ok) {
        await client.query("ROLLBACK");
        return reply.code(result.code || 400).send({ error: result.error });
      }

      if (result.changed) {
        const eventType = eventTypeForWaypointStatus(desired);
        if (eventType) {
          const eventId = await insertTaskEventTx(client, {
            taskId,
            stopId: waypointId,
            type: eventType,
            message: `Waypoint ${desired}`,
            createdByUserId: request.user.id,
            createdByRole: request.user.role,
          });

          // Email tetikle (no-throw, async)
          if (
            eventId &&
            (eventType === "STOP_ARRIVED" || eventType === "WAYPOINT_COMPLETED")
          ) {
            setImmediate(() =>
              sendStopEventEmail(fastify, {
                taskId,
                eventId,
                stopId: waypointId,
                type: eventType,
              })
            );
          }
        }
      }

      await client.query("COMMIT");
      return reply.send({
        success: true,
        changed: result.changed,
        waypoints: result.waypoints,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply
        .code(500)
        .send({ error: "Failed to update waypoint status" });
    } finally {
      client.release();
    }
  }
);

// Complete a specific waypoint of a driver's task
fastify.put(
  "/api/driver/tasks/:taskId/waypoints/:waypointId/complete",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { taskId, waypointId } = request.params;
    const userId = request.user.id;

    const client = await fastify.pg.connect();
    try {
      // Get driver by logged-in user
      const { rows: driverRows } = await client.query(
        "SELECT d.id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;

      // Fetch task waypoints scoped to this driver
      const { rows: taskRows } = await client.query(
        "SELECT waypoints FROM tasks WHERE id = $1 AND driver_id = $2",
        [taskId, driverId]
      );
      if (taskRows.length === 0) {
        return reply.code(404).send({ error: "Task not found" });
      }

      let waypoints = taskRows[0].waypoints || [];
      if (typeof waypoints === "string") {
        try {
          waypoints = JSON.parse(waypoints);
        } catch {
          waypoints = [];
        }
      }
      if (!Array.isArray(waypoints)) {
        waypoints = [];
      }

      const nowIso = new Date().toISOString();
      const updatedWaypoints = waypoints.map((wp) => {
        if (String(wp?.id) === String(waypointId)) {
          return { ...wp, status: "completed", completed_at: nowIso };
        }
        return wp;
      });

      await client.query(
        "UPDATE tasks SET waypoints = $1::jsonb, updated_at = NOW() WHERE id = $2 AND driver_id = $3",
        [JSON.stringify(updatedWaypoints), taskId, driverId]
      );
      await insertTaskEventTx(client, {
        taskId: taskId,
        stopId: waypointId,
        type: "WAYPOINT_COMPLETED",
        message: "Waypoint completed: " + waypointId,
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });
      return reply.send({ success: true, waypoints: updatedWaypoints });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to complete waypoint" });
    } finally {
      client.release();
    }
  }
);

// Start Task
fastify.put(
  "/api/driver/tasks/:id/start",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows: driverRows } = await client.query(
        "SELECT d.id, d.company_id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;
      const companyId = driverRows[0].company_id;
      // FEAT-010 SS3.6 (v1.6) - tek-aktif-gorev sozlesmesi: is kurali ihlali
      // sunucu cokusu DEGILDIR; 500 yerine 409 Conflict + anlasilir mesaj doner.
      const { rows: activeRows } = await client.query(
        "SELECT id, task_no FROM tasks WHERE driver_id = $1 AND status = 'in_progress' LIMIT 1",
        [driverId]
      );
      if (activeRows.length > 0 && activeRows[0].id !== id) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "Conflict",
          message:
            "Aktif bir göreviniz var (" +
            activeRows[0].task_no +
            "). Yeni göreve başlamadan önce mevcut görevi tamamlayın veya geri çekin.",
          active_task_no: activeRows[0].task_no,
        });
      }
      const { rows } = await client.query(
        "UPDATE tasks SET status = $1, actual_start = NOW(), updated_at = NOW() WHERE id = $2 AND driver_id = $3 RETURNING *",
        ["in_progress", id, driverId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }
      await client.query(
        "UPDATE drivers SET status = $1, assigned_vehicle_id = $2 WHERE id = $3",
        ["on_task", rows[0].vehicle_id, driverId]
      );
      if (rows[0].vehicle_id) {
        await client.query("UPDATE vehicles SET status = $1 WHERE id = $2", [
          "in_use",
          rows[0].vehicle_id,
        ]);
      }
      await client.query(
        "INSERT INTO alerts (company_id, alert_type, severity, task_id, title, description) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          companyId,
          "task_started",
          "info",
          id,
          "Görev Başladı",
          "Görev başladı: " + (rows[0].task_no || rows[0].id),
        ]
      );
      await insertTaskEventTx(client, {
        taskId: id,
        type: "TASK_STARTED",
        message: "Task started: " + (rows[0].task_no || rows[0].id),
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });
      await client.query("COMMIT");
      // Rota tutarliligi (10 Eki): surucu navigasyonu ve takip sayfasi ayni
      // route_json.public_route geometrisini okur. HERE cagrisi arka planda,
      // yaniti bekletmez; hata yalnizca loglanir (takip linki acilinca tekrar dener).
      setImmediate(() => {
        warmPublicRoute(fastify, id, request.log).catch(() => {});
      });
      return { success: true, task: rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      // FEAT-010 SS3.6 - yaris durumu emniyeti: kontrol ile UPDATE arasinda baska
      // istek in_progress yazdiysa uniq_driver_single_in_progress 23505 firlatir;
      // bu da kural ihlalidir, 500 degil 409 doner.
      if (
        error &&
        error.code === "23505" &&
        error.constraint === "uniq_driver_single_in_progress"
      ) {
        return reply.code(409).send({
          error: "Conflict",
          message:
            "Aktif bir göreviniz var. Yeni göreve başlamadan önce mevcut görevi tamamlayın veya geri çekin.",
          active_task_no: null,
        });
      }
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// Complete Task
fastify.put(
  "/api/driver/tasks/:id/complete",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows: driverRows } = await client.query(
        "SELECT d.id, d.company_id FROM drivers d WHERE d.user_id = $1",
        [userId]
      );
      if (driverRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Driver not found" });
      }
      const driverId = driverRows[0].id;
      const companyId = driverRows[0].company_id;
      const { rows } = await client.query(
        "UPDATE tasks SET status = $1, actual_end = NOW(), updated_at = NOW() WHERE id = $2 AND driver_id = $3 RETURNING *",
        ["completed", id, driverId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Task not found" });
      }
      await client.query("UPDATE drivers SET status = $1 WHERE id = $2", [
        "available",
        driverId,
      ]);
      if (rows[0].vehicle_id) {
        await client.query("UPDATE vehicles SET status = $1 WHERE id = $2", [
          "available",
          rows[0].vehicle_id,
        ]);
      }
      await client.query(
        "INSERT INTO alerts (company_id, alert_type, severity, task_id, title, description) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          companyId,
          "task_completed",
          "info",
          id,
          "Görev Tamamlandı",
          "Görev tamamlandı: " + (rows[0].task_no || rows[0].id),
        ]
      );
      await insertTaskEventTx(client, {
        taskId: id,
        type: "TASK_COMPLETED",
        message: "Task completed: " + (rows[0].task_no || rows[0].id),
        createdByUserId: request.user.id,
        createdByRole: request.user.role,
      });

      // Sprint A2 (Revize): Odometer-first distance model
      // Oncelik: manual (odometre) -> gps (Haversine) -> route (route_json)
      const odomEnd = parseFloat(request.body?.odometer_end);
      if (!isNaN(odomEnd) && odomEnd >= 0) {
        const odomStart2 = parseFloat(rows[0].odometer_start);
        if (!isNaN(odomStart2) && odomEnd >= odomStart2) {
          const odomDistKm = Math.round((odomEnd - odomStart2) * 10) / 10;
          await client.query(
            "UPDATE tasks SET odometer_end=$1, odometer_distance_km=$2, distance_source=$3 WHERE id=$4",
            [odomEnd, odomDistKm, "manual", id]
          );
        } else {
          await client.query("UPDATE tasks SET odometer_end=$1 WHERE id=$2", [
            odomEnd,
            id,
          ]);
        }
      }

      // GPS / route fallback — odometer_end gelmemisse devreye girer
      // Sprint A2-A3: GPS Haversine mesafe hesabi
      // Fallback sirasi: gps -> route -> (atla)
      // null guard: actual_start veya vehicle_id yoksa hesaplama atlanir
      try {
        const taskRow = rows[0];
        if (taskRow.actual_start && taskRow.vehicle_id) {
          const { rows: vRows } = await client.query(
            "SELECT esp32_device_id FROM vehicles WHERE id = $1",
            [taskRow.vehicle_id]
          );
          const deviceId = vRows[0]?.esp32_device_id;

          let distKm = null;
          let distSource = null;

          if (deviceId) {
            const { rows: gpsRows } = await client.query(
              `SELECT latitude, longitude FROM locations
               WHERE device_id = $1
               AND time >= $2 AND time <= $3
               ORDER BY time ASC`,
              [deviceId, taskRow.actual_start, taskRow.actual_end]
            );

            if (gpsRows.length >= 5) {
              // Haversine + outlier filtresi
              // Ignore impossible GPS jumps (>2km between consecutive points)
              // Future: make configurable per fleet/profile
              const toRad = (deg) => (deg * Math.PI) / 180;
              const haversine = (a, b) => {
                const R = 6371;
                const dLat = toRad(Number(b.latitude) - Number(a.latitude));
                const dLon = toRad(Number(b.longitude) - Number(a.longitude));
                const sin2 =
                  Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(Number(a.latitude))) *
                    Math.cos(toRad(Number(b.latitude))) *
                    Math.sin(dLon / 2) ** 2;
                return R * 2 * Math.asin(Math.sqrt(sin2));
              };

              let total = 0;
              for (let i = 1; i < gpsRows.length; i++) {
                const seg = haversine(gpsRows[i - 1], gpsRows[i]);
                if (seg <= 2) total += seg;
              }
              distKm = Math.round(total * 10) / 10;
              distSource = "gps";
            } else {
              const routeDist = parseFloat(taskRow.route_json?.distance);
              if (!isNaN(routeDist) && routeDist > 0) {
                distKm = routeDist;
                distSource = "route";
              }
            }
          } else {
            distSource = "no_dev";
            const routeDist = parseFloat(taskRow.route_json?.distance);
            if (!isNaN(routeDist) && routeDist > 0) {
              distKm = routeDist;
            }
          }

          if (distSource !== null) {
            await client.query(
              "UPDATE tasks SET actual_distance_km = $1, distance_source = $2 WHERE id = $3",
              [distKm, distSource, id]
            );
          }
        } else {
          await client.query(
            "UPDATE tasks SET distance_source = $1 WHERE id = $2",
            ["no_start", id]
          );
        }
      } catch (gpsErr) {
        request.log.warn(
          { gpsErr },
          "GPS distance calculation failed, skipping"
        );
      }
      // Sprint A2-A3 sonu

      // Waypoint Geofence Faz 1: required-but-unvisited waypoints get closed
      // out as "route_bypass" rather than silently left incomplete. The
      // row was already locked by the UPDATE at the top of this transaction
      // (same client, still open), so no extra SELECT...FOR UPDATE is needed
      // here to avoid a race with a concurrent geofence-entry auto-visit.
      try {
        const { waypoints: bypassedWaypoints, bypassedCount } = applyRouteBypass(
          rows[0].waypoints,
          new Date().toISOString()
        );
        if (bypassedCount > 0) {
          await client.query(
            "UPDATE tasks SET waypoints = $1, updated_at = NOW() WHERE id = $2",
            [JSON.stringify(bypassedWaypoints), id]
          );
          request.log.info(
            `Waypoint route_bypass: task=${id} count=${bypassedCount}`
          );
        }
      } catch (wpErr) {
        request.log.warn({ wpErr }, "Waypoint route_bypass failed — skipped");
      }

      await revokePublicTrackingBestEffort(client, id, request.log);
      await client.query("COMMIT");
      return { success: true, task: rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// 6️⃣ DRIVER: SERİ NO İLE ARAÇ ARAMA (Sadece Stokta Olanlar)
fastify.get("/api/driver/devices/search", {
  onRequest: [fastify.authenticate],
  handler: async (request, reply) => {
    try {
      const { serial } = request.query;
      const user = request.user;

      if (!serial) {
        return reply.code(400).send({ error: "Serial required" });
      }

      if (user.role !== "driver") {
        return reply.code(403).send({ error: "Unauthorized" });
      }

      const result = await fastify.pg.query(
        `SELECT * FROM devices 
         WHERE serial ILIKE $1 
         AND company_id = $2
         AND status IN ('IN_STOCK', 'PRINTED')`,
        [`%${serial}%`, user.company_id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "No available devices found" });
      }

      return reply.send({
        devices: result.rows.map((d) => ({
          id: d.id,
          serial: d.serial,
          status: d.status,
          can_assign: true,
        })),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Search failed" });
    }
  },
});

// 7️⃣ DRIVER: MANUEL SERİ NO VEYA ID İLE ATAMA
fastify.post("/api/driver/devices/assign", {
  onRequest: [fastify.authenticate],
  handler: async (request, reply) => {
    try {
      const { deviceId, serial, vehicleId } = request.body;
      const user = request.user;

      if (!vehicleId) {
        return reply.code(400).send({ error: "vehicleId required" });
      }

      if (!deviceId && !serial) {
        return reply.code(400).send({ error: "deviceId or serial required" });
      }

      if (user.role !== "driver") {
        return reply.code(403).send({ error: "Unauthorized" });
      }

      const vehicleCheck = await fastify.pg.query(
        "SELECT company_id FROM vehicles WHERE id = $1",
        [vehicleId]
      );

      if (vehicleCheck.rows.length === 0) {
        return reply.code(404).send({ error: "Vehicle not found" });
      }

      if (vehicleCheck.rows[0].company_id !== user.company_id) {
        return reply
          .code(403)
          .send({ error: "Cannot assign to vehicle outside your company" });
      }

      let query = "SELECT * FROM devices WHERE ";
      let params = [];

      if (deviceId) {
        query += "id = $1";
        params = [deviceId];
      } else {
        query += "serial ILIKE $1";
        params = [`%${serial}%`];
      }

      query += " AND company_id = $" + (params.length + 1);
      params.push(user.company_id);

      query += " AND status IN ('IN_STOCK', 'PRINTED')";

      const deviceResult = await fastify.pg.query(query, params);

      if (deviceResult.rows.length === 0) {
        return reply
          .code(404)
          .send({ error: "Device not found or not available" });
      }

      const device = deviceResult.rows[0];

      await fastify.pg.query(
        "UPDATE devices SET status = $1, vehicle_id = $2 WHERE id = $3",
        ["ASSIGNED", vehicleId, device.id]
      );

      return reply.send({
        success: true,
        device: {
          id: device.id,
          serial: device.serial,
        },
        vehicle_id: vehicleId,
        message: "Device assigned successfully",
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Assignment failed" });
    }
  },
});

// 9️⃣ DRIVER: ATAYABİLECEĞİ CİHAZLARI LISTELE
fastify.get("/api/driver/devices/assignable", {
  onRequest: [fastify.authenticate],
  handler: async (request, reply) => {
    try {
      const user = request.user;

      if (user.role !== "driver") {
        return reply.code(403).send({ error: "Unauthorized" });
      }

      const result = await fastify.pg.query(
        `SELECT id, serial, status, mac_address
         FROM devices
         WHERE company_id = $1
         AND status IN ('IN_STOCK', 'PRINTED')
         ORDER BY created_at DESC`,
        [user.company_id]
      );

      return reply.send({
        devices: result.rows,
        total: result.rows.length,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch devices" });
    }
  },
});

// ============================================
// PUBLIC TRACKING — Link Üretme (Admin)
// ============================================
fastify.post(
  "/api/tasks/:id/public-link",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const role = request.user.role;

    if (role !== "company_admin" && role !== "super_admin") {
      return reply.code(403).send({ error: "Admin access required" });
    }

    const client = await fastify.pg.connect();
    try {
      // Task scope kontrolü
      if (role === "company_admin") {
        const { rows } = await client.query(
          "SELECT id FROM tasks WHERE id = $1 AND company_id = $2",
          [id, request.companyId]
        );
        if (!rows.length)
          return reply.code(404).send({ error: "Task not found" });
      }

      // Aktif token var mı?
      const { rows: existing } = await client.query(
        `SELECT token, expires_at FROM public_tracking_tokens
       WHERE task_id = $1 AND is_revoked = false AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC LIMIT 1`,
        [id]
      );

      if (existing.length) {
        const url = publicTrackUrl(existing[0].token);
        return reply.send({
          success: true,
          url,
          token: existing[0].token,
          expires_at: existing[0].expires_at,
          reused: true,
        });
      }

      // Yeni token üret
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 gün

      await client.query(
        `INSERT INTO public_tracking_tokens (task_id, token, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
        [id, token, request.user.id, expiresAt]
      );

      const url = publicTrackUrl(token);
      return reply.send({
        success: true,
        url,
        token,
        expires_at: expiresAt,
        reused: false,
      });
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// PUBLIC TRACKING — public read (alias /v and /public/track)
// ============================================
fastify.decorate("routingProvider", routingProvider);
fastify.register(require("./routes/publicTrack"));

// ============================================
// PUBLIC TRACKING — Token Revoke (Admin)
// ============================================
fastify.delete(
  "/api/tasks/:id/public-link",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const role = request.user.role;

    if (role !== "company_admin" && role !== "super_admin") {
      return reply.code(403).send({ error: "Admin access required" });
    }

    const client = await fastify.pg.connect();
    try {
      // SEC: task must belong to caller's company (13.09.2026)
      if (role !== "super_admin") {
        const { rows: own } = await client.query(
          "SELECT id FROM tasks WHERE id = $1 AND company_id = $2",
          [id, request.companyId]
        );
        if (own.length === 0) {
          return reply.code(404).send({ error: "Task not found" });
        }
      }
      await client.query(
        `UPDATE public_tracking_tokens SET is_revoked = true WHERE task_id = $1 AND is_revoked = false`,
        [id]
      );
      return reply.send({ success: true, message: "All tokens revoked" });
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ============================================
// ⭐ END: DEVICE QR CODE ENDPOINTS ⭐
// ============================================

// ════════════════════════════════════════════════════════
// SMART CARDS: Route Traffic + Weather
// v1: Traffic = route-aware (HERE Router v8)
//     Weather = midpoint/current-location summary (full route sampling degil)
// ════════════════════════════════════════════════════════

const _smartCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 dk

function cacheGet(key) {
  const entry = _smartCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _smartCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _smartCache.set(key, { data, ts: Date.now() });
}

async function getDriverRouteCoords(fastify, userId) {
  const client = await fastify.pg.connect();
  try {
    const { rows: dr } = await client.query(
      "SELECT id FROM drivers WHERE user_id = $1",
      [userId]
    );
    if (!dr.length) return null;

    const { rows: tasks } = await client.query(
      `SELECT start_location, end_location, route_json
   FROM tasks
   WHERE driver_id = $1 AND status IN ('accepted','in_progress')
   ORDER BY updated_at DESC LIMIT 1`,
      [dr[0].id]
    );
    if (!tasks.length) return null;

    const rj = tasks[0].route_json;
    // != null kontrolu: 0 koordinati gecerli bir deger, falsy check kullanma
    if (
      rj?.origin?.lat != null &&
      rj?.origin?.lng != null &&
      rj?.destination?.lat != null &&
      rj?.destination?.lng != null
    ) {
      return {
        originLat: rj.origin.lat,
        originLon: rj.origin.lng,
        destLat: rj.destination.lat,
        destLon: rj.destination.lng,
        routeLabel:
          (tasks[0].start_location?.slice(0, 20) || "Baslangic") +
          " -> " +
          (tasks[0].end_location?.slice(0, 20) || "Varis"),
      };
    }
    return null;
  } finally {
    client.release();
  }
}

// ── GET /api/driver/route-traffic ──────────────────────
fastify.get(
  "/api/driver/route-traffic",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    // ADR-0014 Faz 2: HERE cagrisi routingProvider'a tasindi.
    // Handler artik API anahtarini okumaz; key yoksa provider NOT_CONFIGURED firlatir.
    const coords = await getDriverRouteCoords(fastify, request.user.id);
    if (!coords) return reply.send({ traffic: null, reason: "NO_ACTIVE_TASK" });

    // Cache key: 4 koordinat dahil (longitude eksik olursa farkli rotalar cakisir)
    const cacheKey =
      "traffic_" +
      Math.round(coords.originLat * 100) +
      "_" +
      Math.round(coords.originLon * 100) +
      "_" +
      Math.round(coords.destLat * 100) +
      "_" +
      Math.round(coords.destLon * 100);

    const cached = cacheGet(cacheKey);
    if (cached) return reply.send(cached);

    try {
      const routeResult = await routingProvider.computeRoute({
        origin: { lat: coords.originLat, lon: coords.originLon },
        destination: { lat: coords.destLat, lon: coords.destLon },
        transportMode: "truck",
      });

      const result = {
        traffic: routingProvider.buildTrafficPayload(
          routeResult,
          coords.routeLabel
        ),
      };

      cacheSet(cacheKey, result);
      return reply.send(result);
    } catch (err) {
      if (err && err.code === "NOT_CONFIGURED") {
        return reply.send({ traffic: null, reason: "NOT_CONFIGURED" });
      }
      request.log.error({ err }, "route-traffic fetch error");
      return reply.send({ traffic: null, reason: "API_ERROR" });
    }
  }
);

// ── GET /api/driver/route-weather ──────────────────────
// v1: aktif gorev varsa origin+dest midpoint, yoksa aracin son konumu
fastify.get(
  "/api/driver/route-weather",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const OWM_KEY = process.env.OPENWEATHER_API_KEY;
    if (!OWM_KEY)
      return reply.send({ weather: null, reason: "NOT_CONFIGURED" });

    const coords = await getDriverRouteCoords(fastify, request.user.id);
    let lat, lon;

    if (coords) {
      lat = ((coords.originLat + coords.destLat) / 2).toFixed(4);
      lon = ((coords.originLon + coords.destLon) / 2).toFixed(4);
    } else {
      const client = await fastify.pg.connect();
      try {
        const { rows: dr } = await client.query(
          "SELECT id FROM drivers WHERE user_id = $1",
          [request.user.id]
        );
        if (!dr.length)
          return reply.send({ weather: null, reason: "NO_DRIVER" });

        const { rows: drv } = await client.query(
          "SELECT assigned_vehicle_id FROM drivers WHERE id = $1",
          [dr[0].id]
        );
        if (!drv.length || !drv[0].assigned_vehicle_id)
          return reply.send({ weather: null, reason: "NO_VEHICLE" });

        const { rows: loc } = await client.query(
          `SELECT latitude, longitude FROM locations
     WHERE device_id = (SELECT esp32_device_id FROM vehicles WHERE id = $1)
     ORDER BY time DESC LIMIT 1`,
          [drv[0].assigned_vehicle_id]
        );
        // != null kontrolu: 0 koordinati gecerli, falsy check kullanma
        if (!loc.length || loc[0].latitude == null || loc[0].longitude == null)
          return reply.send({ weather: null, reason: "NO_LOCATION" });

        lat = loc[0].latitude;
        lon = loc[0].longitude;
      } finally {
        client.release();
      }
    }

    const cacheKey =
      "weather_" + Math.round(lat * 10) + "_" + Math.round(lon * 10);
    const cached = cacheGet(cacheKey);
    if (cached) return reply.send(cached);

    try {
      // lang=en: backend yaniti UI i18n ile gosterilecek, nl hardcode yerine en evrensel
      const url =
        "https://api.openweathermap.org/data/2.5/weather" +
        "?lat=" +
        lat +
        "&lon=" +
        lon +
        "&units=metric&lang=" +
        (request.query.lang || "en") +
        "&appid=" +
        OWM_KEY;

      const res = await fetch(url);
      const data = await res.json();

      if (data.cod && data.cod !== 200 && String(data.cod) !== "200")
        return reply.send({
          weather: null,
          reason: "API_ERROR",
          detail: data.message,
        });

      const cur = {
        weather: data.weather,
        temp: data.main?.temp,
        wind_speed: data.wind?.speed,
        dew_point: null,
      };
      const code = cur?.weather?.[0]?.id || 800;
      const tempC = Math.round(cur?.temp || 0);
      const windKmh = Math.round((cur?.wind_speed || 0) * 3.6);
      const desc = cur?.weather?.[0]?.description || "";

      let icon;
      if (code >= 200 && code < 300) icon = "storm";
      else if (code >= 300 && code < 400) icon = "drizzle";
      else if (code >= 500 && code < 600) icon = "rain";
      else if (code >= 600 && code < 700) icon = "snow";
      else if (code >= 700 && code < 800) icon = "fog";
      else if (code === 800) icon = "clear";
      else icon = "cloudy";

      let alertText = null;
      if (data.alerts?.length) alertText = data.alerts[0].event;
      else if (code >= 200 && code < 300) alertText = "Storm warning";
      else if (code >= 600 && code < 700) alertText = "Snow/ice risk";
      else if (tempC <= 2) alertText = "Black ice risk";
      else if (windKmh > 60) alertText = "Strong crosswind";

      const result = {
        weather: {
          icon,
          temp_c: tempC,
          description: desc,
          wind_kmh: windKmh,
          alert: alertText,
          has_active_task: !!coords,
        },
      };

      cacheSet(cacheKey, result);
      return reply.send(result);
    } catch (err) {
      request.log.error({ err }, "route-weather fetch error");
      return reply.send({ weather: null, reason: "API_ERROR" });
    }
  }
);

// ── GET /api/driver/drive-conditions ──────────────────────
// Aggregation endpoint: traffic + weather tek seferde
// Koordinatlar bir kez resolve edilir, iki bloğa paylastirilir
fastify.get(
  "/api/driver/drive-conditions",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    try {
      const coords = await getDriverRouteCoords(fastify, request.user.id);

      const [trafficResult, weatherResult] = await Promise.allSettled([
        (async () => {
          // ADR-0014 Faz 3: HERE cagrisi routingProvider'a tasindi (drive-conditions traffic).
          // IIFE oldugu icin reply.send YOK; allSettled icin return semantigi korunur.
          if (!coords) return { traffic: null, reason: "NO_ACTIVE_TASK" };

          const cacheKey =
            "traffic_" +
            Math.round(coords.originLat * 100) +
            "_" +
            Math.round(coords.originLon * 100) +
            "_" +
            Math.round(coords.destLat * 100) +
            "_" +
            Math.round(coords.destLon * 100);

          const cached = cacheGet(cacheKey);
          if (cached) return cached;

          try {
            const routeResult = await routingProvider.computeRoute({
              origin: { lat: coords.originLat, lon: coords.originLon },
              destination: { lat: coords.destLat, lon: coords.destLon },
              transportMode: "truck",
            });

            const result = {
              traffic: routingProvider.buildTrafficPayload(
                routeResult,
                coords.routeLabel
              ),
            };
            cacheSet(cacheKey, result);
            return result;
          } catch (err) {
            if (err && err.code === "NOT_CONFIGURED") {
              return { traffic: null, reason: "NOT_CONFIGURED" };
            }
            return { traffic: null, reason: "API_ERROR" };
          }
        })(),

        (async () => {
          const OWM_KEY = process.env.OPENWEATHER_API_KEY;
          if (!OWM_KEY) return { weather: null, reason: "NOT_CONFIGURED" };

          let lat, lon;
          if (coords) {
            lat = ((coords.originLat + coords.destLat) / 2).toFixed(4);
            lon = ((coords.originLon + coords.destLon) / 2).toFixed(4);
          } else {
            const client = await fastify.pg.connect();
            try {
              const { rows: dr } = await client.query(
                "SELECT id FROM drivers WHERE user_id = $1",
                [request.user.id]
              );
              if (!dr.length) return { weather: null, reason: "NO_DRIVER" };
              const { rows: drv } = await client.query(
                "SELECT assigned_vehicle_id FROM drivers WHERE id = $1",
                [dr[0].id]
              );
              if (!drv.length || !drv[0].assigned_vehicle_id)
                return { weather: null, reason: "NO_VEHICLE" };
              const { rows: loc } = await client.query(
                "SELECT latitude, longitude FROM locations WHERE device_id = (SELECT esp32_device_id FROM vehicles WHERE id = $1) ORDER BY time DESC LIMIT 1",
                [drv[0].assigned_vehicle_id]
              );
              if (
                !loc.length ||
                loc[0].latitude == null ||
                loc[0].longitude == null
              )
                return { weather: null, reason: "NO_LOCATION" };
              lat = loc[0].latitude;
              lon = loc[0].longitude;
            } finally {
              client.release();
            }
          }

          const lang = request.query.lang || "en";
          const cacheKey =
            "weather_" +
            Math.round(lat * 10) +
            "_" +
            Math.round(lon * 10) +
            "_" +
            lang;
          const cached = cacheGet(cacheKey);
          if (cached) return cached;

          const url =
            "https://api.openweathermap.org/data/2.5/weather?lat=" +
            lat +
            "&lon=" +
            lon +
            "&units=metric&lang=" +
            (request.query.lang || "en") +
            "&appid=" +
            OWM_KEY;

          const res = await fetch(url);
          const data = await res.json();

          if (data.cod && data.cod !== 200 && String(data.cod) !== "200")
            return { weather: null, reason: "API_ERROR", detail: data.message };

          const code = data.weather?.[0]?.id || 800;
          const tempC = Math.round(data.main?.temp || 0);
          const windKmh = Math.round((data.wind?.speed || 0) * 3.6);
          const desc = data.weather?.[0]?.description || "";

          let icon;
          if (code >= 200 && code < 300) icon = "storm";
          else if (code >= 300 && code < 400) icon = "drizzle";
          else if (code >= 500 && code < 600) icon = "rain";
          else if (code >= 600 && code < 700) icon = "snow";
          else if (code >= 700 && code < 800) icon = "fog";
          else if (code === 800) icon = "clear";
          else icon = "cloudy";

          let alertText = null;
          if (code >= 200 && code < 300) alertText = "Storm warning";
          else if (code >= 600 && code < 700) alertText = "Snow/ice risk";
          else if (tempC <= 2) alertText = "Black ice risk";
          else if (windKmh > 60) alertText = "Strong crosswind";

          const result = {
            weather: {
              icon,
              temp_c: tempC,
              description: desc,
              wind_kmh: windKmh,
              alert: alertText,
              has_active_task: !!coords,
            },
          };
          cacheSet(cacheKey, result);
          return result;
        })(),
      ]);

      const traffic =
        trafficResult.status === "fulfilled" ? trafficResult.value : {};
      const weather =
        weatherResult.status === "fulfilled" ? weatherResult.value : {};

      return reply.send({
        traffic: traffic.traffic || null,
        weather: weather.weather || null,
        traffic_reason: traffic.reason || null,
        weather_reason: weather.reason || null,
      });
    } catch (err) {
      request.log.error({ err }, "drive-conditions error");
      return reply.send({
        traffic: null,
        weather: null,
        reason: "SERVER_ERROR",
      });
    }
  }
);

const start = async () => {
  try {
    await // ── POST /api/driver/sos ──────────────────────────────────────────────────
    fastify.post(
      "/api/driver/sos",
      { preHandler: [fastify.authenticate] },
      async (request, reply) => {
        const userId = request.user.id;
        const { latitude, longitude, message } = request.body || {};

        const lat =
          latitude != null && !isNaN(Number(latitude))
            ? Number(latitude)
            : null;
        const lon =
          longitude != null && !isNaN(Number(longitude))
            ? Number(longitude)
            : null;
        const msg =
          typeof message === "string"
            ? message.slice(0, 500)
            : "SOS - Acil Yardim";

        const client = await fastify.pg.connect();
        try {
          const { rows: dr } = await client.query(
            "SELECT id, company_id, assigned_vehicle_id FROM drivers WHERE user_id = $1",
            [userId]
          );
          if (!dr.length)
            return reply.code(404).send({ error: "DRIVER_NOT_FOUND" });
          const driver = dr[0];

          const { rows: recent } = await client.query(
            `SELECT id FROM alerts
       WHERE alert_type = 'SOS'
         AND metadata->>'driver_id' = $1
         AND created_at > NOW() - INTERVAL '60 seconds'
         AND is_resolved = false
       LIMIT 1`,
            [driver.id.toString()]
          );
          if (recent.length > 0) {
            return reply.code(429).send({
              error: "SOS_RATE_LIMITED",
              message: "SOS zaten aktif. Lutfen bekleyin.",
            });
          }

          const { rows: tasks } = await client.query(
            `SELECT id, task_no, title FROM tasks
       WHERE driver_id = $1 AND status IN ('accepted','in_progress')
       ORDER BY updated_at DESC LIMIT 1`,
            [driver.id]
          );
          const activeTask = tasks[0] || null;

          let vehicleInfo = null;
          if (driver.assigned_vehicle_id) {
            const { rows: veh } = await client.query(
              "SELECT plate_no, brand, model FROM vehicles WHERE id = $1",
              [driver.assigned_vehicle_id]
            );
            vehicleInfo = veh[0] || null;
          }

          const { rows: usr } = await client.query(
            "SELECT first_name, last_name, phone FROM users WHERE id = $1",
            [userId]
          );
          const user = usr[0] || {};
          const driverName =
            ((user.first_name || "") + " " + (user.last_name || "")).trim() ||
            "Surucu";

          const sosMetadata = {
            type: "SOS",
            driver_id: driver.id.toString(),
            driver_name: driverName,
            driver_phone: user.phone ?? null,
            latitude: lat,
            longitude: lon,
            vehicle: vehicleInfo
              ? vehicleInfo.plate_no +
                " - " +
                vehicleInfo.brand +
                " " +
                vehicleInfo.model
              : null,
            task_no: activeTask ? activeTask.task_no : null,
            task_title: activeTask ? activeTask.title : null,
            message: msg,
            sent_at: new Date().toISOString(),
          };

          const description = [
            "SOS: " + driverName,
            vehicleInfo ? vehicleInfo.plate_no : null,
            activeTask ? "Gorev: " + activeTask.task_no : null,
            user.phone ? "Tel: " + user.phone : null,
            lat != null && lon != null
              ? "Konum: " + lat.toFixed(5) + ", " + lon.toFixed(5)
              : null,
            msg !== "SOS - Acil Yardim" ? msg : null,
          ]
            .filter(Boolean)
            .join(" | ");

          await client.query(
            `INSERT INTO alerts (vehicle_id, alert_type, severity, title, description, metadata, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              driver.assigned_vehicle_id ?? null,
              "SOS",
              "critical",
              "SOS: " + driverName,
              description,
              JSON.stringify(sosMetadata),
              driver.company_id,
            ]
          );

          fastify.log.warn({ sosMetadata }, "[SOS] ALERT RECEIVED");

          return reply.send({
            success: true,
            message: "SOS alindi. Yardim yolda.",
            driver_name: driverName,
            task_no: activeTask ? activeTask.task_no : null,
          });
        } catch (err) {
          request.log.error({ err }, "[SOS] endpoint error");
          return reply.code(500).send({ error: "SOS_FAILED" });
        } finally {
          client.release();
        }
      }
    );

    fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`Server running on port ${PORT}`);
    fastify.mqtt = mqttClient;
    startGeofenceConsumer(fastify);

    // FEAT-007-EXT Virtual Telematics — 11 Ekim 2026, multi-tenant +
    // otomatik zamanlama (Cem'in kararı). Her gün 02:00'da fuelSnapshotBatch
    // -> reconcileBatch -> correlationBatch sırayla çalışır.
    scheduleDailyTelematicsBatch(fastify);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// ============================================
// SUPERADMIN DEVICES ENDPOINTS
// ============================================

// GET /api/superadmin/devices - Tüm cihazları listele
fastify.get(
  "/api/superadmin/devices",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { status } = request.query;
    const client = await fastify.pg.connect();
    try {
      let query = `
            SELECT 
                d.id, d.device_code, d.serial, d.serial_number, d.mac_address,
                d.hardware_version, d.firmware_version, d.chip_model,
                d.status, CASE WHEN d.last_seen_at > NOW() - INTERVAL '180 seconds' THEN true ELSE false END AS is_online, d.last_seen_at, d.last_ip_address,
                d.wifi_rssi, d.last_latitude, d.last_longitude,
                d.total_uptime_minutes, d.total_alerts_sent, d.error_count,
                d.company_id, d.vehicle_id, d.assigned_at,
                c.name as company_name,
                v.plate_no as vehicle_plate, v.brand as vehicle_brand, v.model as vehicle_model
            FROM devices d
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN vehicles v ON v.id = d.vehicle_id
        `;

      const params = [];
      if (status && status !== "all") {
        if (status === "offline") {
          query +=
            " WHERE (d.last_seen_at IS NULL OR d.last_seen_at <= NOW() - INTERVAL '180 seconds')";
        } else if (status === "online") {
          query += " WHERE d.last_seen_at > NOW() - INTERVAL '180 seconds'";
        } else {
          query += " WHERE d.status = $1";
          params.push(status);
        }
      }

      query += " ORDER BY d.created_at DESC";

      const { rows } = await client.query(query, params);

      // Stats
      const statsResult = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '180 seconds') as online,
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE status = 'active') as active,
                COUNT(*) FILTER (WHERE status = 'faulty' OR status = 'maintenance') as faulty
            FROM devices
        `);

      return {
        devices: rows,
        stats: statsResult.rows[0] || {},
      };
    } finally {
      client.release();
    }
  }
);

// GET /api/superadmin/devices/:id - Cihaz detayı
fastify.get(
  "/api/superadmin/devices/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { id } = request.params;
    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(
        `
            SELECT 
                d.*,
                c.name as company_name,
                v.plate_no as vehicle_plate, v.brand as vehicle_brand, v.model as vehicle_model
            FROM devices d
            LEFT JOIN companies c ON c.id = d.company_id
            LEFT JOIN vehicles v ON v.id = d.vehicle_id
            WHERE d.id = $1
        `,
        [id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: "Cihaz bulunamadı" });
      }

      // Logs
      const logsResult = await client.query(
        `
            SELECT * FROM device_logs 
            WHERE device_id = $1 
            ORDER BY created_at DESC 
            LIMIT 20
        `,
        [id]
      );

      return {
        device: rows[0],
        logs: logsResult.rows,
      };
    } finally {
      client.release();
    }
  }
);

// POST /api/superadmin/devices/:id/assign - Cihazı şirkete ata
fastify.post(
  "/api/superadmin/devices/:id/assign",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { id } = request.params;
    const { company_id, vehicle_id } = request.body;

    const client = await fastify.pg.connect();
    try {
      await client.query(
        `
            UPDATE devices 
            SET company_id = $1, vehicle_id = $2, assigned_at = NOW(), assigned_by = $3
            WHERE id = $4
        `,
        [company_id, vehicle_id || null, request.user.id, id]
      );

      return { success: true, message: "Cihaz atandı" };
    } finally {
      client.release();
    }
  }
);

// POST /api/superadmin/devices/:id/unassign - Atamayı kaldır
fastify.post(
  "/api/superadmin/devices/:id/unassign",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { id } = request.params;
    const client = await fastify.pg.connect();
    try {
      await client.query(
        `
            UPDATE devices 
            SET company_id = NULL, vehicle_id = NULL, assigned_at = NULL, assigned_by = NULL
            WHERE id = $1
        `,
        [id]
      );

      return { success: true, message: "Atama kaldırıldı" };
    } finally {
      client.release();
    }
  }
);

// PUT /api/superadmin/devices/:id - Cihaz güncelle
fastify.put(
  "/api/superadmin/devices/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Superadmin yetkisi gerekli" });
    }

    const { id } = request.params;
    const { status, notes } = request.body;

    const client = await fastify.pg.connect();
    try {
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex++}`);
        params.push(status);
      }
      if (notes !== undefined) {
        updates.push(`notes = $${paramIndex++}`);
        params.push(notes);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: "Güncellenecek alan yok" });
      }

      params.push(id);
      await client.query(
        `
            UPDATE devices SET ${updates.join(", ")} WHERE id = $${paramIndex}
        `,
        params
      );

      return { success: true, message: "Cihaz güncellendi" };
    } finally {
      client.release();
    }
  }
);

// moved to routes/superadmin.companies.js

// POST /api/superadmin/companies - Yeni şirket oluştur
fastify.post(
  "/api/superadmin/companies",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden - Super Admin only" });
    }

    const {
      name,
      slug,
      tax_id,
      address,
      city,
      phone,
      admin_email,
      admin_password,
      admin_first_name,
      admin_last_name,
      admin_phone,
      max_vehicles,
      max_drivers,
    } = request.body;

    if (!name || !slug || !admin_email || !admin_password) {
      return reply
        .code(400)
        .send({ error: "name, slug, admin_email, admin_password required" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");

      // 1. Şirketi oluştur
      const { rows: companyRows } = await client.query(
        `
      INSERT INTO companies (name, slug, tax_id, address, city, phone, settings)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
        [
          name,
          slug,
          tax_id || null,
          address || null,
          city || null,
          phone || null,
          JSON.stringify({
            max_vehicles: max_vehicles || 10,
            max_drivers: max_drivers || 10,
          }),
        ]
      );

      const company = companyRows[0];

      // 2. Admin kullanıcısını oluştur
      const bcrypt = require("bcrypt");
      const hashedPassword = await bcrypt.hash(admin_password, 10);

      const { rows: userRows } = await client.query(
        `
      INSERT INTO users (email, password_hash, role, company_id, first_name, last_name, phone)
      VALUES ($1, $2, 'company_admin', $3, $4, $5, $6)
      RETURNING id, email, role, company_id
    `,
        [
          admin_email,
          hashedPassword,
          company.id,
          admin_first_name || null,
          admin_last_name || null,
          admin_phone || null,
        ]
      );

      await client.query("COMMIT");

      return reply.code(201).send({
        company,
        admin: userRows[0],
        message: "Company and admin created successfully",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "23505") {
        return reply.code(400).send({ error: "Email or slug already exists" });
      }
      throw err;
    } finally {
      client.release();
    }
  }
);

// DELETE /api/superadmin/companies/:id - Şirket sil
fastify.delete(
  "/api/superadmin/companies/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden - Super Admin only" });
    }

    const { id } = request.params;
    const client = await fastify.pg.connect();
    try {
      const { rowCount } = await client.query(
        "DELETE FROM companies WHERE id = $1",
        [id]
      );
      if (rowCount === 0) {
        return reply.code(404).send({ error: "Company not found" });
      }
      return { message: "Company deleted successfully" };
    } finally {
      client.release();
    }
  }
);

// GET /api/superadmin/users - Tüm kullanıcıları listele
fastify.get(
  "/api/superadmin/users",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    if (request.user.role !== "super_admin") {
      return reply.code(403).send({ error: "Forbidden - Super Admin only" });
    }

    const client = await fastify.pg.connect();
    try {
      const { rows } = await client.query(`
      SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.created_at,
             c.name as company_name, c.slug as company_slug
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      ORDER BY u.created_at DESC
    `);
      return { users: rows };
    } finally {
      client.release();
    }
  }
);

// GET /api/locations/latest - Son konum verileri (harita için)
fastify.get(
  "/api/locations/latest",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const companyFilter =
        request.user.role === "super_admin" ? "" : "WHERE l.company_id = $1";
      const params =
        request.user.role === "super_admin" ? [] : [request.user.company_id];

      const { rows } = await client.query(
        `
      SELECT DISTINCT ON (l.device_id) 
        l.device_id,
        l.latitude,
        l.longitude,
        l.speed,
        l.heading,
        l.altitude,
        l.time,
        v.plate_no,
        v.id as vehicle_id,
        v.status as vehicle_status
      FROM locations l
      LEFT JOIN vehicles v ON v.esp32_device_id = l.device_id
      ${companyFilter}
      ORDER BY l.device_id, l.time DESC
    `,
        params
      );
      return { locations: rows };
    } finally {
      client.release();
    }
  }
);

start();

// ═══════════════════════════════════════════════════════════════
// GET SINGLE TASK DETAIL FOR DRIVER
// ═══════════════════════════════════════════════════════════════
fastify.get(
  "/api/driver/tasks/:id",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    try {
      // Driver bilgisini al
      const { rows: driverRows } = await fastify.pg.query(
        "SELECT id, company_id FROM drivers WHERE user_id = $1",
        [userId]
      );

      if (driverRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const driverId = driverRows[0].id;

      // Task detayını al
      const { rows } = await fastify.pg.query(
        `
      SELECT t.*, 
             v.plate_no as vehicle_plate, v.brand as vehicle_brand, v.model as vehicle_model,
             u.first_name as created_by_name
      FROM tasks t
      LEFT JOIN vehicles v ON t.vehicle_id = v.id
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.id = $1 AND t.driver_id = $2
    `,
        [id, driverId]
      );

      if (rows.length === 0) {
        return reply
          .code(404)
          .send({ error: "Task not found or unauthorized" });
      }

      return rows[0];
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET TASK OFFERS FOR DRIVER
// ═══════════════════════════════════════════════════════════════
fastify.get(
  "/api/task-offers",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const userId = request.user.id;
    const { status } = request.query;

    try {
      const { rows: driverRows } = await fastify.pg.query(
        "SELECT id, company_id FROM drivers WHERE user_id = $1",
        [userId]
      );

      if (driverRows.length === 0) {
        return reply.code(404).send({ error: "Driver not found" });
      }

      const driverId = driverRows[0].id;

      let query = `
      SELECT tof.*, t.task_no, t.title, t.route_json, t.planned_start,
             v.plate_no as vehicle_plate
      FROM task_offers tof
      JOIN tasks t ON tof.task_id = t.id
      LEFT JOIN vehicles v ON t.vehicle_id = v.id
      WHERE tof.driver_id = $1
    `;
      const params = [driverId];

      if (status) {
        query += " AND tof.status = $2";
        params.push(status);
      }

      query += " ORDER BY tof.created_at DESC";

      const { rows } = await fastify.pg.query(query, params);
      return rows;
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// CONTACT FORM - Privacy & Delete Account
// ═══════════════════════════════════════════════════════════════
fastify.post("/api/contact", async (request, reply) => {
  const { name, email, subject, reason, message, type, lang } = request.body;

  if (!name || !email || !type) {
    return reply.code(400).send({ error: "Missing required fields" });
  }

  const nodemailer = require("nodemailer");

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const isDeleteRequest = type === "delete_account";
  const toAddress = "info@tulipfleet.com";

  const subjectLine = isDeleteRequest
    ? "[ACCOUNT DELETION] " + name + " <" + email + ">"
    : "[PRIVACY REQUEST] " + (subject || "General") + " - " + name;

  const actionWarning = isDeleteRequest
    ? '<p style="color:#e53935; margin-top:16px;"><strong>Action required: Process this account deletion request within 30 days.</strong></p>'
    : "";

  const htmlBody =
    '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">' +
    '<h2 style="color: ' +
    (isDeleteRequest ? "#e53935" : "#5E72E4") +
    ';">' +
    (isDeleteRequest ? "Account Deletion Request" : "Privacy Contact Form") +
    "</h2>" +
    '<table style="width:100%; border-collapse: collapse;">' +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold; width:140px;">Name</td><td style="padding:8px;">' +
    name +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Email</td><td style="padding:8px;">' +
    email +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Type</td><td style="padding:8px;">' +
    type +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Subject/Reason</td><td style="padding:8px;">' +
    (subject || reason || "-") +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Language</td><td style="padding:8px;">' +
    (lang || "en") +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Message</td><td style="padding:8px;">' +
    (message || "-") +
    "</td></tr>" +
    '<tr><td style="padding:8px; background:#f5f5f5; font-weight:bold;">Date</td><td style="padding:8px;">' +
    new Date().toISOString() +
    "</td></tr>" +
    "</table>" +
    actionWarning +
    "</div>";

  try {
    await transporter.sendMail({
      from: '"TulipFleet" <' + process.env.SMTP_USER + ">",
      to: toAddress,
      replyTo: email,
      subject: subjectLine,
      html: htmlBody,
    });

    return reply.code(200).send({ success: true });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: "Mail send failed" });
  }
});
// ============================================

// ── DELETE /api/users/me ─────────────────────────────────
// Apple App Store Guidelines 5.1.1 — hesap silme zorunluluğu
// Soft delete: PII silinir, kayıtlar anonim kalır
fastify.delete(
  "/api/users/me",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const userId = request.user.id;
    const { password } = request.body || {};

    if (!password) {
      return reply
        .code(400)
        .send({ error: "Password required to delete account" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");

      const { rows: userRows } = await client.query(
        "SELECT password_hash FROM users WHERE id = $1 AND is_active = true",
        [userId]
      );
      if (userRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "User not found" });
      }
      const valid = await bcrypt.compare(password, userRows[0].password_hash);
      if (!valid) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "Incorrect password" });
      }

      const anonymizedEmail = "deleted_" + userId + "@deleted.tulipfleet.com";
      const deletedAt = new Date().toISOString();

      await client.query(
        "UPDATE users SET is_active=false, email=$1, first_name='Deleted', last_name='User', phone=NULL, push_enabled=false, updated_at=NOW() WHERE id=$2",
        [anonymizedEmail, userId]
      );

      await client.query(
        "UPDATE drivers SET status='offline', assigned_vehicle_id=NULL, updated_at=NOW() WHERE user_id=$1",
        [userId]
      );

      await client.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
        userId,
      ]);

      await client.query("COMMIT");
      request.log.info({ userId, deletedAt }, "Account deleted (anonymized)");
      return reply
        .code(200)
        .send({ success: true, message: "Account deleted successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to delete account" });
    } finally {
      client.release();
    }
  }
);
