/**
 * FEAT-007-EXT-virtual-telematics / 03-logic/driverTelemetryRegressor.js
 * Davranış-Yakıt Regresyon ve Rölanti Maliyet Analiz Motoru
 *
 * KARAR (bu oturumda mühürlendi):
 *  - Korelasyon tek sürücünün günleri içinde değil, SÜRÜCÜLER ARASI (havuz) anlamlı.
 *    Tek sürücüde Aggressive_Index varyansı düşük → R² yanıltıcı. 543 nokta havuzu
 *    (3 sürücü × 181 gün), x ekseni stillerle yayılmış, gerçek korelasyon ölçer.
 *  - Düşük varyans guard'ı: tüm x aynıysa slopeDenominator=0 → slope/R² = 0
 *    (sahte korelasyon üretmez; "Düşük Varyans Denetimi" testiyle kanıtlı).
 *  - Rölanti: GPS'te durağan nokta YOK (seed speed 55-90), bu yüzden idle_time
 *    driver_behavior.idle_time_minutes'tan gelir (seed'de dolu, ayrışmış).
 *
 * @param {Array} dataPoints - [{ harshBrakes, harshAccels, dailyKm, consumptionPer100km, idleMinutes }]
 * @param {number} fuelCostPerLiter - Euro mazot fiyatı (Default 1.75)
 * @returns {{ rSquared:number, slope:number, intercept:number, totalIdlingCostEuro:number, insight:string }}
 */
function analyzeDriverBehaviorCorrelation(dataPoints, fuelCostPerLiter = 1.75) {
  if (!dataPoints || dataPoints.length < 3) {
    return {
      rSquared: 0,
      slope: 0,
      intercept: 0,
      totalIdlingCostEuro: 0,
      insight: "Yetersiz veri noktası.",
    };
  }

  let totalIdlingMinutes = 0;
  const regressionPairs = [];

  // 1. Veri temizliği + Aggressive_Index hesabı
  for (const pt of dataPoints) {
    const dailyKm = parseFloat(pt.dailyKm) || 0;
    const consumption = parseFloat(pt.consumptionPer100km) || 0;
    totalIdlingMinutes += parseFloat(pt.idleMinutes) || 0;
    if (dailyKm > 10 && consumption > 0) {
      // Aggressive_Index = (Brakes + Accels) / KM * 100
      const aggressiveIndex =
        (((parseInt(pt.harshBrakes) || 0) + (parseInt(pt.harshAccels) || 0)) /
          dailyKm) *
        100;
      regressionPairs.push({ x: aggressiveIndex, y: consumption });
    }
  }

  const n = regressionPairs.length;
  if (n < 3) {
    return {
      rSquared: 0,
      slope: 0,
      intercept: 0,
      totalIdlingCostEuro: 0,
      insight: "Korelasyon için geçerli sürüş verisi az.",
    };
  }

  // 2. Standart Lineer Regresyon (OLS)
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0,
    sumYY = 0;
  for (const pair of regressionPairs) {
    sumX += pair.x;
    sumY += pair.y;
    sumXY += pair.x * pair.y;
    sumXX += pair.x * pair.x;
    sumYY += pair.y * pair.y;
  }

  const slopeNumerator = n * sumXY - sumX * sumY;
  const slopeDenominator = n * sumXX - sumX * sumX;
  // Sıfıra bölme guard: tüm x aynıysa (varyans 0) slope 0
  const slope = slopeDenominator === 0 ? 0 : slopeNumerator / slopeDenominator;
  const intercept = (sumY - slope * sumX) / n;

  // R² (belirlilik katsayısı)
  const rNumerator = n * sumXY - sumX * sumY;
  const rDenominator = Math.sqrt(
    (n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY)
  );
  const r = rDenominator === 0 ? 0 : rNumerator / rDenominator;
  const rSquared = Math.pow(r, 2);

  // 3. Rölanti ROI (ağır vasıta rölantide ~2 L/saat)
  const totalIdlingCostEuro =
    (totalIdlingMinutes / 60) * 2.0 * fuelCostPerLiter;

  // 4. Patron içgörüsü
  let insight =
    "Sürücü davranışı ile yakıt tüketimi arasında belirgin bir korelasyon saptanmadı.";
  if (rSquared > 0.6 && slope > 0) {
    insight = `Güçlü Korelasyon (R²: ${(rSquared * 100).toFixed(
      0
    )}%). Agresif sürüş endeksindeki her 1 puanlık artış, yakıt tüketimini doğrudan ${slope.toFixed(
      2
    )} L/100km artırıyor.`;
  }

  return {
    rSquared: parseFloat(rSquared.toFixed(4)),
    slope: parseFloat(slope.toFixed(4)),
    intercept: parseFloat(intercept.toFixed(4)),
    totalIdlingCostEuro: parseFloat(totalIdlingCostEuro.toFixed(2)),
    insight,
  };
}

module.exports = { analyzeDriverBehaviorCorrelation };
