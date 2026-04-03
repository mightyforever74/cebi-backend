// /opt/fleet/backend/routes/superadmin.devices.js
// TulipFleet - SuperAdmin Device Management Routes
// QR Code Generation, Listing, and Device Deletion
// Created: 27 January 2026

module.exports = async function (fastify) {
  
  // ============================================================================
  // POST /api/superadmin/devices/:deviceId/qr
  // Create QR code for device
  // Auth: SuperAdmin only
  // ============================================================================
  fastify.post('/api/superadmin/devices/:deviceId/qr', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }
    
    const { deviceId } = request.params;
    const userId = request.user.id;
    
    const client = await fastify.pg.connect();
    
    try {
      // 1. Cihazı kontrol et
      const deviceResult = await client.query(
        'SELECT serial, device_code, status FROM devices WHERE id = $1',
        [deviceId]
      );
      
      if (deviceResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Cihaz bulunamadı' });
      }
      
      const device = deviceResult.rows[0];
      
      // 2. Token oluştur (64 karakter)
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      
      // 3. QR kod kaydı oluştur
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 yıl
      
      const qrResult = await client.query(`
        INSERT INTO device_qr_codes (
          device_id, token, expires_at, created_by
        ) VALUES ($1, $2, $3, $4)
        RETURNING id, token, expires_at
      `, [id, token, expiresAt, userId]);
      
      const qrCode = qrResult.rows[0];
      
      fastify.log.info({
        user: userId,
        device: device.serial,
        qr_id: qrCode.id,
        expires_at: qrCode.expires_at
      }, 'QR code created');
      
      return reply.send({
        success: true,
        qr_code: {
          id: qrCode.id,
          token: qrCode.token,
          expires_at: qrCode.expires_at,
          device: {
            serial: device.serial,
            device_code: device.device_code
          }
        }
      });
      
    } catch (error) {
      fastify.log.error({
        error: error.message,
        device_id: id,
        user: userId
      }, 'QR code creation failed');
      
      return reply.code(500).send({
        error: 'QR kod oluşturma hatası',
        details: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // ============================================================================
  // GET /api/superadmin/devices/:deviceId/qr-codes
  // List all QR codes for a device
  // Auth: SuperAdmin only
  // ============================================================================
  fastify.get('/api/superadmin/devices/:deviceId/qr-codes', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }
    
    const { deviceId } = request.params;
    
    const client = await fastify.pg.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          qr.id,
          qr.token,
          qr.expires_at,
          qr.used_at,
          qr.created_at,
          u1.email as created_by_email,
          u2.email as used_by_email
        FROM device_qr_codes qr
        LEFT JOIN users u1 ON qr.created_by = u1.id
        LEFT JOIN users u2 ON qr.used_by = u2.id
        WHERE qr.device_id = $1
        ORDER BY qr.created_at DESC
      `, [deviceId]);
      
      return reply.send({
        success: true,
        qr_codes: result.rows
      });
      
    } catch (error) {
      fastify.log.error({
        error: error.message,
        device_id: id
      }, 'Failed to list QR codes');
      
      return reply.code(500).send({
        error: 'QR kod listesi alınamadı',
        details: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // ============================================================================
  // DELETE /api/superadmin/devices/:deviceId
  // Permanently delete device from system (for broken/faulty devices)
  // Auth: SuperAdmin only
  // ============================================================================
  fastify.delete('/api/superadmin/devices/:deviceId', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }
    
    const { deviceId } = request.params;
    const userId = request.user.id;
    
    const client = await fastify.pg.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. Cihazı bul
      const deviceResult = await client.query(`
        SELECT 
          d.id, d.serial, d.device_code,
          d.vehicle_id, d.status,
          v.plate_no
        FROM devices d
        LEFT JOIN vehicles v ON d.vehicle_id = v.id
        WHERE d.id = $1
      `, [deviceId]);
      
      if (deviceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Cihaz bulunamadı' });
      }
      
      const device = deviceResult.rows[0];
      
      // 2. Araca atanmışsa araçtan çıkar
      if (device.vehicle_id) {
        await client.query(`
          UPDATE vehicles 
          SET esp32_device_id = NULL, updated_at = NOW()
          WHERE id = $1
        `, [device.vehicle_id]);
        
        fastify.log.info({
          device: device.serial,
          vehicle: device.plate_no,
          action: 'unassigned_before_delete'
        }, 'Device unassigned from vehicle');
      }
      
      // 3. İlişkili kayıtları temizle
      await client.query('DELETE FROM device_qr_codes WHERE device_id = $1', [deviceId]);
      await client.query('DELETE FROM device_logs WHERE device_id = $1', [deviceId]);
      
      // 4. Son log kaydı (silmeden önce!)
      await client.query(`
        INSERT INTO device_bind_events (
          device_id, serial, device_code,
          event_type, actor_user_id, actor_type,
          reason, previous_state
        ) VALUES (
          $1, $2, $3,
          'DELETED', $4, 'super_admin',
          'Arızalı cihaz - sistemden kalıcı olarak silindi',
          $5
        )
      `, [
        device.id,
        device.serial,
        device.device_code,
        userId,
        JSON.stringify({ 
          vehicle_id: device.vehicle_id, 
          plate_no: device.plate_no,
          status: device.status
        })
      ]);
      
      // 5. device_bind_events kayıtlarını sil
      await client.query('DELETE FROM device_bind_events WHERE device_id = $1', [deviceId]);
      
      // 6. CİHAZI SİL
      await client.query('DELETE FROM devices WHERE id = $1', [deviceId]);
      
      await client.query('COMMIT');
      
      fastify.log.warn({
        user: userId,
        device: device.serial,
        was_assigned_to: device.plate_no,
        action: 'device_deleted_permanently'
      }, 'Device permanently deleted from system');
      
      return reply.send({
        success: true,
        message: `Cihaz ${device.serial} sistemden kalıcı olarak silindi`,
        deleted_device: {
          serial: device.serial,
          device_code: device.device_code,
          was_assigned_to: device.plate_no || null
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error({
        error: error.message,
        stack: error.stack,
        device_id: id,
        user: userId
      }, 'Device deletion failed');
      
      // Foreign key hatası kontrolü
      if (error.code === '23503') {
        return reply.code(409).send({ 
          error: 'Cihaz silinemedi',
          message: 'Bu cihazla ilişkili kayıtlar var. Önce bunları temizleyin.'
        });
      }
      
      return reply.code(500).send({ 
        error: 'Cihaz silme hatası',
        details: error.message 
      });
    } finally {
      client.release();
    }
  });
};
