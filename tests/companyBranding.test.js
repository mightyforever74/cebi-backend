"use strict";

/**
 * tests/companyBranding.test.js
 *
 * routes/companyBranding.js (GET/PUT /api/company/branding) — route/auth
 * kablolaması. İş mantığının kendisi routes/companyBrandingHelpers.test.js'de
 * kilitli; bu dosya sadece HTTP katmanını (auth/role gate, status kodları,
 * company_id izolasyonu) doğrular. `fastify.authenticate` gerçek JWT yerine
 * test başlıklarından (`x-test-role`, `x-test-company-id`) okuyan sahte bir
 * decorator ile taklit edilir.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fastify = require("fastify");
const companyBrandingRoutes = require("../routes/companyBranding");

function buildApp({ queryImpl } = {}) {
  const app = fastify({ logger: false });

  app.decorate("authenticate", async function (request, reply) {
    const role = request.headers["x-test-role"] || "company_admin";
    const companyId =
      request.headers["x-test-company-id"] !== undefined
        ? request.headers["x-test-company-id"] || null
        : "company-1";

    if (role === "super_admin") {
      request.isSuperAdmin = true;
      request.user = { role: "super_admin" };
      request.companyId = request.query.company_id || companyId;
      return;
    }
    request.isSuperAdmin = false;
    request.user = { role };
    request.companyId = companyId;
  });

  app.decorate("pg", {
    async connect() {
      return {
        query: queryImpl || (async () => ({ rows: [] })),
        async release() {},
      };
    },
  });

  return app;
}

test("GET /api/company/branding: company_id yoksa 400", async () => {
  const app = buildApp();
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/company/branding",
      headers: { "x-test-company-id": "" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/company/branding: mevcut sirketin markalamasini doner", async () => {
  const app = buildApp({
    queryImpl: async (sql, params) => {
      assert.match(sql, /SELECT name, settings FROM companies WHERE id = \$1/);
      assert.equal(params[0], "company-1");
      return {
        rows: [
          {
            name: "Acme BV",
            settings: { branding: { brandColor: "#112233" } },
          },
        ],
      };
    },
  });
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/company/branding",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.companyName, "Acme BV");
    assert.equal(body.brandColor, "#112233");
  } finally {
    await app.close();
  }
});

test("PUT /api/company/branding: driver rolu -> 403 (sadece company_admin/super_admin)", async () => {
  const app = buildApp();
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/company/branding",
      headers: { "x-test-role": "driver" },
      payload: { brandColor: "#112233" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("PUT /api/company/branding: gecersiz brandColor -> 400, DB'ye UPDATE gitmez", async () => {
  let updateCalled = false;
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.startsWith("UPDATE")) updateCalled = true;
      return { rows: [{ settings: {} }] };
    },
  });
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/company/branding",
      payload: { brandColor: "not-a-color" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(updateCalled, false);
  } finally {
    await app.close();
  }
});

test("PUT /api/company/branding: company_admin gecerli girdiyle guncelleyebilir", async () => {
  const app = buildApp({
    queryImpl: async (sql) => {
      if (sql.startsWith("SELECT settings"))
        return { rows: [{ settings: {} }] };
      if (sql.startsWith("UPDATE")) {
        return {
          rows: [
            {
              name: "Acme BV",
              settings: { branding: { brandColor: "#112233" } },
            },
          ],
        };
      }
      throw new Error("unexpected sql: " + sql);
    },
  });
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/company/branding",
      payload: { brandColor: "#112233" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().brandColor, "#112233");
  } finally {
    await app.close();
  }
});

test("PUT /api/company/branding: super_admin query'deki company_id'yi kullanir", async () => {
  let seenCompanyId = null;
  const app = buildApp({
    queryImpl: async (sql, params) => {
      if (sql.startsWith("SELECT settings")) {
        seenCompanyId = params[0];
        return { rows: [{ settings: {} }] };
      }
      return { rows: [{ name: "Other BV", settings: {} }] };
    },
  });
  await app.register(companyBrandingRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: "PUT",
      url: "/api/company/branding?company_id=company-99",
      headers: { "x-test-role": "super_admin" },
      payload: { brandColor: "#112233" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seenCompanyId, "company-99");
  } finally {
    await app.close();
  }
});
