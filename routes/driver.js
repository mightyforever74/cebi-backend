// routes/driver.js
// Driver-specific endpoints: validate-serial, available-vehicles, assign-device, complete-setup

const { parseLiveCapacityFields } = require('./liveCapacityHelpers');

module.exports = function (fastify, opts, done) {
  
  // ═══════════════════════════════════════════════════════════
  // POST /api/driver/validate-serial
  // QR scan sonrası serial kontrolü
  // ═══════════════════════════════════════════════════════════
  fastify.post('/validate-serial', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { serial } = request.body;
    const userId = request.user.id;
    
    if (!serial) {
      return reply.status(400).send({ error: 'Serial gerekli' });
    }
    
    try {
      const conn = await fastify.pg.connect();
      
      try {
        // 1. User bilgisi al
        const userResult = await conn.query(
          'SELECT company_id, role FROM users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length === 0) {
          return reply.status(404).send({ error: 'USER_NOT_FOUND' });
        }
        
        const user = userResult.rows[0];
        
        // 2. Device kontrolü
        const deviceResult = await conn.query(
          'SELECT id, serial, status, company_id FROM devices WHERE serial = $1',
          [serial]
        );
        
        if (deviceResult.rows.length === 0) {
          return reply.status(404).send({ 
            valid: false, 
            error: 'DEVICE_NOT_FOUND',
            message: 'Bu cihaz sistemde kayıtlı değil'
          });
        }
        
        const device = deviceResult.rows[0];
        
        // 3. Şirket kontrolü
        if (device.company_id !== user.company_id) {
          return reply.status(403).send({ 
            valid: false,
            error: 'DEVICE_WRONG_COMPANY',
            message: 'Bu cihaz şirketinize ait değil'
          });
        }
        
        // 4. Active assignment kontrolü
        // 4. Active assignment kontrolü
        const assignmentResult = await conn.query(`
          SELECT 
            da.id,
            da.vehicle_id,
            da.driver_id
          FROM device_assignments da
          WHERE da.device_id = $1 AND da.status = $2
        `, [device.id, 'active']);

        if (assignmentResult.rows.length > 0) {
          const assignment = assignmentResult.rows[0];
          
          // Aynı şoförün aracına atanmışsa izin ver (re-provision)
          if (assignment.driver_id === userId) {
            // ✅ Aynı şoför - izin ver
            return reply.send({
              valid: true,
              device: {
                id: device.id,
                serial: device.serial,
                status: device.status,
                allow_reprovisioning: true
              }
            });
          }
          
          // ❌ Başka şoförün aracında
          return reply.status(409).send({
            valid: false,
            error: 'DEVICE_ASSIGNED_TO_OTHER',
            message: 'Bu cihaz zaten başka bir sürücüye atanmış'
          });
        }
        
        // ✅ Başarılı
        return reply.send({
          valid: true,
          device: {
            id: device.id,
            serial: device.serial,
            status: device.status,
            company_id: device.company_id
          }
        });
        
      } finally {
        conn.release();
      }
      
    } catch (error) {
      console.error('[VALIDATE_SERIAL] FULL ERROR:', error);
      fastify.log.error('[VALIDATE_SERIAL] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GET /api/driver/available-vehicles
  // Driver'ın kullanabileceği araçlar (son kullanılan en üstte)
  // ═══════════════════════════════════════════════════════════
  fastify.get('/available-vehicles', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;
    
    try {
      const conn = await fastify.pg.connect();
      
      try {
        // User company_id
        const userResult = await conn.query(
          'SELECT company_id FROM users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length === 0) {
          return reply.status(404).send({ error: 'USER_NOT_FOUND' });
        }
        
        const companyId = userResult.rows[0].company_id;
        
        // Vehicles + last used check
        const vehiclesResult = await conn.query(`
          SELECT 
            v.id,            
            v.plate_no,
            v.model,
            v.brand,
            v.year,
            v.fuel_type,
            CASE 
              WHEN v.id = (
                SELECT vehicle_id 
                FROM device_assignments 
                WHERE driver_id = $1 AND status = 'active' 
                ORDER BY assigned_at DESC 
                LIMIT 1
              ) THEN true 
              ELSE false 
            END as last_used
          FROM vehicles v
          WHERE v.company_id = $2
            AND v.status = 'in_use'
          ORDER BY last_used DESC, v.plate_no ASC
        `, [userId, companyId]);
        
        return reply.send({
          vehicles: vehiclesResult.rows
        });
        
      } finally {
        conn.release();
      }
      
    } catch (error) {
      fastify.log.error('[AVAILABLE_VEHICLES] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // POST /api/driver/assign-device
  // Driver-Vehicle-Device assignment oluştur
  // ═══════════════════════════════════════════════════════════
  fastify.post('/assign-device', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { device_serial, vehicle_id } = request.body;
    const userId = request.user.id;
    
    if (!device_serial || !vehicle_id) {
      return reply.status(400).send({ error: 'device_serial ve vehicle_id gerekli' });
    }
    
    try {
      const conn = await fastify.pg.connect();
      
      try {
        await conn.query('BEGIN');
        
        // 1. User bilgisi
        const userResult = await conn.query(
          'SELECT company_id FROM users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length === 0) {
          await conn.query('ROLLBACK');
          return reply.status(404).send({ error: 'USER_NOT_FOUND' });
        }
        
        const companyId = userResult.rows[0].company_id;
        
        // 2. Device kontrolü
        const deviceResult = await conn.query(
          'SELECT id, status FROM devices WHERE serial = $1 AND company_id = $2',
          [device_serial, companyId]
        );
        
        if (deviceResult.rows.length === 0) {
          await conn.query('ROLLBACK');
          return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' });
        }
        
        const deviceId = deviceResult.rows[0].id;
        
        // 3. Vehicle kontrolü
        const vehicleResult = await conn.query(
          'SELECT id FROM vehicles WHERE id = $1 AND company_id = $2',
          [vehicle_id, companyId]
        );
        
        if (vehicleResult.rows.length === 0) {
          await conn.query('ROLLBACK');
          return reply.status(404).send({ error: 'VEHICLE_NOT_FOUND' });
        }
        
        // 4. Önceki assignment'ları pasif yap
        await conn.query(
          'UPDATE device_assignments SET status = $1, updated_at = NOW() WHERE device_id = $2 AND status = $3',
          ['inactive', deviceId, 'active']
        );
        
        // 5. Yeni assignment oluştur
        const assignmentResult = await conn.query(`
          INSERT INTO device_assignments 
          (driver_id, vehicle_id, device_id, assigned_by, status) 
          VALUES ($1, $2, $3, $4, $5) 
          RETURNING id
        `, [userId, vehicle_id, deviceId, userId, 'active']);
        
        const assignmentId = assignmentResult.rows[0].id;
        
        // 6. Device status güncelle
        await conn.query(
          'UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2',
          ['ASSIGNED', deviceId]
        );
        
        await conn.query('COMMIT');
        
        fastify.log.info(`[ASSIGN_DEVICE] Driver ${userId} assigned device ${device_serial} to vehicle ${vehicle_id}`);
        
        return reply.send({
          success: true,
          assignment_id: assignmentId,
          message: 'Cihaz başarıyla atandı'
        });
        
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
      
    } catch (error) {
      fastify.log.error('[ASSIGN_DEVICE] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // POST /api/driver/complete-setup
  // WiFi provisioning sonrası finalize
  // ═══════════════════════════════════════════════════════════
  fastify.post('/complete-setup', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { assignment_id, device_serial } = request.body;
    const userId = request.user.id;
    
    if (!assignment_id || !device_serial) {
      return reply.status(400).send({ error: 'assignment_id ve device_serial gerekli' });
    }
    
    try {
      const conn = await fastify.pg.connect();
      
      try {
        await conn.query('BEGIN');
        
        // 1. Assignment kontrolü
        const assignmentResult = await conn.query(
          'SELECT vehicle_id, device_id FROM device_assignments WHERE id = $1 AND driver_id = $2 AND status = $3',
          [assignment_id, userId, 'active']
        );
        
        if (assignmentResult.rows.length === 0) {
          await conn.query('ROLLBACK');
          return reply.status(404).send({ error: 'ASSIGNMENT_NOT_FOUND' });
        }
        
        const { vehicle_id, device_id } = assignmentResult.rows[0];
        
        // 2. Device status güncelle
        await conn.query(
          'UPDATE devices SET setup_required = FALSE, status = $1, updated_at = NOW() WHERE id = $2',
          ['ACTIVATED', device_id]
        );
        
        // 3. Vehicle-device bağlantısını güncelle
        await conn.query(
          'UPDATE vehicles SET esp32_device_id = $1, updated_at = NOW() WHERE id = $2',
          [device_id, vehicle_id]
        );
        
        await conn.query('COMMIT');
        
        fastify.log.info(`[COMPLETE_SETUP] Setup completed for device ${device_serial}, assignment ${assignment_id}`);
        
        return reply.send({
          success: true,
          message: 'Kurulum tamamlandı'
        });
        
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
      
    } catch (error) {
      fastify.log.error('[COMPLETE_SETUP] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PATCH /api/driver/live-capacity
  // FEAT-020 Phase 1.3b (Katman C, backend dilimi, 2026-10-13).
  // Suruculerin mobil uygulamadan bildirdigi ANLIK bos kapasite — Phase
  // 1.1'in statik cargo_capacity_* kolonlarindan (admin girer, aracin
  // TOPLAM/MAX kapasitesi) AYRI: bu suruculerin HER SEFER raporunda
  // degisebilen, o anki BOS kapasitesi. Hazmat bu kapsamin disinda.
  // Arac, suruculerin su anki AKTIF device_assignments kaydindan
  // cozulur (complete-setup presedenti) — body'de vehicle_id ALINMAZ,
  // surucu sadece KENDI aktif aracina rapor verebilir (yetki sizmasi
  // onlenir).
  // ═══════════════════════════════════════════════════════════
  fastify.patch('/live-capacity', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id;

    const capacity = parseLiveCapacityFields(request.body);
    if (!capacity.ok) {
      return reply.status(400).send({ error: capacity.error });
    }

    try {
      const conn = await fastify.pg.connect();

      try {
        const assignmentResult = await conn.query(
          'SELECT vehicle_id FROM device_assignments WHERE driver_id = $1 AND status = $2',
          [userId, 'active']
        );

        if (assignmentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'NO_ACTIVE_VEHICLE_ASSIGNMENT' });
        }

        const { vehicle_id } = assignmentResult.rows[0];

        const { rows } = await conn.query(
          `UPDATE vehicles
              SET live_cargo_volume_m3 = $1,
                  live_cargo_weight_kg = $2,
                  live_cargo_reported_at = NOW()
            WHERE id = $3
          RETURNING id, live_cargo_volume_m3, live_cargo_weight_kg, live_cargo_reported_at`,
          [capacity.volumeM3, capacity.weightKg, vehicle_id]
        );

        fastify.log.info(
          `[LIVE_CAPACITY] Driver ${userId} reported live capacity for vehicle ${vehicle_id}`
        );

        return reply.send({ vehicle: rows[0] });
      } finally {
        conn.release();
      }
    } catch (error) {
      fastify.log.error('[LIVE_CAPACITY] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  done();
};