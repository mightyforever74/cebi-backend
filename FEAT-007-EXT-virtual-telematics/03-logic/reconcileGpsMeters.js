/**
 * FEAT-007-EXT-virtual-telematics / 03-logic/reconcileGpsMeters.js
 * GPS ve Sayaç Mutabakat Motoru (Reconciliation & Alert Manager)
 *
 * KARAR (bu oturumda mühürlendi): Sütun 2 bir GENİŞLETME (expansion) motoru
 * DEĞİL, bir YARGIÇ (reconciliation/decision) motorudur. GPS'i drift_factor ile
 * çarpmak GPS'i iptal eder (GPS × odo/GPS = odo, Sütun 1 R_f çelişkisinin tekrarı).
 * Bunun yerine: GPS ile odometer'ı KARŞILAŞTIR, sapma >%5 ise odometer baz + uyarı.
 *
 * Kanıt (bu oturumda PostGIS): DEMO-ESP-002, GPS 30.57km vs odo 626km, drift 20.48
 * (sapma %95). Seed GPS'i rastgele yönlü jitter, gerçek rota değil. Bugün fonksiyon
 * "GPS güvenilmez, odometer baz, uyarı" der (doğru). Yarın gerçek GPS gelince
 * sapma %5 altına iner, GPS kullanılır. Çarpma illüzyonu yok.
 *
 * @param {Object} params
 * @param {number} params.odometerDelta - İki dolum arası gerçek km farkı
 * @param {number} params.gpsHaversineDistance - Aynı dönem PostGIS/Haversine GPS toplamı
 * @param {number} params.allowedDeviationThreshold - İzin verilen max sapma (Default 0.05 = %5)
 * @returns {{ reconciledDistanceKm:number, isGpsReliable:boolean, deviationRate:number, triggerAlert:boolean }}
 */
function reconcileGpsMeters({
  odometerDelta,
  gpsHaversineDistance,
  allowedDeviationThreshold = 0.05,
}) {
  const odo = Math.max(0, parseFloat(odometerDelta) || 0);
  const gps = Math.max(0, parseFloat(gpsHaversineDistance) || 0);

  // Odometer 0 ise (araç hareketsiz) sıfıra bölme koruması
  if (odo === 0) {
    return {
      reconciledDistanceKm: gps,
      isGpsReliable: gps === 0,
      deviationRate: gps === 0 ? 0 : 1,
      triggerAlert: gps > 0,
    };
  }

  const deviationRate = Math.abs(odo - gps) / odo;
  const isGpsReliable = deviationRate <= allowedDeviationThreshold;

  return {
    reconciledDistanceKm: isGpsReliable
      ? parseFloat(gps.toFixed(2))
      : parseFloat(odo.toFixed(2)),
    isGpsReliable,
    deviationRate: parseFloat(deviationRate.toFixed(4)),
    triggerAlert: !isGpsReliable,
  };
}

module.exports = { reconcileGpsMeters };
