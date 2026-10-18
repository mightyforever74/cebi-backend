// services/weighbridge/adapters/WeighbridgeAdapter.js
// ============================================================
// Weighbridge Adapter Interface (Faz 1 §8.4, onaylı mimari karar)
//
// Her adapter, fiziksel/iş akışı kaynağı ne olursa olsun aynı sözleşmeyi
// uygular: captureWeight(context) → { weightKg, rawPayload, deviceIdentifier }.
// routes/weighbridge.js bu sözleşmeye karşı yazılır, belirli bir cihaz
// markasına değil — §9.2'de cihaz bilgisi geldiğinde sadece ilgili
// adapter'ın implementasyonu değişir, route/şema katmanı etkilenmez.
//
// NOT: Şu an (2026-10-18) tartım cihazı marka/model/bağlantı yöntemi
// henüz bilinmiyor (§9.2, Cem'in kararı: kabul edildi, bekleniyor).
// Bu yüzden şu an için tek çalışan adapter ManualAdapter'dır — dispatcher/
// Tartı Memuru ağırlığı elle girer. HTTP/TCP/Serial adapter'lar iskelet
// halinde duruyor, cihaz bilgisi gelince doldurulacak.
// ============================================================

'use strict';

class WeighbridgeAdapter {
  /**
   * @param {object} context - { taskId, vehicleId, userId, ...adapter'a özel parametreler }
   * @returns {Promise<{weightKg: number, rawPayload: object|null, deviceIdentifier: string|null}>}
   */
  // eslint-disable-next-line no-unused-vars
  async captureWeight(context) {
    throw new Error(
      `${this.constructor.name}.captureWeight() implemente edilmedi`
    );
  }

  /** Adapter'ın routes/weighbridge.js'de kullanacağı sabit tip adı. */
  get type() {
    throw new Error(`${this.constructor.name}.type getter'ı tanımlanmadı`);
  }
}

module.exports = { WeighbridgeAdapter };
