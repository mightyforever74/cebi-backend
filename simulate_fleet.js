"use strict";
/**
 * fleet-sim v3 "Filo Modu" - simulate_fleet.js (TEK daemon, TEK yazar/cihaz)
 * Plan: SESSION_NOTES (d197ffe) + Cem rotuslari (31.07): hic-konumsuz araca
 * tek seferlik sirket-bazli US koordinati; agresif profil 70-92 km/h (NL tir
 * gercekligi, monitor false-positive onlemi).
 *
 * IKI MOD (her cihaz icin tikte otomatik secilir):
 *  - HAREKET: in_progress gorevi + cozulebilir koordinati (route_json sayisal
 *    -> enterprise.dispatch_tasks JOIN) olan aracin cihazi. v2 fizigi: yazilan
 *    hiz = adimi ureten hiz; kalkis rampasi; varista yavaslamali son adim;
 *    varis sonrasi hiz-0 sabit. Baslangic: taze (<10 dk) son konum varsa
 *    ORADAN (restart isinlanmasi yok), yoksa pickup'tan.
 *  - KEEPALIVE: kalan tum esp32_device_id'li araclar - son bilinen konum,
 *    hiz 0. Hic konumu olmayana: sirket usunden tek seferlik seed (deterministik
 *    jitter'li), sonra normal keepalive.
 *
 * FAZ KAYDIRMA: hash(device_id) % TICK_S saniye ofset - IOPS duzlesir + gercek
 * GSM/GPS modul davranisi (Cem gerekce cifti). 1 sn'lik master scheduler.
 * STIL: hash%3 -> sakin 55-75 / normal 60-90 / agresif 70-92 (sert salinim).
 * KESIF: 60 sn'de bir DB'den filo + gorev seti tazelenir.
 * PROD IZOLASYONU: yalniz staging'de kosar (backend-staging .env). Prod'daki
 * eski keepalive'a DOKUNULMAZ.
 *
 * KULLANIM: cd /opt/fleet/backend-staging && \
 *   pm2 start simulate_fleet.js --name fleet-sim-v3 [-- --interval 30]
 */

const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, ".env") });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const TICK_S = Math.max(10, parseInt(arg("interval", "30"), 10));
const DISCOVERY_MS = 60 * 1000;
const FRESH_RESUME_MIN = 10;

// Sirket-bazli us koordinatlari (hic-konumsuz arac seed'i - Cem rotusu #1)
const COMPANY_BASES = {
  "Dobbe Transport": { lat: 51.8983, lng: 4.4210, note: "Waalhaven, Rotterdam" },
  "Tulip Lojistik": { lat: 52.1094, lng: 5.0416, note: "Lage Weide, Utrecht" },
};
const DEFAULT_BASE = { lat: 52.0907, lng: 5.1214, note: "Utrecht merkez (fallback)" };

