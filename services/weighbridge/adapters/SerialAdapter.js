// services/weighbridge/adapters/SerialAdapter.js
// ============================================================
// Cihaz RS-232/RS-485 gibi bir seri port üzerinden (muhtemelen bir
// gateway/ara cihaz aracılığıyla, çünkü backend bir Hetzner VPS'te
// çalışıyor, fiziksel seri port yok) ağırlık veriyorsa kullanılacak
// adapter — İSKELET, §9.2 cihaz bilgisi gelince doldurulacak.
// ============================================================

'use strict';

const { WeighbridgeAdapter } = require('./WeighbridgeAdapter');

class SerialAdapter extends WeighbridgeAdapter {
  get type() {
    return 'serial';
  }

  // eslint-disable-next-line no-unused-vars
  async captureWeight(context) {
    // TODO(§9.2): backend sunucuda fiziksel seri port olmadığından, bu
    // adapter muhtemelen bir ara gateway'in (ör. saha tarafındaki bir
    // mini-PC/ESP32) HTTP üzerinden bu backend'e ilettiği veriyi işleyecek
    // şekilde tasarlanacak — cihaz bilgisi gelince netleşir.
    throw Object.assign(
      new Error('Serial weighbridge adapter henüz yapılandırılmadı (§9.2 bekleniyor)'),
      { statusCode: 501 }
    );
  }
}

module.exports = { SerialAdapter };
