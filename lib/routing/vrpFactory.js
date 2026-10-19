"use strict";

const MockVrpProvider = require("./MockVrpProvider");
const HereTourPlanningProvider = require("./HereTourPlanningProvider");

/**
 * VRP (Vehicle Routing Problem) sağlayıcı factory: Faz A-2 (port) + Faz A-3
 * (gerçek HERE Tour Planning) portu.
 *
 * `tulipfleet-enterprise-backend/lib/routing/factory.js`'ten port, ama
 * İSİM VE ENV DEĞİŞKENİ KASITLI OLARAK FARKLI: cebi-backend'de zaten
 * `services/routing/factory.js` + `ROUTING_PROVIDER` (tekil rota/trafik,
 * HERE Routing API v8 — Dispatcher Faz A'nın `routes/active`'i bunu
 * kullanıyor) var. Bu, TAMAMEN AYRI bir sorun uzayı: "hangi görev hangi
 * araca/sürücüye verilsin" (VRP çözümü), tekil A→B rota hesaplama değil.
 * Aynı env değişkeni adını (`ROUTING_PROVIDER`) iki farklı sağlayıcı seçimi
 * için kullanmak sessiz bir karışıklık/çakışma riski yaratırdı — bu yüzden
 * burada `VRP_PROVIDER` kullanılıyor.
 *
 * `here-tour` (Faz A-3, 2026-10-19): `tulipfleet-enterprise-backend/lib/
 * routing/HereTourPlanningProvider.js`'ten port edildi (orada canlıda
 * doğrulanmış implementasyon). AÇIK RİSK: kaynaktaki HERE hesabının Tour
 * Planning'e (Base Plan'ın "Optimization" kategorisi) erişimi doğrulandı,
 * ama cebi-backend'in KENDİ `HERE_API_KEY`'inin aynı yetkiye sahip olup
 * olmadığı henüz canlıda doğrulanmadı; bu kod bir ön koşul/engel olarak
 * ele alınmadı, `VRP_PROVIDER=here-tour` set edilip gerçek bir istek
 * atıldığında ortaya çıkacak bir runtime bulgusu (bkz.
 * HereTourPlanningProvider.js başlık yorumu).
 *
 * cebi-backend'in kendi `services/routing/factory.js`'i gibi: tanınmayan
 * değer sessizce mock'a düşmez, LOUD throw eder (typo'lu env prod'da
 * sessizce yanlış sağlayıcıyı gizlememeli).
 *
 * @param {Object} pgPoolInstance - fastify.pg (pool veya transaction client)
 * @returns {MockVrpProvider|HereTourPlanningProvider}
 */
function getVrpProvider(pgPoolInstance) {
  const providerType = (process.env.VRP_PROVIDER || "mock").toLowerCase();

  if (!pgPoolInstance || typeof pgPoolInstance.query !== "function") {
    throw new Error(
      "getVrpProvider: valid Fastify pg pool/client instance is missing."
    );
  }

  switch (providerType) {
    case "mock":
      return new MockVrpProvider(pgPoolInstance);
    case "here-tour":
      return new HereTourPlanningProvider(pgPoolInstance);
    default:
      throw new Error(
        "Unknown VRP_PROVIDER: '" + providerType + "' (expected 'mock' or 'here-tour')"
      );
  }
}

module.exports = { getVrpProvider };
