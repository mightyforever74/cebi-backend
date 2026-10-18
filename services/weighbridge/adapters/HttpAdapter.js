// services/weighbridge/adapters/HttpAdapter.js
// ============================================================
// Cihaz HTTP üzerinden bir endpoint'e ağırlık yayınlıyorsa (ör. webhook/
// polling) kullanılacak adapter — İSKELET, §9.2 cihaz bilgisi gelince
// doldurulacak. Şimdilik bilinçli olarak "not configured" hatası fırlatır;
// routes/weighbridge.js adapter_type='http' seçilirse bu hatayı 501 olarak
// yansıtır, mimariyi bloklamaz.
// ============================================================

'use strict';

const { WeighbridgeAdapter } = require('./WeighbridgeAdapter');

class HttpAdapter extends WeighbridgeAdapter {
  get type() {
    return 'http';
  }

  // eslint-disable-next-line no-unused-vars
  async captureWeight(context) {
    // TODO(§9.2): cihaz marka/model/endpoint bilgisi gelince implemente et.
    // Beklenen şekil: context'ten task/vehicle alınır, cihazın HTTP
    // endpoint'ine istek atılır (ör. GET /weight veya webhook payload'ı
    // context.rawBody olarak zaten gelmiş olabilir), yanıt
    // { weightKg, rawPayload, deviceIdentifier } şekline normalize edilir.
    throw Object.assign(
      new Error('HTTP weighbridge adapter henüz yapılandırılmadı (§9.2 bekleniyor)'),
      { statusCode: 501 }
    );
  }
}

module.exports = { HttpAdapter };
