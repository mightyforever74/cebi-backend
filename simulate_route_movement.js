"use strict";
/**
 * fleet-sim v2 - Canli Rota Hareket Simulatoru (simulate_route_movement.js)
 * Plan kaydi: SESSION_NOTES_decision-support-engine.md madde 4 (873ef0c, Cem onayi).
 *
 * NE YAPAR: Verilen gorevin pickup -> dropoff hattinda araci DURUST fizikle
 * yurutur: her tikta once hiz uretilir (kalkis/varis rampali), adim mesafesi
 * = hiz x tik suresi; locations'a yazilan speed = adimi ureten hiz.
 * (Cem duzeltmesi #2: 80 km/h + 30 sn => ~666.7 m; telemetri tutarli okur.)
 *
 * KOORDINAT COZUM SIRASI (Cem duzeltmesi #1 - sozluk YOK, sahte merkez YOK):
 *   a) public.tasks.route_json origin/destination SAYISAL lat/lng iceriyorsa
 *   b) enterprise.dispatch_tasks.pickup_location/dropoff_location jsonb
 *      (enterprise_dispatch_task_id JOIN - kanitli: TLP-26-00010/11 dolu)
 *   c) TODO(HERE penceresi): HERE Geocoding fallback
 *   d) Hicbiri yoksa: SKIP + log. Simulasyon baslamaz.
 *
 * YAZIM KURALLARI (FEAT-007-EXT seed.js kanitli gercekleri):
 *   - locations.device_id = vehicles.esp32_device_id
 *   - uc zaman kolonu (time, timestamp, created_at) senkron NOW
 *   - fleetadmin/DATABASE_URL yetkisi (backend .env)
 *
 * VARISTA: arac durur, konum sabit hizla-0 keepalive olarak yazilmaya devam
 * eder. Gorevi otomatik COMPLETE ETMEZ; --complete bayragi verilirse gercek
 * is akisiyla kapatir (staging API login + PUT complete - DB bypass YOK).
 *
 * KULLANIM (staging, /opt/fleet/backend-staging kokunde):
 *   node simulate_route_movement.js --task TLP-26-00010 [--interval 30]
 *        [--min-speed 60] [--max-speed 90] [--complete]
 *   pm2 start simulate_route_movement.js --name fleet-sim-route -- --task TLP-26-00010
 *   --complete icin env: SIM_DRIVER_EMAIL, SIM_DRIVER_PASSWORD, SIM_API_URL
 */

const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── CLI ──
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const TASK_NO = arg("task", null);
const INTERVAL_S = Math.max(5, parseInt(arg("interval", "30"), 10));
const MIN_KMH = parseFloat(arg("min-speed", "60"));
const MAX_KMH = parseFloat(arg("max-speed", "90"));
const DO_COMPLETE = arg("complete", false) === true;

if (!TASK_NO) {
  console.error("KULLANIM: node simulate_route_movement.js --task TLP-26-XXXXX");
  process.exit(1);
}

// ── Geo yardimcilari ──
const R_EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

function bearingRad(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.atan2(y, x);
}

