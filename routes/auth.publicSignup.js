/**
 * FEAT-SAAS-2 S-O1 — Public Onboarding (10.08.2026, spec §6).
 * D-O1: subscription_requests'e YAZMAZ. D-O2: honeypot + in-memory IP 3/saat.
 * D-O3 (sade): parola/OTP GONDERILMEZ — kullanilamaz rastgele hash + mevcut
 * forgot/reset-password akisina yonlendiren hosgeldin maili (kanitli zincir).
 * Muhur (CHECK-kanitli): status=active, subscription_status=trial,
 * tier=starter, max_vehicles=5, is_trial=true, trial_ends_at=+14 gun.
 */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const signupHits = new Map(); // ip -> [ts]; v1 in-memory (spec D-O2)

function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g").replace(/[ıİI]/g, "i")
    .replace(/[öÖ]/g, "o").replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "firma";
}

module.exports = async function (fastify) {
  fastify.post("/api/auth/public-signup", async (request, reply) => {
    const b = request.body || {};
    // Honeypot: doluysa sessiz 200 (bot yutma)
    if (b.hp_field) {
      request.log.warn({ ip: request.ip }, "signup honeypot hit");
      return { ok: true };
    }
    // In-memory IP rate limit: 3/saat
    const ip = request.headers["x-forwarded-for"] || request.ip;
    const now = Date.now();
    const hits = (signupHits.get(ip) || []).filter((t) => now - t < 3600000);
    if (hits.length >= 3) return reply.code(429).send({ error: "Too many requests. Please wait." });
    hits.push(now);
    signupHits.set(ip, hits);

    const companyName = String(b.company_name || "").trim();
    const adminEmail = String(b.admin_email || "").trim().toLowerCase();
    const adminName = String(b.admin_name || "").trim();
    const phone = String(b.phone || "").trim() || null;
    const estVehicles = Number.isInteger(Number(b.estimated_vehicles)) ? Number(b.estimated_vehicles) : null;
    if (companyName.length < 2 || adminName.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
      return reply.code(400).send({ error: "Bad Request", message: "company_name, admin_name ve gecerli admin_email zorunlu" });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query("BEGIN");
      const dupe = await client.query("SELECT 1 FROM users WHERE email = $1", [adminEmail]);
      if (dupe.rowCount > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Conflict", message: "Bu e-posta ile kayit zaten var" });
      }
      // slug: cakisirsa -2, -3...
      const base = slugify(companyName);
      let slug = base;
      for (let i = 2; i <= 20; i++) {
        const s = await client.query("SELECT 1 FROM companies WHERE slug = $1", [slug]);
        if (s.rowCount === 0) break;
        slug = `${base}-${i}`;
      }
      const comp = await client.query(
        `INSERT INTO companies (name, slug, phone, status, subscription_status, subscription_tier,
                                max_vehicles, is_trial, trial_ends_at, settings)
         VALUES ($1, $2, $3, 'active', 'trial', 'starter', 5, true, NOW() + INTERVAL '14 days', $4)
         RETURNING id, name, slug, trial_ends_at`,
        [companyName, slug, phone, JSON.stringify({ source: "public_signup", estimated_vehicles: estVehicles })]
      );
      const companyId = comp.rows[0].id;
      // Kullanilamaz rastgele parola (kullanici forgot-password ile belirler)
      const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
      const nameParts = adminName.split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(" ") || null;
      await client.query(
        `INSERT INTO users (email, password_hash, role, company_id, first_name, last_name, phone)
         VALUES ($1, $2, 'company_admin', $3, $4, $5, $6)`,
        [adminEmail, unusable, companyId, firstName, lastName, phone]
      );
      await client.query("COMMIT");

      // Best-effort hosgeldin maili (COMMIT sonrasi, akisi dusurmez)
      if (fastify.transporter) {
        try {
          await fastify.transporter.sendMail({
            from: process.env.SMTP_FROM || "TulipFleet <info@tulipfleet.com>",
            to: adminEmail,
            subject: "TulipFleet'e Hos Geldiniz — 14 Gunluk Deneme Basladi",
            text: `Merhaba ${firstName},\n\n${companyName} icin TulipFleet deneme hesabiniz acildi (5 arac kotasi, ${new Date(comp.rows[0].trial_ends_at).toLocaleDateString("tr-TR")} tarihine kadar).\n\nSifrenizi belirlemek icin giris ekranindaki "Sifremi Unuttum" adimini bu e-posta adresiyle kullanin.\n\nTulipFleet Ekibi`,
          });
        } catch (mailErr) {
          request.log.error({ mailErr }, "signup welcome mail failed (best-effort)");
        }
      }
      return reply.code(201).send({ ok: true, company: comp.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error({ err }, "public signup failed");
      return reply.code(500).send({ error: "Internal Server Error" });
    } finally {
      client.release();
    }
  });
};