// Stil profilleri (Cem rotusu #2: agresif 70-92)
const STYLES = [
  { name: "sakin", min: 55, max: 75, wobble: 3 },
  { name: "normal", min: 60, max: 90, wobble: 4 },
  { name: "agresif", min: 70, max: 92, wobble: 6 },
];

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
function havM(a, b) {
  const dLa = toRad(b.lat - a.lat), dLo = toRad(b.lng - a.lng);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function brg(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.atan2(y, x);
}
function step(p, b, d) {
  const dr = d / R, la1 = toRad(p.lat), lo1 = toRad(p.lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lng: toDeg(lo2) };
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function numPair(o) {
  if (!o) return null;
  const lat = Number(o.lat ?? o.latitude), lng = Number(o.lng ?? o.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
// device_id -> durum
// { mode, plate, style, offsetS, nextDueMs, pos, vKmh, dest, taskNo, arrived, lastKnown, seeded }
const fleet = new Map();

async function discover() {
  const { rows: vehicles } = await client.query(`
    SELECT v.esp32_device_id AS device_id, v.plate_no, c.name AS company,
           l.latitude AS last_lat, l.longitude AS last_lng, l."time" AS last_time
      FROM public.vehicles v
      JOIN public.companies c ON c.id = v.company_id
      LEFT JOIN LATERAL (
        SELECT latitude, longitude, "time" FROM public.locations
         WHERE device_id = v.esp32_device_id ORDER BY "time" DESC LIMIT 1
      ) l ON TRUE
     WHERE v.esp32_device_id IS NOT NULL`);

  const { rows: moving } = await client.query(`
    SELECT v.esp32_device_id AS device_id, t.task_no, t.route_json,
           d.pickup_location, d.dropoff_location
      FROM public.tasks t
      JOIN public.vehicles v ON v.id = t.vehicle_id
      LEFT JOIN enterprise.dispatch_tasks d ON d.id = t.enterprise_dispatch_task_id
     WHERE t.status = 'in_progress' AND v.esp32_device_id IS NOT NULL`);

  const movingByDevice = new Map();
  for (const m of moving) {
    const o = numPair(m.route_json && m.route_json.origin) || numPair(m.pickup_location);
    const dst = numPair(m.route_json && m.route_json.destination) || numPair(m.dropoff_location);
    if (o && dst) movingByDevice.set(m.device_id, { taskNo: m.task_no, origin: o, dest: dst });
    // koordinat cozulmezse: hareket YOK, arac keepalive'da kalir (durust)
  }

  const now = Date.now();
  for (const v of vehicles) {
    const id = v.device_id;
    const h = hashStr(id);
    let st = fleet.get(id);
    if (!st) {
      st = {
        plate: v.plate_no,
        style: STYLES[h % STYLES.length],
        offsetS: h % TICK_S,
        nextDueMs: now + (h % TICK_S) * 1000,
        mode: "keepalive", pos: null, vKmh: 0, dest: null, taskNo: null,
        arrived: false, lastKnown: null, seeded: false, company: v.company,
      };
      fleet.set(id, st);
      console.log(`[v3] filo+ ${v.plate_no} (${id}) stil=${st.style.name} ofset=${st.offsetS}s`);
    }
    st.lastKnown = v.last_lat != null ? { lat: Number(v.last_lat), lng: Number(v.last_lng), time: v.last_time } : null;

    const mv = movingByDevice.get(id);
    if (mv && st.mode !== "hareket") {
      // Harekete gecis: taze son konumdan devam, yoksa pickup'tan
      const fresh = st.lastKnown && (now - new Date(st.lastKnown.time).getTime()) < FRESH_RESUME_MIN * 60 * 1000;
      st.mode = "hareket";
      st.taskNo = mv.taskNo;
      st.dest = mv.dest;
      st.pos = fresh ? { lat: st.lastKnown.lat, lng: st.lastKnown.lng } : { ...mv.origin };
      st.vKmh = 0;
      st.arrived = false;
      console.log(`[v3] HAREKET ${st.plate} gorev=${mv.taskNo} baslangic=${fresh ? "son-konum" : "pickup"} hedefe=${(havM(st.pos, st.dest) / 1000).toFixed(1)}km`);
    } else if (!mv && st.mode === "hareket") {
      st.mode = "keepalive";
      console.log(`[v3] KEEPALIVE ${st.plate} (gorev bitti/cekildi)`);
      st.taskNo = null; st.dest = null; st.arrived = false;
    } else if (mv && st.mode === "hareket" && mv.taskNo !== st.taskNo) {
      st.taskNo = mv.taskNo; st.dest = mv.dest; st.arrived = false;
      console.log(`[v3] ROTA GUNCELLENDI ${st.plate} gorev=${mv.taskNo}`);
    }
  }
  // DB'den silinen cihazlari düşür
  for (const id of fleet.keys()) {
    if (!vehicles.find((v) => v.device_id === id)) fleet.delete(id);
  }
}

async function writeLoc(deviceId, p, speed) {
  await client.query(
    `INSERT INTO public.locations (device_id, latitude, longitude, speed, "time", "timestamp", created_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())`,
    [deviceId, p.lat.toFixed(7), p.lng.toFixed(7), speed.toFixed(2)]
  );
}

async function tickDevice(id, st) {
  if (st.mode === "hareket" && st.dest) {
    if (st.arrived) return writeLoc(id, st.pos, 0);
    const remain = havM(st.pos, st.dest);
    const s = st.style;
    if (st.vKmh < s.min) st.vKmh = Math.min(s.min, st.vKmh + 12);
    else {
      st.vKmh = Math.min(s.max, Math.max(s.min, st.vKmh + (Math.random() - 0.5) * 2 * s.wobble));
    }
    if (remain < 1500) st.vKmh = Math.max(20, st.vKmh * 0.6);
    let stepM = (st.vKmh / 3.6) * TICK_S;
    if (stepM >= remain) {
      st.vKmh = (remain / TICK_S) * 3.6;
      st.pos = { ...st.dest };
      st.arrived = true;
      await writeLoc(id, st.pos, st.vKmh);
      console.log(`[v3] VARIS ${st.plate} gorev=${st.taskNo} son-adim=${st.vKmh.toFixed(1)}km/h`);
      return;
    }
    st.pos = step(st.pos, brg(st.pos, st.dest), stepM);
    return writeLoc(id, st.pos, st.vKmh);
  }
  // keepalive
  if (st.lastKnown) {
    return writeLoc(id, { lat: st.lastKnown.lat, lng: st.lastKnown.lng }, 0);
  }
  if (!st.seeded) {
    const base = COMPANY_BASES[st.company] || DEFAULT_BASE;
    const h = hashStr(id);
    // deterministik jitter ~ +-250m (araclar ust uste binmesin)
    const jLat = ((h % 100) - 50) / 20000, jLng = (((h >> 7) % 100) - 50) / 20000;
    const p = { lat: base.lat + jLat, lng: base.lng + jLng };
    st.seeded = true;
    st.lastKnown = { lat: p.lat, lng: p.lng, time: new Date() };
    console.log(`[v3] SEED ${st.plate} us=${base.note}`);
    return writeLoc(id, p, 0);
  }
}

async function main() {
  await client.connect();
  await discover();
  setInterval(() => discover().catch((e) => console.error("[v3] kesif hatasi:", e.message)), DISCOVERY_MS);

  setInterval(async () => {
    const now = Date.now();
    for (const [id, st] of fleet) {
      if (now >= st.nextDueMs) {
        st.nextDueMs = now + TICK_S * 1000;
        try {
          await tickDevice(id, st);
        } catch (e) {
          console.error(`[v3] tik hatasi ${st.plate}:`, e.message);
        }
      }
    }
  }, 1000);

  console.log(`[v3] Filo Modu basladi: ${fleet.size} cihaz, tik=${TICK_S}s, kesif=${DISCOVERY_MS / 1000}s`);
}

const bye = async () => { try { await client.end(); } catch (e) {} process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);

main().catch((e) => { console.error("[v3] FATAL:", e); process.exit(1); });
