// services/weighbridge/index.js
// ============================================================
// Weighbridge adapter factory — routes/weighbridge.js bunun dışında
// hiçbir adapter'ı doğrudan import etmez (adapter_type string'inden
// doğru implementasyona yönlendirme tek yerden yapılır).
// ============================================================

'use strict';

const { ManualAdapter } = require('./adapters/ManualAdapter');
const { HttpAdapter } = require('./adapters/HttpAdapter');
const { TcpAdapter } = require('./adapters/TcpAdapter');
const { SerialAdapter } = require('./adapters/SerialAdapter');

const ADAPTERS = {
  manual: new ManualAdapter(),
  http: new HttpAdapter(),
  tcp: new TcpAdapter(),
  serial: new SerialAdapter(),
};

/**
 * @param {string} adapterType - 'manual' | 'http' | 'tcp' | 'serial'
 * @returns {import('./adapters/WeighbridgeAdapter').WeighbridgeAdapter}
 */
function getWeighbridgeAdapter(adapterType) {
  const adapter = ADAPTERS[adapterType];
  if (!adapter) {
    throw Object.assign(
      new Error(`Bilinmeyen weighbridge adapter_type: ${adapterType}`),
      { statusCode: 400 }
    );
  }
  return adapter;
}

module.exports = { getWeighbridgeAdapter };
