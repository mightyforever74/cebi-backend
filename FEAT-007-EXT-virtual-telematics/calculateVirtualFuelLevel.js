/**
 * FEAT-007-EXT-virtual-telematics / 03-logic/calculateVirtualFuelLevel.js
 * Sanal Şamandıra Hesaplama Motoru (Seçenek A — Odometer Core, GPS Pulse)
 *
 * KARARLAR (bu oturumda kanıtlandı):
 *  - Seçenek A: mesafe gerçeği ODOMETER'dan (GPS jitter'lı, Adım 1 seed'de
 *    odometer kümülatif ama GPS koordinatları kopuk). R_f Sütun 2'ye devredildi.
 *  - current_fuel_level kolonu LİTRE tutar (yüzde değil); kanıt: fuel.js:42
 *    tankCapacity litre, server.js fuel_capacity 10-500 L kısıtı. Yüzde dashboard'da
 *    (current_fuel_level / fuel_capacity * 100) türetilir.
 *
 * litersAtLastFill HAKKINDA ÖNEMLİ NOT (çağıran katman dikkat etmeli):
 *  fuel_records.liters_filled = depoya EKLENEN litre, depodaki TOPLAM değil.
 *  Eğer son dolum is_full_tank=true ise → dolum sonrası depo = fuel_capacity,
 *  dolayısıyla L_start = fuelCapacity geçilmeli (liters_filled değil).
 *  is_full_tank=false ise depo kısmen dolu; L_start = önceki kalan + eklenen
 *  (çağıran katmanın hesaplaması). Seed Adım 1 hep is_full_tank=true üretti,
 *  yani pratikte L_start = fuelCapacity.
 *
 * @param {Object} params
 * @param {number} params.litersAtLastFill - Son dolum sonrası depodaki yakıt (Litre).
 *                                            is_full_tank=true ise = fuelCapacity.
 * @param {number} params.kmSinceLastFill  - O dolumdan bu yana mesafe (Odometer Deltası, km)
 * @param {number} params.avgConsumption   - Aracın tarihsel ortalama tüketimi (L/100km)
 * @param {number} params.fuelCapacity     - Aracın maksimum depo hacmi (Litre)
 * @returns {{ currentFuelLiters: number, percentage: number }}
 */
function calculateVirtualFuelLevel({
  litersAtLastFill,
  kmSinceLastFill,
  avgConsumption,
  fuelCapacity,
}) {
  // Safe Guard: geçersiz/sıfır girdi koruması (division by zero dahil)
  const capacity = parseFloat(fuelCapacity) || 60; // makul varsayılan kamyon-altı
  const lastFill = Math.max(0, parseFloat(litersAtLastFill) || 0);
  const distance = Math.max(0, parseFloat(kmSinceLastFill) || 0);
  const consumptionRate = Math.max(0, parseFloat(avgConsumption) || 0);

  // 1. Tahmini tüketilen yakıt (mesafe bazlı saf formül)
  const estimatedConsumedLiters = (distance * consumptionRate) / 100;

  // 2. Kalan yakıt litresi, [0, capacity] aralığına clamp
  //    (negatif sızma + kapasite üstü başlangıç koruması)
  let currentFuelLiters = lastFill - estimatedConsumedLiters;
  currentFuelLiters = Math.max(0, Math.min(capacity, currentFuelLiters));

  // 3. Yüzde gösterge [0, 100]
  const percentage = Math.round((currentFuelLiters / capacity) * 100);

  return {
    currentFuelLiters: parseFloat(currentFuelLiters.toFixed(2)),
    percentage: Math.max(0, Math.min(100, percentage)),
  };
}

module.exports = { calculateVirtualFuelLevel };
