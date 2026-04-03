module.exports = async function (fastify) {
  // GET /api/superadmin/companies - Birleşik Liste (Özet + Acil + Abonelik dahil)
  fastify.get('/api/superadmin/companies', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { status, tier, sort = 'name' } = request.query || {};

      let query = `
        SELECT 
          c.id, c.name, c.slug, c.email, c.phone, c.city, c.country, c.address,
          c.tax_id, c.max_vehicles, c.max_drivers, c.billing_email,
          c.package_type, c.status, c.is_trial, c.trial_ends_at,
          c.subscription_tier, c.subscription_status, c.per_vehicle_fee, c.monthly_fee,
          c.subscription_starts_at, c.subscription_ends_at,
          c.last_payment_at, c.next_payment_due, c.payment_method,
          c.suspended_at, c.suspend_reason, c.notes,
          c.created_at, c.location_retention_days,
          COALESCE(v.vehicle_count, 0) as vehicle_count,
          COALESCE(d.driver_count, 0) as driver_count,
          COALESCE(dev.device_count, 0) as device_count,
          u.first_name || ' ' || u.last_name as admin_name,
          u.email as admin_email,
          u.phone as admin_phone,
          CASE 
            WHEN c.next_payment_due IS NOT NULL THEN
              EXTRACT(DAY FROM c.next_payment_due - CURRENT_TIMESTAMP)::INTEGER
            ELSE NULL
          END as days_until_due,
          CASE 
            WHEN c.trial_ends_at IS NOT NULL THEN
              EXTRACT(DAY FROM c.trial_ends_at - CURRENT_TIMESTAMP)::INTEGER
            ELSE NULL
          END as trial_days_left
        FROM companies c
        LEFT JOIN (
          SELECT company_id, COUNT(*) as vehicle_count 
          FROM vehicles WHERE status != 'retired' 
          GROUP BY company_id
        ) v ON v.company_id = c.id
        LEFT JOIN (
          SELECT company_id, COUNT(*) as driver_count 
          FROM drivers 
          GROUP BY company_id
        ) d ON d.company_id = c.id
        LEFT JOIN (
          SELECT company_id, COUNT(*) as device_count 
          FROM devices 
          GROUP BY company_id
        ) dev ON dev.company_id = c.id
        LEFT JOIN users u ON u.company_id = c.id AND u.role = 'company_admin'
        WHERE 1=1
      `;

      const params = [];
      let paramIndex = 1;

      if (status) {
        query += ` AND c.subscription_status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }
      if (tier) {
        query += ` AND c.subscription_tier = $${paramIndex}`;
        params.push(tier);
        paramIndex++;
      }

      const sortMap = {
        name: 'c.name ASC',
        created_at: 'c.created_at DESC',
        next_payment_due: 'c.next_payment_due ASC NULLS LAST',
      };
      query += ` ORDER BY ${sortMap[sort] || 'c.name ASC'}`;

      const companiesResult = await client.query(query, params);
      const companies = companiesResult.rows || [];

      const summary = {
        total: companies.length,
        by_status: {
          trial: companies.filter((c) => c.subscription_status === 'trial').length,
          active: companies.filter((c) => c.subscription_status === 'active').length,
          suspended: companies.filter((c) => c.subscription_status === 'suspended').length,
          expired: companies.filter((c) => c.subscription_status === 'expired').length,
          cancelled: companies.filter((c) => c.subscription_status === 'cancelled').length,
        },
        by_tier: {
          starter: companies.filter((c) => c.subscription_tier === 'starter').length,
          professional: companies.filter((c) => c.subscription_tier === 'professional').length,
          enterprise: companies.filter((c) => c.subscription_tier === 'enterprise').length,
          custom: companies.filter((c) => c.subscription_tier === 'custom').length,
        },
        monthly_revenue: companies
          .filter((c) => c.subscription_status === 'active')
          .reduce((sum, c) => sum + parseFloat(c.monthly_fee || 0), 0),
        total_vehicles: companies.reduce((sum, c) => sum + parseInt(c.vehicle_count || 0), 0),
        total_drivers: companies.reduce((sum, c) => sum + parseInt(c.driver_count || 0), 0),
      };

      const urgent = {
        payment_overdue: companies
          .filter(
            (c) => c.subscription_status === 'active' && c.days_until_due !== null && c.days_until_due < 0
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            days_overdue: Math.abs(c.days_until_due),
            amount_due: c.monthly_fee,
            admin_email: c.admin_email,
          })),
        trial_ending: companies
          .filter(
            (c) =>
              c.subscription_status === 'trial' &&
              c.trial_days_left !== null &&
              c.trial_days_left <= 7 &&
              c.trial_days_left >= 0
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            days_left: c.trial_days_left,
            vehicle_count: c.vehicle_count,
          })),
      };

      return reply.send({ summary, urgent, companies });
    } catch (error) {
      request.log.error(error, 'Companies list error');
      return reply.status(500).send({ error: 'Şirket listesi alınamadı' });
    } finally {
      client.release();
    }
  });

  // GET /api/superadmin/companies/:id - Detay (Tab'lar için)
  fastify.get('/api/superadmin/companies/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const { id } = request.params;
    const client = await fastify.pg.connect();
    try {
      const companyResult = await client.query(
        `
        SELECT 
          c.*,
          COALESCE(v.vehicle_count, 0) as vehicle_count,
          COALESCE(d.driver_count, 0) as driver_count,
          COALESCE(dev.device_count, 0) as device_count
        FROM companies c
        LEFT JOIN (SELECT company_id, COUNT(*) as vehicle_count FROM vehicles WHERE status != 'retired' GROUP BY company_id) v ON v.company_id = c.id
        LEFT JOIN (SELECT company_id, COUNT(*) as driver_count FROM drivers GROUP BY company_id) d ON d.company_id = c.id
        LEFT JOIN (SELECT company_id, COUNT(*) as device_count FROM devices GROUP BY company_id) dev ON dev.company_id = c.id
        WHERE c.id = $1
      `,
        [id]
      );

      if (companyResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Şirket bulunamadı' });
      }

      const company = companyResult.rows[0];

      const adminResult = await client.query(
        `
        SELECT id, first_name, last_name, email, phone 
        FROM users 
        WHERE company_id = $1 AND role = 'company_admin'
        LIMIT 1
      `,
        [id]
      );

      const devicesResult = await client.query(
        `
        SELECT d.id, d.device_code, d.serial, d.status, d.firmware_version,
               v.plate_no, v.brand, v.model
        FROM devices d
        LEFT JOIN vehicles v ON v.id = d.vehicle_id
        WHERE d.company_id = $1
        ORDER BY d.created_at DESC
        LIMIT 20
      `,
        [id]
      );

      const paymentsResult = await client.query(
        `
        SELECT id, amount, currency, payment_date, payment_method, 
               period_start, period_end, status, invoice_number
        FROM payment_history
        WHERE company_id = $1
        ORDER BY payment_date DESC
        LIMIT 5
      `,
        [id]
      );

      const auditResult = await client.query(
        `
        SELECT al.*, u.first_name || ' ' || u.last_name as changed_by_name
        FROM subscription_audit_logs al
        LEFT JOIN users u ON u.id = al.changed_by
        WHERE al.company_id = $1
        ORDER BY al.created_at DESC
        LIMIT 10
      `,
        [id]
      );

      return reply.send({
        company,
        admin: adminResult.rows[0] || null,
        usage: {
          vehicles: { current: parseInt(company.vehicle_count), max: company.max_vehicles },
          drivers: { current: parseInt(company.driver_count), max: company.max_drivers },
          devices: { current: parseInt(company.device_count), max: company.max_vehicles },
        },
        devices: devicesResult.rows,
        recent_payments: paymentsResult.rows,
        audit_logs: auditResult.rows,
      });
    } catch (error) {
      request.log.error(error, 'Company detail error');
      return reply.status(500).send({ error: 'Şirket detayı alınamadı' });
    } finally {
      client.release();
    }
  });

  // PUT /api/superadmin/companies/:id - Şirket güncelle (tier dahil)
  fastify.put('/api/superadmin/companies/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const {
        name, email, phone, city, country, address,
        subscription_tier, subscription_status,
        max_vehicles, max_drivers,
        per_vehicle_fee, monthly_fee,
        notes, currency
      } = request.body || {};

      const companyResult = await client.query('SELECT * FROM companies WHERE id = $1', [id]);
      if (companyResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Şirket bulunamadı' });
      }
      const old = companyResult.rows[0];

      // Tier → retention mapping
      const retentionMap = {
        starter: 30,
        professional: 90,
        enterprise: 365,
        custom: old.location_retention_days || 30,
      };
      const newRetention = subscription_tier ? retentionMap[subscription_tier] : old.location_retention_days;

      await client.query('BEGIN');

      await client.query(
        `
        UPDATE companies SET
          name = COALESCE($2, name),
          email = COALESCE($3, email),
          phone = COALESCE($4, phone),
          city = COALESCE($5, city),
          country = COALESCE($6, country),
          address = COALESCE($7, address),
          subscription_tier = COALESCE($8, subscription_tier),
          subscription_status = COALESCE($9, subscription_status),
          max_vehicles = COALESCE($10, max_vehicles),
          max_drivers = COALESCE($11, max_drivers),
          per_vehicle_fee = COALESCE($12, per_vehicle_fee),
          monthly_fee = COALESCE($13, monthly_fee),
          notes = COALESCE($14, notes),
          currency = COALESCE($15, currency),
          location_retention_days = $16,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
        [
          id, name, email, phone, city, country, address,
          subscription_tier, subscription_status,
          max_vehicles, max_drivers,
          per_vehicle_fee, monthly_fee,
          notes, currency,
          newRetention,
        ]
      );

      // Tier değiştiyse audit log'a yaz
      if (subscription_tier && subscription_tier !== old.subscription_tier) {
        await client.query(
          `
          INSERT INTO subscription_audit_logs (company_id, action, old_status, new_status, reason, changed_by)
          VALUES ($1, 'tier_changed', $2, $3, $4, $5)
        `,
          [
            id,
            old.subscription_tier,
            subscription_tier,
            `Paket değiştirildi: ${old.subscription_tier} → ${subscription_tier} (retention: ${newRetention} gün)`,
            request.user.id,
          ]
        );
      }

      await client.query('COMMIT');

      const updated = await client.query('SELECT * FROM companies WHERE id = $1', [id]);
      return reply.send({ success: true, company: updated.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error(error, 'Company update error');
      return reply.status(500).send({ error: 'Şirket güncellenemedi' });
    } finally {
      client.release();
    }
  });

  // POST /api/superadmin/companies/:id/payment-received - Ödeme kaydet + Aktifleştir
  fastify.post('/api/superadmin/companies/:id/payment-received', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const { amount, payment_method, period_start, period_end, invoice_number, notes } = request.body || {};

      if (!amount || !payment_method || !period_start || !period_end) {
        return reply.status(400).send({ error: 'amount, payment_method, period_start, period_end required' });
      }

      await client.query('BEGIN');
      const companyResult = await client.query('SELECT * FROM companies WHERE id = $1', [id]);
      if (companyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Şirket bulunamadı' });
      }
      const oldCompany = companyResult.rows[0];

      const paymentResult = await client.query(
        `
        INSERT INTO payment_history (company_id, amount, payment_method, period_start, period_end, invoice_number, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
        [id, amount, payment_method, period_start, period_end, invoice_number || null, notes || null, request.user.id]
      );

      const nextPaymentDue = new Date(period_end);
      nextPaymentDue.setDate(nextPaymentDue.getDate() + 1);

      await client.query(
        `
        UPDATE companies SET
          subscription_status = 'active',
          status = 'active',
          is_trial = false,
          last_payment_at = CURRENT_TIMESTAMP,
          subscription_starts_at = COALESCE(subscription_starts_at, $2),
          next_payment_due = $3,
          monthly_fee = $4,
          suspended_at = NULL,
          suspend_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
        [id, period_start, nextPaymentDue, amount]
      );

      await client.query(
        `
        INSERT INTO subscription_audit_logs (company_id, action, old_status, new_status, old_fee, new_fee, reason, changed_by)
        VALUES ($1, 'payment_received', $2, 'active', $3, $4, $5, $6)
      `,
        [id, oldCompany.subscription_status, oldCompany.monthly_fee, amount, `Ödeme: ${invoice_number || 'N/A'}`, request.user.id]
      );

      await client.query('COMMIT');
      return reply.send({ success: true, message: 'Ödeme kaydedildi, abonelik aktifleştirildi', payment: paymentResult.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error(error, 'Payment error');
      if (error && error.code === '23505') {
        return reply.status(400).send({ error: 'Bu dönem için zaten ödeme kaydı var' });
      }
      return reply.status(500).send({ error: 'Ödeme kaydedilemedi' });
    } finally {
      client.release();
    }
  });

  // POST /api/superadmin/companies/:id/suspend - Askıya al
  fastify.post('/api/superadmin/companies/:id/suspend', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const { reason = 'manual', notes } = request.body || {};

      await client.query('BEGIN');
      const companyResult = await client.query('SELECT * FROM companies WHERE id = $1', [id]);
      if (companyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Şirket bulunamadı' });
      }
      const oldCompany = companyResult.rows[0];

      await client.query(
        `
        UPDATE companies SET
          subscription_status = 'suspended',
          status = 'suspended',
          suspended_at = CURRENT_TIMESTAMP,
          suspend_reason = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
        [id, notes || `Sebep: ${reason}`]
      );

      await client.query(
        `
        INSERT INTO subscription_audit_logs (company_id, action, old_status, new_status, reason, changed_by)
        VALUES ($1, 'suspended', $2, 'suspended', $3, $4)
      `,
        [id, oldCompany.subscription_status, notes || reason, request.user.id]
      );

      await client.query('COMMIT');
      return reply.send({ success: true, message: 'Şirket askıya alındı' });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error(error, 'Suspend error');
      return reply.status(500).send({ error: 'Askıya alma başarısız' });
    } finally {
      client.release();
    }
  });

  // POST /api/superadmin/companies/:id/extend-trial - Trial uzat
  fastify.post('/api/superadmin/companies/:id/extend-trial', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const { days = 7 } = request.body || {};

      const result = await client.query(
        `
        UPDATE companies SET
          trial_ends_at = COALESCE(trial_ends_at, CURRENT_TIMESTAMP) + INTERVAL '1 day' * $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND subscription_status = 'trial'
        RETURNING *
      `,
        [id, days]
      );

      if (result.rows.length === 0) {
        return reply.status(400).send({ error: 'Şirket trial durumunda değil' });
      }

      await client.query(
        `
        INSERT INTO subscription_audit_logs (company_id, action, reason, changed_by)
        VALUES ($1, 'trial_extended', $2, $3)
      `,
        [id, `${days} gün uzatıldı`, request.user.id]
      );

      return reply.send({ success: true, message: `Trial ${days} gün uzatıldı`, new_trial_ends_at: result.rows[0].trial_ends_at });
    } catch (error) {
      request.log.error(error, 'Extend trial error');
      return reply.status(500).send({ error: 'Trial uzatılamadı' });
    } finally {
      client.release();
    }
  });

  // GET /api/superadmin/companies/:id/payments - Ödeme geçmişi
  fastify.get('/api/superadmin/companies/:id/payments', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const result = await client.query(
        `
        SELECT ph.*, u.first_name || ' ' || u.last_name as created_by_name
        FROM payment_history ph
        LEFT JOIN users u ON u.id = ph.created_by
        WHERE ph.company_id = $1
        ORDER BY ph.payment_date DESC
      `,
        [id]
      );
      return reply.send({ payments: result.rows });
    } catch (error) {
      request.log.error(error, 'Payment history error');
      return reply.status(500).send({ error: 'Ödeme geçmişi alınamadı' });
    } finally {
      client.release();
    }
  });

  // GET /api/superadmin/companies/:id/audit-logs - Audit log
  fastify.get('/api/superadmin/companies/:id/audit-logs', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'super_admin') {
      return reply.code(403).send({ error: 'Forbidden - Super Admin only' });
    }

    const client = await fastify.pg.connect();
    try {
      const { id } = request.params;
      const result = await client.query(
        `
        SELECT al.*, u.first_name || ' ' || u.last_name as changed_by_name
        FROM subscription_audit_logs al
        LEFT JOIN users u ON u.id = al.changed_by
        WHERE al.company_id = $1
        ORDER BY al.created_at DESC
      `,
        [id]
      );
      return reply.send({ logs: result.rows });
    } catch (error) {
      request.log.error(error, 'Audit log error');
      return reply.status(500).send({ error: 'Audit log alınamadı' });
    } finally {
      client.release();
    }
  });
};