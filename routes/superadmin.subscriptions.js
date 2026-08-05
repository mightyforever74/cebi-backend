/**
 * FEAT-SaaS S2-E2 — Supervizor onay katmani (05.08.2026, D-S1 muhru).
 * Bekleyen talepler enterprise.subscription_requests'ten okunur; APPROVE:
 * companies.max_vehicles += amount + subscription_audit_logs muhru
 * (action='quota_increase_approved', metadata.request_id) + best-effort mail.
 * Rol: strictly 'super_admin' (D-S2). Tek transaction; mail transaction DISI.
 */
module.exports = async function (fastify) {
  const guard = (request, reply) => {
    if (request.user.role !== 'super_admin') {
      reply.code(403).send({ error: 'Forbidden - Super Admin only' });
      return false;
    }
    return true;
  };

  // GET /api/superadmin/subscriptions/requests?status=PENDING_APPROVAL
  fastify.get('/api/superadmin/subscriptions/requests', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!guard(request, reply)) return;
    const status = (request.query && request.query.status) || 'PENDING_APPROVAL';
    const client = await fastify.pg.connect();
    try {
      const r = await client.query(
        `SELECT sr.id, sr.company_id, c.name AS company_name, c.max_vehicles,
                (SELECT COUNT(*)::int FROM vehicles v
                  WHERE v.company_id = c.id AND v.status != 'retired') AS active_vehicles,
                sr.request_type, sr.requested_amount, sr.payment_note,
                sr.status, sr.created_at, u.email AS requested_by_email
           FROM enterprise.subscription_requests sr
           JOIN companies c ON c.id = sr.company_id
           LEFT JOIN users u ON u.id = sr.requested_by
          WHERE sr.status = $1
          ORDER BY sr.created_at ASC`,
        [status]
      );
      return { requests: r.rows };
    } finally {
      client.release();
    }
  });

  // POST /api/superadmin/subscriptions/requests/:id/approve
  fastify.post('/api/superadmin/subscriptions/requests/:id/approve', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id } = request.params;
    const note = (request.body && request.body.decision_note) || null;
    const client = await fastify.pg.connect();
    let mailTo = null; let approved = null;
    try {
      await client.query('BEGIN');
      const rq = await client.query(
        `SELECT * FROM enterprise.subscription_requests
          WHERE id = $1 AND status = 'PENDING_APPROVAL' FOR UPDATE`,
        [id]
      );
      if (rq.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Not Found', message: 'Bekleyen talep bulunamadi' });
      }
      const req0 = rq.rows[0];
      if (req0.request_type !== 'vehicle_increase') {
        await client.query('ROLLBACK');
        return reply.code(422).send({ error: 'Unprocessable', message: 'api_package onayi FEAT-Connect kapsaminda — bu endpoint yalniz vehicle_increase' });
      }
      const comp = await client.query(
        `UPDATE companies SET max_vehicles = max_vehicles + $1
          WHERE id = $2
          RETURNING name, max_vehicles, billing_email, email`,
        [req0.requested_amount, req0.company_id]
      );
      const newMax = comp.rows[0].max_vehicles;
      await client.query(
        `UPDATE enterprise.subscription_requests
            SET status='APPROVED', decided_by=$1, decided_at=NOW(),
                decision_note=$2, updated_at=NOW()
          WHERE id = $3`,
        [request.user.id, note, id]
      );
      await client.query(
        `INSERT INTO subscription_audit_logs
           (company_id, action, reason, metadata, changed_by)
         VALUES ($1, 'quota_increase_approved', $2,
                 jsonb_build_object('request_id', $3::text,
                                    'requested_amount', $4::int,
                                    'new_max_vehicles', $5::int), $6)`,
        [req0.company_id, note, id, req0.requested_amount, newMax, request.user.id]
      );
      await client.query('COMMIT');
      approved = { id, company: comp.rows[0].name, new_max_vehicles: newMax };
      mailTo = comp.rows[0].billing_email || comp.rows[0].email;
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error({ err }, 'subscription approve failed');
      return reply.code(500).send({ error: 'Internal Server Error' });
    } finally {
      client.release();
    }
    // best-effort mail — COMMIT sonrasi, akisi asla dusurmez (internalBridge deseni)
    if (mailTo && fastify.transporter) {
      try {
        await fastify.transporter.sendMail({
          from: process.env.SMTP_FROM || 'noreply@tulipfleet.com',
          to: mailTo,
          subject: 'TulipFleet — Arac Kota Artirim Talebiniz Onaylandi',
          text: `Talebiniz onaylandi. Yeni arac kotaniz: ${approved.new_max_vehicles}.`,
        });
      } catch (mailErr) {
        request.log.error({ mailErr }, 'approve mail failed (best-effort)');
      }
    }
    return { approved };
  });

  // POST /api/superadmin/subscriptions/requests/:id/reject
  fastify.post('/api/superadmin/subscriptions/requests/:id/reject', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id } = request.params;
    const note = (request.body && request.body.decision_note) || null;
    const client = await fastify.pg.connect();
    try {
      const r = await client.query(
        `UPDATE enterprise.subscription_requests
            SET status='REJECTED', decided_by=$1, decided_at=NOW(),
                decision_note=$2, updated_at=NOW()
          WHERE id = $3 AND status = 'PENDING_APPROVAL'
          RETURNING id, status`,
        [request.user.id, note, id]
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'Not Found', message: 'Bekleyen talep bulunamadi' });
      return { rejected: r.rows[0] };
    } finally {
      client.release();
    }
  });

  // PUT /api/superadmin/subscriptions/companies/:id/quota — manuel kota + ZORUNLU muhur
  // (Spec S4 Sayfa 4 "Guncelle & Muhurle"; mevcut companies PUT'una dokunulmadi.)
  fastify.put('/api/superadmin/subscriptions/companies/:id/quota', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id } = request.params;
    const newMax = Number(request.body && request.body.max_vehicles);
    const reason = (request.body && request.body.reason) || null;
    if (!Number.isInteger(newMax) || newMax < 0) {
      return reply.code(400).send({ error: 'Bad Request', message: 'max_vehicles pozitif tamsayi olmali' });
    }
    if (!reason || String(reason).trim().length < 5) {
      return reply.code(400).send({ error: 'Bad Request', message: 'reason zorunlu (min 5 karakter) — muhursuz manuel degisiklik yok' });
    }
    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT max_vehicles, name FROM companies WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rowCount === 0) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Not Found' }); }
      const oldMax = cur.rows[0].max_vehicles;
      await client.query('UPDATE companies SET max_vehicles = $1 WHERE id = $2', [newMax, id]);
      await client.query(
        `INSERT INTO subscription_audit_logs (company_id, action, reason, metadata, changed_by)
         VALUES ($1, 'quota_manual_update', $2,
                 jsonb_build_object('old_max_vehicles', $3::int, 'new_max_vehicles', $4::int), $5)`,
        [id, reason, oldMax, newMax, request.user.id]
      );
      await client.query('COMMIT');
      return { updated: { company: cur.rows[0].name, old_max_vehicles: oldMax, new_max_vehicles: newMax } };
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error({ err }, 'manual quota update failed');
      return reply.code(500).send({ error: 'Internal Server Error' });
    } finally {
      client.release();
    }
  });
};
