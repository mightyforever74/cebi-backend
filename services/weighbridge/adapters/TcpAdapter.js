// services/weighbridge/adapters/TcpAdapter.js
// ============================================================
// Cihaz ham bir TCP soketi üzerinden ağırlık veri akışı sağlıyorsa
// kullanılacak adapter — İSKELET, §9.2 cihaz bilgisi gelince doldurulacak.
// ============================================================

'use strict';

const { WeighbridgeAdapter } = require('./WeighbridgeAdapter');

class TcpAdapter extends WeighbridgeAdapter {
  get type() {
    return 'tcp';
  }

  // eslint-disable-next-line no-unused-vars
  async captureWeight(context) {
    // TODO(§9.2): cihaz marka/model/IP:port + protokol (ör. sabit frame
    // formatı, checksum) bilgisi gelince implemente et.
    throw Object.assign(
      new Error('TCP weighbridge adapter henüz yapılandırılmadı (§9.2 bekleniyor)'),
      { statusCode: 501 }
    );
  }
}

module.exports = { TcpAdapter };
