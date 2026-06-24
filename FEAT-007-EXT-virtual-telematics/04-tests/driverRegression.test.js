const {
  analyzeDriverBehaviorCorrelation,
} = require("../03-logic/driverTelemetryRegressor");

describe("FEAT-007-EXT — Sütun 3: Davranış Regresyonu ve Rölanti Sınır Testleri", () => {
  test("Agresif Sürücü Trendi (Ahmet): yüksek agresiflik yüksek tüketime yol açmalı, güçlü R²", () => {
    // Agresiflik endeksi arttıkça tüketim lineer artıyor (X↑ → Y↑)
    const ahmetData = [
      { harshBrakes: 8, harshAccels: 10, dailyKm: 200, consumptionPer100km: 36, idleMinutes: 30 }, // X=9,  Y=36
      { harshBrakes: 4, harshAccels: 4, dailyKm: 200, consumptionPer100km: 31, idleMinutes: 20 },  // X=4,  Y=31
      { harshBrakes: 12, harshAccels: 12, dailyKm: 200, consumptionPer100km: 39, idleMinutes: 45 },// X=12, Y=39
    ];
    const result = analyzeDriverBehaviorCorrelation(ahmetData, 1.75);

    expect(result.slope).toBeGreaterThan(0); // pozitif korelasyon
    expect(result.rSquared).toBeGreaterThan(0.8); // güçlü belirlilik
    expect(result.totalIdlingCostEuro).toBe(5.54); // (95/60)*2*1.75 = 5.5416
    expect(result.insight).toContain("Güçlü Korelasyon");
  });

  test("Sakin Sürücü Trendi (Mehmet): düşük rölanti çok düşük Euro kaybı üretmeli", () => {
    const mehmetData = [
      { harshBrakes: 0, harshAccels: 0, dailyKm: 200, consumptionPer100km: 25, idleMinutes: 5 },
      { harshBrakes: 0, harshAccels: 1, dailyKm: 200, consumptionPer100km: 25.5, idleMinutes: 4 },
      { harshBrakes: 1, harshAccels: 0, dailyKm: 200, consumptionPer100km: 25.8, idleMinutes: 5 },
    ];
    const result = analyzeDriverBehaviorCorrelation(mehmetData, 1.75);
    expect(result.totalIdlingCostEuro).toBe(0.82); // (14/60)*2*1.75 = 0.816
  });

  test("Zırh Denetimi: yetersiz/bozuk veride fallback", () => {
    const result = analyzeDriverBehaviorCorrelation([], 1.75);
    expect(result.rSquared).toBe(0);
    expect(result.insight).toBe("Yetersiz veri noktası.");
  });

  test("Düşük Varyans Denetimi (Mehmet sabit): hep aynı gidildiyse korelasyon sıfıra yakınsamalı", () => {
    // Tüm günler birebir aynı → x varyansı 0 → OLS eğim bulamaz
    const mehmetSakinData = [
      { harshBrakes: 0, harshAccels: 0, dailyKm: 200, consumptionPer100km: 25, idleMinutes: 5 },
      { harshBrakes: 0, harshAccels: 0, dailyKm: 200, consumptionPer100km: 25, idleMinutes: 5 },
      { harshBrakes: 0, harshAccels: 0, dailyKm: 200, consumptionPer100km: 25, idleMinutes: 5 },
    ];
    const result = analyzeDriverBehaviorCorrelation(mehmetSakinData, 1.75);
    // Varyans sıfır olduğu için OLS eğim bulamaz; slope ve R² 0 olmalı (sahte korelasyon üretmemeli)
    expect(result.slope).toBe(0);
    expect(result.rSquared).toBe(0);
  });
});
