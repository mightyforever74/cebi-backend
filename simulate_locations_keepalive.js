// TulipFleet — Demo location keepalive daemon
// Her 30 saniyede bir aynı 4 statik konuma fresh timestamp yazar.
// Araçlar HAREKET ETMEZ, sadece "online" görünmeye devam eder.
//
// Başlatma: pm2 start /opt/fleet/backend/simulate_locations_keepalive.js --name fleet-sim
// Durdurma: pm2 stop fleet-sim

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMPANY = 'efbaa346-cde9-489a-b3e9-6fd61df0c121';
const INTERVAL_MS = 30 * 1000;

// 4 araç için statik gerçekçi konumlar
const POSITIONS = [
  // Pieter — Volvo FH16 — A2 otoyolu Vinkeveen, Utrecht yönünde
  { plate: 'BX-TR-42', lat: 52.2156, lng: 4.9281, speed: 84, heading: 165 },
  // Anna — DAF XF 480 — Sloterdijk Depo, Amsterdam
  { plate: 'RD-NL-78', lat: 52.4012, lng: 4.8067, speed: 0,  heading: 0   },
  // Mehmet — MAN TGX 18.510 — Schiphol Cargo gümrük noktası
  { plate: 'AH-05-KL', lat: 52.3025, lng: 4.7639, speed: 0,  heading: 270 },
  // Jan — Scania R450 — Rotterdam Coolport (Maasvlakte II)
  { plate: 'NL-92-VB', lat: 51.9450, lng: 4.0156, speed: 0,  heading: 90  }
];

const plateToDevice = {};

async function refresh() {
  const now = new Date();
  let count = 0;
  for (const pos of POSITIONS) {
    const deviceId = plateToDevice[pos.plate];
    if (!deviceId) continue;
    try {
      await pool.query(
        `INSERT INTO locations
           (time, device_id, latitude, longitude, speed, heading, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [now, deviceId, pos.lat, pos.lng, pos.speed, pos.heading, COMPANY]
      );
      count++;
    } catch (err) {
      console.error('Refresh error for ' + pos.plate + ':', err.message);
    }
  }
  console.log('[' + now.toISOString() + '] Refreshed ' + count + ' locations');
}

async function init() {
  // Eski Dobbe locations'ını temizle (önceki test seed'lerini sil)
  const del = await pool.query(
    'DELETE FROM locations WHERE company_id = $1',
    [COMPANY]
  );
  console.log('Cleaned ' + del.rowCount + ' old Dobbe location records.');

  // Vehicle plate -> esp32_device_id eşleştirme tablosu
  const { rows: vehicles } = await pool.query(
    `SELECT plate_no, esp32_device_id FROM vehicles
     WHERE company_id = $1 AND esp32_device_id IS NOT NULL`,
    [COMPANY]
  );
  vehicles.forEach(v => { plateToDevice[v.plate_no] = v.esp32_device_id; });
  console.log('Loaded ' + vehicles.length + ' vehicles for refresh loop.');
  console.log('Refresh interval: ' + (INTERVAL_MS / 1000) + 's');
}

(async () => {
  await init();
  await refresh();
  setInterval(refresh, INTERVAL_MS);
})().catch(err => { console.error('Fatal:', err); process.exit(1); });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing pool...');
  await pool.end();
  process.exit(0);
});
