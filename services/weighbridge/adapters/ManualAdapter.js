// services/weighbridge/adapters/ManualAdapter.js
// ============================================================
// Tartı Memuru/dispatcher, ağırlığı elle girer (cihaz entegrasyonu yok).
// §9.2'de cihaz bilgisi gelene kadar TEK çalışan adapter budur —
// weighbridge bounded context'i bu adapter ile uçtan uca kullanılabilir,
// donanım entegrasyonunu beklemez.
// ============================================================

'use strict';

const { WeighbridgeAdapter } = require('./WeighbridgeAdapter');

class ManualAdapter extends WeighbridgeAdapter {
  get type() {
    return 'manual';
  }

  /**
   * @param {object} context - { weightKg, note? }
   */
  async captureWeight(context) {
    const weightKg = Number(context?.weightKg);
    if (!Number.isFinite(weightKg) || weightKg < 0) {
      throw new Error('weightKg geçerli, negatif olmayan bir sayı olmalı');
    }

    return {
      weightKg,
      rawPayload: context?.note ? { note: String(context.note) } : null,
      deviceIdentifier: null, // manuel girişte cihaz yok
    };
  }
}

module.exports = { ManualAdapter };
