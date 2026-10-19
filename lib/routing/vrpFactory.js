"use strict";

const MockVrpProvider = require("./MockVrpProvider");

/**
 * VRP (Vehicle Routing Problem) sağlayıcı factory — Faz A-2 portu.
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
 * KASITLI OLARAK PORT EDİLMEDİ: `HereTourPlanningProvider` (gerçek HERE
 * Tour Planning API/VRP çözücü). Kaynakta da varsayılan DEĞİL
 * (`ROUTING_PROVIDER=here-tour` açıkça set edilmeden hiçbir ortamda
 * devreye girmiyor) — yani şu an üretimde ÇALIŞAN gerçek davranış zaten
 * Mock'tur. `MockVrpProvider` burada "demo/simülasyon" değil, kaynağın
 * kendisinin de production'da kullandığı gerçek state machine'in birebir
 * portu. Gerçek HERE VRP entegrasyonu ayrı bir takip işi (öneri: "Faz A-3").
 *
 * cebi-backend'in kendi `services/routing/factory.js`'i gibi: tanınmayan
 * değer sessizce mock'a düşmez, LOUD throw eder (typo'lu env prod'da
 * sessizce yanlış sağlayıcıyı gizlememeli).
 *
 * @param {Object} pgPoolInstance - fastify.pg (pool veya transaction client)
 * @returns {MockVrpProvider}
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
    default:
      throw new Error(
        "Unknown VRP_PROVIDER: '" + providerType + "' (expected 'mock'; " +
          "'here-tour' henüz port edilmedi — bkz. lib/routing/vrpFactory.js)"
      );
  }
}

module.exports = { getVrpProvider };
