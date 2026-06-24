const {
  calculateVirtualFuelLevel,
} = require("../03-logic/calculateVirtualFuelLevel");

describe("FEAT-007-EXT — Sanal Şamandıra Motoru Sınır Testleri", () => {
  test("Başlangıç Durumu: tır hiç yol yapmamışken depo full olmalı", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 400,
      kmSinceLastFill: 0,
      avgConsumption: 30,
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(400);
    expect(result.percentage).toBe(100);
  });

  test("Standart Sürüş: 100 km sonrası tüketim formüle tam uymalı", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 400,
      kmSinceLastFill: 100,
      avgConsumption: 32, // 100 km'de 32 L
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(368); // 400 - 32
    expect(result.percentage).toBe(92); // 368/400*100
  });

  test("Kritik Sınır: yakıt bitince negatif sızmamalı, 0L / %0", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 100,
      kmSinceLastFill: 1000, // depoyu kurutacak mesafe
      avgConsumption: 30,
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(0);
    expect(result.percentage).toBe(0);
  });

  test("Zırh: bozuk/geçersiz parametre çökmeden fallback üretmeli", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: null,
      kmSinceLastFill: undefined,
      avgConsumption: "30",
      fuelCapacity: 0, // division by zero tetikleyici
    });
    expect(result.currentFuelLiters).toBe(0);
    expect(result.percentage).toBe(0);
  });

  // ── Eklenen testler (kapsam tamamlama) ──

  test("Üst Sınır Clamp: başlangıç yakıtı kapasiteyi aşamaz", () => {
    // litersAtLastFill kapasiteden büyük gelirse capacity'ye clamp olmalı
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 500, // capacity 400'ün üstü
      kmSinceLastFill: 0,
      avgConsumption: 30,
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(400); // 500 değil, 400'e clamp
    expect(result.percentage).toBe(100);
  });

  test("String girdi toleransı: sayısal string'ler parse edilmeli", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: "350",
      kmSinceLastFill: "200",
      avgConsumption: "25", // 200 km * 25/100 = 50 L
      fuelCapacity: "350",
    });
    expect(result.currentFuelLiters).toBe(300); // 350 - 50
    expect(result.percentage).toBe(86); // round(300/350*100)=86
  });

  test("Yarı dolu depo: is_full_tank=false senaryosu (L_start < capacity)", () => {
    // Çağıran katman L_start'ı kısmi verirse, fonksiyon yine doğru düşmeli
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 200, // depo yarı dolu başladı
      kmSinceLastFill: 300,
      avgConsumption: 30, // 300*30/100 = 90 L
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(110); // 200 - 90
    expect(result.percentage).toBe(28); // round(110/400*100)=27.5→28
  });

  test("Gerçekçi Dobbe aggressive: 400L depo, 350km, 29 L/100km", () => {
    const result = calculateVirtualFuelLevel({
      litersAtLastFill: 400,
      kmSinceLastFill: 350,
      avgConsumption: 29, // 350*29/100 = 101.5 L
      fuelCapacity: 400,
    });
    expect(result.currentFuelLiters).toBe(298.5); // 400 - 101.5
    expect(result.percentage).toBe(75); // round(298.5/400*100)=74.6→75
  });
});
