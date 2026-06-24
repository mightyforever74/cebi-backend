const { reconcileGpsMeters } = require("../03-logic/reconcileGpsMeters");

describe("FEAT-007-EXT — Sütun 2: GPS ve Sayaç Mutabakatı Sınır Testleri", () => {
  test("Mükemmel Senaryo: sapma %5 altıysa GPS geçerli", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 100,
      gpsHaversineDistance: 98.5, // %1.5 sapma
      allowedDeviationThreshold: 0.05,
    });
    expect(result.isGpsReliable).toBe(true);
    expect(result.reconciledDistanceKm).toBe(98.5);
    expect(result.triggerAlert).toBe(false);
  });

  test("Yer-Gerçeği: 20.48 drift (sapma %95+) alarma geçirmeli", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 626.0,
      gpsHaversineDistance: 30.57,
      allowedDeviationThreshold: 0.05,
    });
    expect(result.isGpsReliable).toBe(false);
    expect(result.reconciledDistanceKm).toBe(626.0);
    expect(result.triggerAlert).toBe(true);
    expect(result.deviationRate).toBe(0.9512);
  });

  test("Sıfır Hareketsizlik: odo 0 iken sahte GPS zıplaması", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 0,
      gpsHaversineDistance: 12.4,
      allowedDeviationThreshold: 0.05,
    });
    expect(result.isGpsReliable).toBe(false);
    expect(result.triggerAlert).toBe(true);
  });

  // ── Ek kapsam testleri ──

  test("Tam hareketsiz: odo 0 ve gps 0 ise temiz, uyarı yok", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 0,
      gpsHaversineDistance: 0,
    });
    expect(result.isGpsReliable).toBe(true);
    expect(result.triggerAlert).toBe(false);
    expect(result.deviationRate).toBe(0);
  });

  test("Tam sınır: sapma tam %5 ise güvenilir (<=)", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 100,
      gpsHaversineDistance: 95, // tam %5
      allowedDeviationThreshold: 0.05,
    });
    expect(result.isGpsReliable).toBe(true);
    expect(result.triggerAlert).toBe(false);
  });

  test("Sınır üstü: sapma %5.1 ise güvenilmez", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 100,
      gpsHaversineDistance: 94.9, // %5.1
      allowedDeviationThreshold: 0.05,
    });
    expect(result.isGpsReliable).toBe(false);
    expect(result.reconciledDistanceKm).toBe(100); // odometer baz
    expect(result.triggerAlert).toBe(true);
  });

  test("Bozuk girdi: null/undefined fallback", () => {
    const result = reconcileGpsMeters({
      odometerDelta: null,
      gpsHaversineDistance: undefined,
    });
    expect(result.isGpsReliable).toBe(true); // odo 0, gps 0
    expect(result.triggerAlert).toBe(false);
  });

  test("GPS odometer'dan fazla (üstte sapma): yine güvenilmez", () => {
    const result = reconcileGpsMeters({
      odometerDelta: 100,
      gpsHaversineDistance: 130, // %30 fazla
    });
    expect(result.isGpsReliable).toBe(false);
    expect(result.deviationRate).toBe(0.3);
    expect(result.reconciledDistanceKm).toBe(100);
  });
});