// Buyuk daire uzerinde brg yonunde d metre ilerle
function stepFrom(p, brg, dMeters) {
  const dr = dMeters / R_EARTH;
  const lat1 = toRad(p.lat);
  const lng1 = toRad(p.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brg)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

function numPair(o) {
  if (!o) return null;
  const lat = Number(o.lat ?? o.latitude);
  const lng = Number(o.lng ?? o.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// ── Hiz profili: kalkis rampasi + seyir salinimi + varis yavaslamasi ──
function cruiseSpeed(prevKmh) {
  const wobble = (Math.random() - 0.5) * 8; // +-4 km/h
  let v = prevKmh + wobble;
  return Math.min(MAX_KMH, Math.max(MIN_KMH, v));
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1) Gorev + arac + cihaz zinciri
  const { rows: taskRows } = await client.query(
    `SELECT t.id, t.task_no, t.status, t.route_json, t.enterprise_dispatch_task_id,
            t.vehicle_id, v.esp32_device_id, v.plate_no
       FROM public.tasks t
       LEFT JOIN public.vehicles v ON v.id = t.vehicle_id
      WHERE t.task_no = $1`,
    [TASK_NO]
  );
  if (taskRows.length === 0) {
    console.error(`[sim] SKIP: gorev bulunamadi: ${TASK_NO}`);
    process.exit(2);
  }
  const task = taskRows[0];
  if (!task.esp32_device_id) {
    console.error(`[sim] SKIP: ${TASK_NO} aracinin esp32_device_id'si yok (vehicle_id=${task.vehicle_id})`);
    process.exit(2);
  }

  // 2) Koordinat cozumu (a -> b -> SKIP)
  let origin = numPair(task.route_json && task.route_json.origin);
  let dest = numPair(task.route_json && task.route_json.destination);
  let coordSource = "route_json";
  if ((!origin || !dest) && task.enterprise_dispatch_task_id) {
    const { rows: ent } = await client.query(
      `SELECT pickup_location, dropoff_location
         FROM enterprise.dispatch_tasks WHERE id = $1`,
      [task.enterprise_dispatch_task_id]
    );
    if (ent.length > 0) {
      origin = origin || numPair(ent[0].pickup_location);
      dest = dest || numPair(ent[0].dropoff_location);
      coordSource = "enterprise.dispatch_tasks";
    }
  }
  if (!origin || !dest) {
    console.error(
      `[sim] SKIP: ${TASK_NO} icin sayisal koordinat kanitlanamadi ` +
        `(route_json metin, enterprise kaydi yok/eksik). Sozluk fallback BILINCLI yok.`
    );
    process.exit(2);
  }

  const totalM = haversineM(origin, dest);
  console.log(
    `[sim] BASLADI ${TASK_NO} | ${task.plate_no} (${task.esp32_device_id}) | ` +
      `kaynak=${coordSource} | mesafe=${(totalM / 1000).toFixed(1)} km | ` +
      `tik=${INTERVAL_S}s hiz=${MIN_KMH}-${MAX_KMH} km/h | tahmini sure=` +
      `${Math.round(totalM / ((((MIN_KMH + MAX_KMH) / 2) / 3.6)) / 60)} dk`
  );

  let pos = { ...origin };
  let vKmh = 0; // kalkis: 0'dan rampa
  let traveledM = 0;
  let arrived = false;

  async function writeLocation(p, speedKmh) {
    await client.query(
      `INSERT INTO public.locations
         (device_id, latitude, longitude, speed, "time", "timestamp", created_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())`,
      [task.esp32_device_id, p.lat.toFixed(7), p.lng.toFixed(7), speedKmh.toFixed(2)]
    );
  }

  async function completeViaApi() {
    const api = process.env.SIM_API_URL || "https://staging-api.tulipfleet.com";
    const email = process.env.SIM_DRIVER_EMAIL;
    const pass = process.env.SIM_DRIVER_PASSWORD;
    if (!email || !pass) {
      console.error("[sim] --complete istendi ama SIM_DRIVER_EMAIL/PASSWORD env yok - atlandi.");
      return;
    }
    try {
      const login = await fetch(`${api}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pass }),
      });
      const lj = await login.json();
      if (!lj.token) throw new Error("login token yok");
      const res = await fetch(`${api}/api/driver/tasks/${task.id}/complete`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${lj.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      console.log(`[sim] complete API: HTTP ${res.status}`);
    } catch (e) {
      console.error("[sim] complete API hatasi:", e.message);
    }
  }

  const tick = async () => {
    try {
      if (arrived) {
        // Varis sonrasi: hiz-0 keepalive (konum sabit, cihaz cevrimici gorunur)
        await writeLocation(dest, 0);
        return;
      }
      const remainM = haversineM(pos, dest);

      // Hiz karari: kalkis rampasi (+12 km/h/tik), varisa <=1.5 km kala yavasla
      if (vKmh < MIN_KMH) vKmh = Math.min(MIN_KMH, vKmh + 12);
      else vKmh = cruiseSpeed(vKmh);
      if (remainM < 1500) vKmh = Math.max(20, vKmh * 0.6);

      let stepM = (vKmh / 3.6) * INTERVAL_S;

      if (stepM >= remainM) {
        // Son adim: isinlanma yok - hiz, kalan mesafeyi tam karsilayacak sekilde
        // yeniden hesaplanir (yazilan hiz = gercek adim hizi sozlesmesi korunur)
        vKmh = (remainM / INTERVAL_S) * 3.6;
        pos = { ...dest };
        traveledM += remainM;
        arrived = true;
        await writeLocation(pos, vKmh);
        console.log(
          `[sim] VARIS ${TASK_NO} | toplam=${(traveledM / 1000).toFixed(1)} km | ` +
            `son adim hizi=${vKmh.toFixed(1)} km/h. Konum kilitlendi (hiz-0 keepalive).`
        );
        if (DO_COMPLETE) await completeViaApi();
        return;
      }

      const brg = bearingRad(pos, dest);
      pos = stepFrom(pos, brg, stepM);
      traveledM += stepM;
      await writeLocation(pos, vKmh);
      console.log(
        `[sim] ${TASK_NO} ${((traveledM / totalM) * 100).toFixed(1)}% | ` +
          `${vKmh.toFixed(0)} km/h | adim=${stepM.toFixed(0)} m | kalan=${((remainM - stepM) / 1000).toFixed(1)} km`
      );
    } catch (e) {
      console.error("[sim] tik hatasi (devam edilir):", e.message);
    }
  };

  await tick();
  const iv = setInterval(tick, INTERVAL_S * 1000);
  const bye = async () => {
    clearInterval(iv);
    await client.end();
    console.log("[sim] durduruldu.");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => {
  console.error("[sim] FATAL:", e);
  process.exit(1);
});
