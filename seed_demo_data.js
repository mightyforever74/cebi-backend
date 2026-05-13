// TulipFleet Demo - Eksik Data Seed
// 2 overdue task + 6 alert ekler. Idempotent (ON CONFLICT DO NOTHING).
//
// Calistirma: docker exec fleet-backend node /app/seed_demo_data.js

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMPANY = 'efbaa346-cde9-489a-b3e9-6fd61df0c121';
const ADMIN_USER = '81e765a9-38d7-47fb-935a-f35abd5483fe';

const VEHICLES = {
  PIETER: 'b1b2b3b4-e5f6-7890-abcd-ef0000000001',
  ANNA:   'b1b2b3b4-e5f6-7890-abcd-ef0000000002',
  MEHMET: 'b1b2b3b4-e5f6-7890-abcd-ef0000000003',
  JAN:    'b1b2b3b4-e5f6-7890-abcd-ef0000000004',
};

const DRIVERS = {
  PIETER: 'd1d2d3d4-e5f6-7890-abcd-ef0000000001',
  ANNA:   'd1d2d3d4-e5f6-7890-abcd-ef0000000002',
  MEHMET: 'd1d2d3d4-e5f6-7890-abcd-ef0000000003',
  JAN:    '29504754-0ab6-4e5a-b71d-fe4558369c88',
};

const NAMES = {
  PIETER: 'Pieter van den Berg',
  ANNA:   'Anna Jansen',
  MEHMET: 'Mehmet Yilmaz',
  JAN:    'Jan de Vries',
};

const COORDS = {
  PIETER: { lat: 52.2156, lng: 4.9281 },
  ANNA:   { lat: 52.4012, lng: 4.8067 },
  MEHMET: { lat: 52.3025, lng: 4.7639 },
  JAN:    { lat: 51.9450, lng: 4.0156 },
};

const OVERDUE_TASKS = [
  {
    task_no: 'AMS-0145',
    driver: 'MEHMET',
    title: 'Schiphol Cargo - Dusseldorf gumruk transit',
    description: 'Soguk zincir, 12 palet ilac',
    start_location: 'Schiphol Cargo, Amsterdam',
    end_location: 'Dusseldorf Distribution Center',
    actual_start_h: 4,
    planned_end_h: 2,
    distance_km: 220.5,
  },
  {
    task_no: 'RTM-0089',
    driver: 'JAN',
    title: 'Rotterdam Coolport - Antwerpen teslim',
    description: 'Soguk zincir, 8 palet',
    start_location: 'Rotterdam Coolport',
    end_location: 'Antwerpen Cold Storage',
    actual_start_h: 3,
    planned_end_h: 1,
    distance_km: 105.0,
  },
];

const ALERTS = [
  { type: 'sos',            sev: 'critical', title: 'SOS: Mehmet Yilmaz | AH-05-KL | Schiphol Cargo',         desc: 'Surucu acil durum butonuna basti. Konum: Schiphol Cargo gumruk noktasi.', driver: 'MEHMET', mins: 12,  resolved: false },
  { type: 'harsh_brake',    sev: 'warning',  title: 'Sert Fren | BX-TR-42 | Pieter van den Berg',             desc: 'A2 otoyolu, Vinkeveen civari',                                            driver: 'PIETER', mins: 35,  resolved: false },
  { type: 'speeding',       sev: 'warning',  title: 'Hiz Ihlali (98 km/h, limit 90) | BX-TR-42 | Pieter',     desc: 'A2 otoyolu, hiz limiti asildi',                                           driver: 'PIETER', mins: 60,  resolved: false },
  { type: 'geofence_entry', sev: 'info',     title: 'Bolge Girisi: Sloterdijk Depo | RD-NL-78 | Anna',        desc: 'Anna depoya geldi, yukleme baslayacak',                                   driver: 'ANNA',   mins: 120, resolved: true  },
  { type: 'geofence_exit',  sev: 'info',     title: 'Bolge Cikisi: Coolport Maasvlakte | NL-92-VB | Jan',     desc: 'Jan teslimat sonrasi bolgeden ayrildi',                                   driver: 'JAN',    mins: 180, resolved: true  },
  { type: 'task_started',   sev: 'info',     title: 'Gorev Baslatildi: AMS-0145 | AH-05-KL',                  desc: 'Mehmet AMS-0145 gorevini kabul etti ve basladi',                          driver: 'MEHMET', mins: 240, resolved: true  },
];

