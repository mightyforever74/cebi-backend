// /opt/fleet/backend/routes/devices.js
// TulipFleet - Device Management Routes
// QR Code Scan with Action Support (assign_to_vehicle | add_to_stock)
// Updated: 27 January 2026

module.exports = async function (fastify) {
  
  // ============================================================================
  // POST /api/devices/scan-qr
  // Scan QR code and perform action on device
  // Auth: Admin, Driver
  // Actions: assign_to_vehicle, add_to_stock
  // ============================================================================
  fastify.post('/api/devices/scan-qr', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { token, action, vehicleId, force } = request.body;
    const userId = request.user.id;
    const userRole = request.user.role;
    const companyId = request.user.company_id;
    
    // Validasyon
    if (!token) {
      return reply.code(400).send({ error: 'Token gerekli' });
    }
    
    if (!action || !['assign_to_vehicle', 'add_to_stock'].includes(action)) {
      return reply.code(400).send({ 
        error: 'Geçerli action gerekli',
        valid_actions: ['assign_to_vehicle', 'add_to_stock']
      });
    }
    
    if (action === 'assign_to_vehicle' && !vehicleId) {
      return reply.code(400).send({ error: 'vehicleId gerekli (assign_to_vehicle için)' });
    }
    
    const client = await fastify.pg.connect();
    
    try {
      await client.query('BEGIN');
      
      // =====================================================
      // 1. QR KODUNU KONTROL ET
      // =====================================================
      const qrResult = await client.query(`
        SELECT 
          qr.id as qr_id,
          qr.device_id,
          qr.expires_at,
          qr.used_at,
          d.serial,
          d.device_code,
          d.status,
          d.vehicle_id as current_vehicle_id
        FROM device_qr_codes qr
        JOIN devices d ON qr.device_id = d.id
        WHERE qr.token = $1
      `, [token]);
      
      if (qrResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Geçersiz QR kod' });
      }
      
      const qr = qrResult.rows[0];
      
      // =====================================================
      // 2. SÜRE KONTROLÜ
      // =====================================================
      if (new Date() > new Date(qr.expires_at)) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'QR kodun süresi dolmuş' });
      }
      
      // =====================================================
      // 3. ACTION: ADD_TO_STOCK
      // =====================================================
      if (action === 'add_to_stock') {
        
        // Cihaz zaten bu şirkete atanmış mı?
        const deviceCheck = await client.query(
          'SELECT company_id FROM devices WHERE id = $1',
          [qr.device_id]
        );
        
        if (deviceCheck.rows[0].company_id === companyId) {
          await client.query('ROLLBACK');
          
          fastify.log.info({
            user: userId,
            role: userRole,
            device: qr.serial,
            action: 'add_to_stock_duplicate'
          }, 'Device already in company stock');
          
          return reply.send({
            already_in_stock: true,
            success: false,
            message: 'Bu cihaz zaten şirket stoğunuzda',
            device: {
              serial: qr.serial,
              device_code: qr.device_code,
              status: qr.status
            }
          });
        }
        
        // Stoka ekle
        await client.query(`
          UPDATE devices 
          SET 
            company_id = $1,
            vehicle_id = NULL,
            status = 'IN_STOCK',
            assigned_at = NOW(),
            assigned_by = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [companyId, userId, qr.device_id]);
        
        // QR kullanıldı işaretle
        await client.query(`
          UPDATE device_qr_codes 
          SET used_at = NOW(), used_by = $1, updated_at = NOW()
          WHERE id = $2
        `, [userId, qr.qr_id]);
        
        // Log kaydet
        await client.query(`
          INSERT INTO device_bind_events (
            device_id, serial, device_code,
            event_type, actor_user_id, actor_type,
            reason, new_state
          ) VALUES (
            $1, $2, $3,
            'ADD_TO_STOCK', $4, $5,
            'QR kod ile stoka ekleme',
            $6
          )
        `, [
          qr.device_id,
          qr.serial,
          qr.device_code,
          userId,
          userRole,
          JSON.stringify({ company_id: companyId })
        ]);
        
        await client.query('COMMIT');
        
        fastify.log.info({
          user: userId,
          role: userRole,
          device: qr.serial,
          action: 'add_to_stock_success'
        }, 'Device added to stock');
        
        return reply.send({
          success: true,
          message: 'Cihaz başarıyla stoka eklendi',
          action: 'add_to_stock',
          device: {
            serial: qr.serial,
            device_code: qr.device_code,
            status: 'IN_STOCK'
          }
        });
      }
      
      // =====================================================
      // 4. ACTION: ASSIGN_TO_VEHICLE
      // =====================================================
      if (action === 'assign_to_vehicle') {
        
        // Aracı kontrol et
        const vehicleResult = await client.query(`
          SELECT 
            v.id, 
            v.plate_no, 
            v.esp32_device_id,
            v.company_id,
            d.serial as old_device_serial,
            d.device_code as old_device_code
          FROM vehicles v
          LEFT JOIN devices d ON v.esp32_device_id = d.serial
          WHERE v.id = $1
        `, [vehicleId]);
        
        if (vehicleResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Araç bulunamadı' });
        }
        
        const vehicle = vehicleResult.rows[0];
        
        // Multi-tenant kontrolü
        if (userRole !== 'super_admin' && vehicle.company_id !== companyId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Bu araca erişim yetkiniz yok' });
        }
        
        // ⭐ EMNİYET KONTROLÜ: CİHAZ ZATEN BU ARACA ATANMIŞ MI?
        if (qr.current_vehicle_id === vehicleId) {
          await client.query('ROLLBACK');
          
          fastify.log.info({
            user: userId,
            role: userRole,
            action: 'qr_scan_duplicate',
            device: qr.serial,
            vehicle: vehicle.plate_no
          }, 'Duplicate QR scan prevented');
          
          return reply.send({
            already_assigned: true,
            success: false,
            message: 'Bu cihaz zaten bu araca atanmış durumda',
            info: 'Cihazınız aktif olarak hizmet vermektedir',
            device: {
              serial: qr.serial,
              device_code: qr.device_code,
              status: qr.status
            },
            vehicle: {
              id: vehicle.id,
              plate_no: vehicle.plate_no
            },
            action: 'redirect_to_dashboard'
          });
        }
        
        // ARAÇTA BAŞKA BİR CİHAZ VAR MI?
        if (vehicle.esp32_device_id && vehicle.esp32_device_id !== qr.serial) {
          if (!force) {
            // İLK İSTEK - Onay gerekli
            await client.query('ROLLBACK');
            
            fastify.log.warn({
              user: userId,
              role: userRole,
              action: 'qr_scan_conflict',
              old_device: vehicle.esp32_device_id,
              new_device: qr.serial,
              vehicle: vehicle.plate_no
            }, 'Device conflict detected - user confirmation required');
            
            return reply.code(409).send({
              conflict: true,
              warning: 'Bu araca atanmış diğer bir cihaz var',
              message: 'Yeni cihazı aktif etmeniz halinde aktif olan son işleminiz olacaktır. Eski cihaz pasif duruma geçecektir.',
              old_device: {
                serial: vehicle.esp32_device_id,
                device_code: vehicle.old_device_code
              },
              new_device: {
                serial: qr.serial,
                device_code: qr.device_code
              }
            });
          }
          
          // force = true → Eski cihazı pasif et
          const oldDeviceResult = await client.query(
            'SELECT id FROM devices WHERE serial = $1',
            [vehicle.esp32_device_id]
          );
          
          if (oldDeviceResult.rows.length > 0) {
            const oldDeviceId = oldDeviceResult.rows[0].id;
            
            // Eski cihazı PASİF ET
            await client.query(`
              UPDATE devices 
              SET 
                vehicle_id = NULL,
                assigned_at = NULL,
                assigned_by = NULL,
                status = 'IN_STOCK',
                updated_at = NOW()
              WHERE id = $1
            `, [oldDeviceId]);
            
            // Log kaydet
            await client.query(`
              INSERT INTO device_bind_events (
                device_id, serial, device_code,
                event_type, actor_user_id, actor_type,
                reason, previous_state
              ) VALUES (
                $1, $2, $3,
                'REPLACED', $4, $5,
                'Yeni cihaz ataması sırasında pasif edildi',
                $6
              )
            `, [
              oldDeviceId,
              vehicle.esp32_device_id,
              vehicle.old_device_code,
              userId,
              userRole,
              JSON.stringify({ 
                vehicle_id: vehicleId, 
                plate_no: vehicle.plate_no 
              })
            ]);
            
            fastify.log.info({
              old_device: vehicle.esp32_device_id,
              new_device: qr.serial,
              vehicle: vehicle.plate_no,
              actor: userId
            }, 'Old device deactivated, new device assigned');
          }
        }
        
        // YENİ CİHAZI ATA
        await client.query(`
          UPDATE devices 
          SET 
            vehicle_id = $1,
            company_id = $2,
            assigned_at = NOW(),
            assigned_by = $3,
            status = 'ACTIVATED',
            updated_at = NOW()
          WHERE id = $4
        `, [vehicleId, companyId, userId, qr.device_id]);
        
        await client.query(`
          UPDATE vehicles 
          SET 
            esp32_device_id = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [qr.serial, vehicleId]);
        
        await client.query(`
          UPDATE device_qr_codes 
          SET 
            used_at = NOW(),
            used_by = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [userId, qr.qr_id]);
        
        // Log kaydet
        await client.query(`
          INSERT INTO device_bind_events (
            device_id, serial, device_code,
            event_type, actor_user_id, actor_type,
            reason, new_state
          ) VALUES (
            $1, $2, $3,
            'QR_ASSIGN', $4, $5,
            'QR kod ile araç ataması',
            $6
          )
        `, [
          qr.device_id, 
          qr.serial, 
          qr.device_code,
          userId,
          userRole,
          JSON.stringify({ vehicle_id: vehicleId, plate_no: vehicle.plate_no })
        ]);
        
        await client.query('COMMIT');
        
        fastify.log.info({
          user: userId,
          role: userRole,
          device: qr.serial,
          vehicle: vehicle.plate_no,
          action: 'assign_to_vehicle_success'
        }, 'Device assigned to vehicle via QR code');
        
        return reply.send({
          success: true,
          message: 'Cihaz başarıyla araca atandı',
          action: 'assign_to_vehicle',
          device: {
            serial: qr.serial,
            device_code: qr.device_code,
            status: 'ACTIVATED'
          },
          vehicle: {
            id: vehicle.id,
            plate_no: vehicle.plate_no
          }
        });
      }
      
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error({
        error: error.message,
        stack: error.stack,
        user: userId,
        action,
        token: token.substring(0, 10) + '...'
      }, 'QR scan error');
      
      return reply.code(500).send({ 
        error: 'Cihaz işlem hatası',
        details: error.message 
      });
    } finally {
      client.release();
    }
  });

  // ============================================================================
  // POST /api/devices/provisioning-complete
  // WiFi provisioning sonrası driver aktivasyonu
  // ============================================================================
  fastify.post('/api/devices/provisioning-complete', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    let serial;
    if (typeof request.body === 'string') {
      serial = request.body;
    } else {
      serial = request.body.serial || request.body;
    }
    
    const userId = request.user.id;
    const companyId = request.user.company_id;
    const userRole = request.user.role;
    
    if (!serial) {
      return reply.code(400).send({ 
        error: 'Serial numarası gerekli'
      });
    }
    
    const client = await fastify.pg.connect();
    
    try {
      await client.query('BEGIN');
      
      const deviceResult = await client.query(`
        SELECT d.id, d.serial, d.company_id, d.vehicle_id, d.status, d.setup_required
        FROM devices d
        WHERE d.serial = $1 OR d.serial_number = $1
      `, [serial]);
      
      if (deviceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ 
          error: 'Cihaz bulunamadı'
        });
      }
      
      const device = deviceResult.rows[0];
      
      if (userRole !== 'super_admin' && device.company_id !== companyId) {
        await client.query('ROLLBACK');
        return reply.code(403).send({ 
          error: 'Yetkisiz erişim'
        });
      }
      
      await client.query(`
        UPDATE devices 
        SET setup_required = FALSE,
            activated_at = COALESCE(activated_at, NOW()),
            is_online = TRUE,
            status = 'ACTIVATED',
            updated_at = NOW()
        WHERE id = $1
      `, [device.id]);
      
      await client.query('COMMIT');
      
      return reply.send({
        success: true,
        message: 'Cihaz başarıyla aktif edildi'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error({ error: error.message, serial }, 'Provisioning complete error');
      return reply.code(500).send({ 
        error: 'Aktivasyon hatası'
      });
    } finally {
      client.release();
    }
  });

  // ============================================================================
  // POST /api/devices/validate-serial
  fastify.post('/api/devices/validate-serial', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { serial } = request.body;
    if (!serial) return reply.code(400).send({ valid: false, error: 'Serial required' });
    const client = await fastify.pg.connect();
    try {
      const result = await client.query(
        'SELECT id, device_code, serial, serial_number, status, company_id, vehicle_id FROM devices WHERE serial = $1 OR serial_number = $1',
        [serial]
      );
      if (result.rows.length === 0) return reply.send({ valid: false, error: 'Serial not found' });
      const device = result.rows[0];
      if (request.user.role !== 'super_admin' && device.company_id !== request.user.company_id) {
        return reply.code(403).send({ valid: false, error: 'Unauthorized' });
      }
      return reply.send({ valid: true, device: { id: device.id, device_code: device.device_code, serial: device.serial, serial_number: device.serial_number, status: device.status, company_id: device.company_id, vehicle_id: device.vehicle_id } });
    } finally { client.release(); }
  });

  // TOKEN SYSTEM - ESP32 Authentication
  // Added: 30 January 2026
  // ============================================================================

  // POST /api/devices/activate
  fastify.post('/api/devices/activate', async (request, reply) => {
    const activationKey = request.headers['x-device-activation-key'] || (request.body && request.body.activation_key);
    const { serial, esp_chip_id, chip_id, firmware_version, mac_address } = request.body;
    const chipId = esp_chip_id || chip_id;

    if (activationKey !== process.env.DEVICE_ACTIVATION_KEY) {
      fastify.log.warn({ event: 'activation_invalid_key', ip: request.ip, serial });
      return reply.code(401).send({ success: false, error: 'Invalid activation key' });
    }

    if (!serial) {
      return reply.code(400).send({ success: false, error: 'Serial required' });
    }

    const client = await fastify.pg.connect();
    const crypto = require('crypto');

    try {
      await client.query('BEGIN');

      const deviceResult = await client.query(
        'SELECT id, serial, serial_number, device_code, status, device_token FROM devices WHERE serial = $1 OR esp_chip_id = $2',
        [serial, chipId]  
      );

      let device, token;

      if (deviceResult.rows.length === 0) {
        const deviceCode = serial.split('-').pop();
        token = crypto.randomBytes(32).toString('hex');
        
        const insertResult = await client.query(`
          INSERT INTO devices (
            device_code, serial, serial_number, esp_chip_id, chip_model,
            firmware_version, status, device_token, setup_required,
            activated_at, last_seen_at, owner_type, created_at, updated_at
          ) VALUES (
            $1, $2, $2, $3, 'ESP32-WROOM-32', $4, 
            'ACTIVATED', $5, false, NOW(), NOW(), 
            'company', NOW(), NOW()
          ) RETURNING id, serial, device_code, status, device_token
        `, [deviceCode, serial, chipId, firmware_version, token]);

        device = insertResult.rows[0];
        fastify.log.info({ event: 'device_activated_new', serial, device_code: deviceCode });
      } else {
        device = deviceResult.rows[0];
        token = crypto.randomBytes(32).toString('hex');
        
        await client.query(`
          UPDATE devices 
          SET esp_chip_id = $1, firmware_version = $2, status = 'ACTIVATED',
              device_token = $3, setup_required = false, activated_at = NOW(),
              last_seen_at = NOW(), updated_at = NOW()
          WHERE serial = $4
        `, [chipId, firmware_version, token, serial]);

        device.device_token = token;
        fastify.log.info({ event: 'device_reactivated', serial });
      }


      await client.query(`
        INSERT INTO device_logs (device_id, event_type, message, created_at)
        VALUES ($1, 'ACTIVATION', $2, NOW())
      `, [device.id, `Device ${serial} activated via token system (fw: ${firmware_version})`]);

      await client.query('COMMIT');

      return reply.send({
        success: true,
        message: 'Device activated successfully',
        device: {
          serial: device.serial,
          device_code: device.device_code,
          status: device.status,
          token: device.device_token
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error({ event: 'device_activation_error', serial, error: error.message });
      return reply.code(500).send({ success: false, error: 'Activation failed', details: error.message });
    } finally {
      client.release();
    }
  });

  // POST /api/devices/validate-token
  fastify.post('/api/devices/validate-token', async (request, reply) => {
    const token = request.headers['x-device-token'];
    const { serial } = request.body;

    if (!token || token.length !== 64) {
      return reply.code(401).send({ valid: false, error: 'Invalid token format' });
    }
    if (!serial) {
      return reply.code(400).send({ valid: false, error: 'Serial required' });
    }

    const client = await fastify.pg.connect();
    try {
      const result = await client.query(`
        SELECT d.id, d.serial, d.device_code, d.status, d.vehicle_id, d.company_id, v.plate_no
        FROM devices d LEFT JOIN vehicles v ON d.vehicle_id = v.id
        WHERE d.serial = $1 AND d.device_token = $2
      `, [serial, token]);

      if (result.rows.length === 0) {
        fastify.log.warn({ event: 'token_validation_failed', serial, token_preview: token.substring(0, 8) + '...' });
        return reply.code(401).send({ valid: false, error: 'Invalid token or serial' });
      }

      const device = result.rows[0];
      if (device.status !== 'ACTIVATED') {
        return reply.code(403).send({ valid: false, error: `Device not activated (status: ${device.status})` });
      }

      await client.query('UPDATE devices SET last_seen_at = NOW(), is_online = true WHERE serial = $1', [serial]);

      fastify.log.info({ event: 'token_validated', serial, device_code: device.device_code });

      return reply.send({
        valid: true,
        device: {
          serial: device.serial,
          device_code: device.device_code,
          status: device.status,
          vehicle_id: device.vehicle_id,
          plate_no: device.plate_no,
          company_id: device.company_id
        }
      });
    } catch (error) {
      fastify.log.error({ event: 'token_validation_error', serial, error: error.message });
      return reply.code(500).send({ valid: false, error: 'Validation failed' });
    } finally {
      client.release();
    }
  });



  // ============================================================================
  // GET /api/devices/check-status
  // BLE provisioning oncesi chipId ile cihaz durumunu kontrol et
  // Auth: Admin, Driver
  // Added: 11 Mart 2026
  // ============================================================================
  fastify.get('/api/devices/check-status', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { chipId } = request.query;
    const companyId = request.user.company_id;
    const userRole = request.user.role;

    if (!chipId) return reply.code(400).send({ error: 'chipId gerekli' });

    const client = await fastify.pg.connect();
    try {
      const result = await client.query(`
        SELECT d.id, d.serial, d.device_code, d.esp_chip_id,
               d.status, d.is_online, d.company_id,
               v.plate_no, v.id as vehicle_id
        FROM devices d
        LEFT JOIN vehicles v ON d.vehicle_id = v.id
        WHERE d.esp_chip_id = $1
      `, [chipId]);

      if (result.rows.length === 0) return reply.send({ registered: false });

      const device = result.rows[0];
      if (userRole !== 'super_admin' && device.company_id !== companyId) {
        return reply.send({ registered: false });
      }

      return reply.send({
        registered: true,
        device: {
          serial: device.serial,
          device_code: device.device_code,
          status: device.status,
          is_online: device.is_online,
          vehicle_plate: device.plate_no || null,
          vehicle_id: device.vehicle_id || null
        }
      });
    } catch (error) {
      fastify.log.error({ error: error.message, chipId }, 'check-status error');
      return reply.code(500).send({ error: 'Durum sorgulanamadi' });
    } finally {
      client.release();
    }
  });

  // ============================================================================
  // POST /api/devices/reset-provision
  // MQTT uzerinden cihaza RESET_PROVISION komutu gonder
  // Auth: Admin, Driver
  // Added: 11 Mart 2026
  // ============================================================================
  fastify.post('/api/devices/reset-provision', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { serial } = request.body || {};
    const companyId = request.user.company_id;
    const userRole = request.user.role;
    const userId = request.user.id;

    if (!serial) return reply.code(400).send({ error: 'serial gerekli' });

    const client = await fastify.pg.connect();
    try {
      const result = await client.query(
        'SELECT id, serial, esp_chip_id, company_id, status FROM devices WHERE serial = $1',
        [serial]
      );

      if (result.rows.length === 0) return reply.code(404).send({ error: 'Cihaz bulunamadi' });

      const device = result.rows[0];
      if (userRole !== 'super_admin' && device.company_id !== companyId) {
        return reply.code(403).send({ error: 'Yetkisiz erisim' });
      }
      if (!device.esp_chip_id) return reply.code(400).send({ error: 'Chip ID bilgisi yok' });

      const topic = `fleet/device/${device.esp_chip_id}/commands`;
      const payload = JSON.stringify({ command: 'RESET_PROVISION' });

      try {
        await fastify.mqtt.publish(topic, payload, { qos: 1 });
        fastify.log.info({ user: userId, serial, chip_id: device.esp_chip_id }, 'RESET_PROVISION sent');
        return reply.send({ success: true, mqtt_sent: true, message: 'Komut gonderildi' });
      } catch (mqttErr) {
        fastify.log.warn({ error: mqttErr.message, serial }, 'MQTT publish failed');
        return reply.send({ success: false, mqtt_sent: false, message: 'Cihaz offline, BLE ile reprovision yapin' });
      }
    } catch (error) {
      fastify.log.error({ error: error.message, serial }, 'reset-provision error');
      return reply.code(500).send({ error: 'Sifirlama komutu gonderilemedi' });
    } finally {
      client.release();
    }
  });

};