(async () => {
  const now = new Date();

  console.log('=== OVERDUE TASKS ===');
  for (const t of OVERDUE_TASKS) {
    const actualStart    = new Date(now.getTime() - t.actual_start_h * 3600 * 1000);
    const plannedEnd     = new Date(now.getTime() - t.planned_end_h * 3600 * 1000);
    const plannedStart   = new Date(actualStart.getTime() - 1800 * 1000);

    const result = await pool.query(
      `INSERT INTO tasks (
         id, task_no, company_id, driver_id, vehicle_id,
         title, description, start_location, end_location,
         status, priority,
         scheduled_start, scheduled_end, planned_start, planned_end, actual_start,
         total_distance_km, distance_source,
         created_by, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4,
         $5, $6, $7, $8,
         'in_progress', 'normal',
         $9, $10, $9, $10, $11,
         $12, 'manual',
         $13, $9, NOW()
       ) ON CONFLICT (task_no) DO NOTHING
       RETURNING task_no`,
      [
        t.task_no, COMPANY, DRIVERS[t.driver], VEHICLES[t.driver],
        t.title, t.description, t.start_location, t.end_location,
        plannedStart, plannedEnd, actualStart,
        t.distance_km,
        ADMIN_USER
      ]
    );
    if (result.rowCount > 0) {
      console.log('  + ' + t.task_no + ' (' + NAMES[t.driver] + ') -> in_progress, ' + t.planned_end_h + 'h OVERDUE');
    } else {
      console.log('  = ' + t.task_no + ' zaten var, atlandi');
    }
  }

  console.log('');
  console.log('=== ALERTS ===');
  for (const a of ALERTS) {
    const createdAt  = new Date(now.getTime() - a.mins * 60 * 1000);
    const resolvedAt = a.resolved ? new Date(createdAt.getTime() + 5 * 60 * 1000) : null;
    const c = COORDS[a.driver];

    try {
      await pool.query(
        `INSERT INTO alerts (
           id, alert_type, severity, title, description,
           company_id, vehicle_id,
           latitude, longitude,
           is_resolved, resolved_at, resolved_by,
           created_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4,
           $5, $6,
           $7, $8,
           $9, $10, $11,
           $12
         )`,
        [
          a.type, a.sev, a.title, a.desc,
          COMPANY, VEHICLES[a.driver],
          c.lat, c.lng,
          a.resolved, resolvedAt, a.resolved ? ADMIN_USER : null,
          createdAt
        ]
      );
      const status = a.resolved ? 'cozulmus' : 'AKTIF';
      console.log('  + [' + status + '] ' + a.sev.toUpperCase().padEnd(8) + ' | ' + a.type.padEnd(15) + ' | ' + a.mins + ' dk once');
    } catch (err) {
      console.error('  X ' + a.type + ' INSERT FAILED:', err.message);
    }
  }

  console.log('');
  console.log('Seed tamamlandi.');
  console.log('Beklenen dashboard:');
  console.log('  - Aktif Gecikme: 2 (AMS-0145 Mehmet 2h, RTM-0089 Jan 1h)');
  console.log('  - Cozulmemis Uyari: 1 + 3 yeni = 4');
  console.log('  - Kritik Uyari: 1 (SOS Mehmet)');
  console.log('  - Son Aktiviteler: 6 yeni alert');

  await pool.end();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
