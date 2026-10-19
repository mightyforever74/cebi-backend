/**
 * OsrmRoutingProvider.js — ADR-0014 IRoutingProvider kontratina uyan,
 * self-hosted OSRM (Open Source Routing Machine) tabanli sağlayici.
 *
 * Faz 1 raporu §9.7: OSRM/CARTO kullanilacak, karari verildi ama hicbir
 * repoda (core, cebi-backend, cebi-dispatcher) calisan bir OSRM routing
 * entegrasyonu YOKTU (grep ile dogrulandi, 19 Ekim 2026 oturumu); sadece
 * cebi-dispatcher/scripts/gen-routes.js + sim-portxl.js, demo veri
 * uretmek icin PUBLIC OSRM demo server'ini (router.project-osrm.org) bir
 * kerelik script olarak cagiriyor. Bu dosya, SIFIRDAN yazilan gercek bir
 * runtime provider (port degil, cunku port edilecek kod yok).
 *
 * ONEMLI KAPASITE FARKLARI (HereRoutingProvider ile karsilastirmali,
 * dogru kapasite matrisi icin onemli, bkz. asagidaki capabilities):
 *   - traffic: false. OSRM statik yol agi uzerinden calisir, canli trafik
 *     verisi YOK. durationSec === baseDurationSec her zaman (delayMin
 *     daima 0), incidents daima bos dizi. Bu, "veri yok" durumunun
 *     DUREST temsili — sahte bir trafik degeri uydurulmadi.
 *   - Kamyon/agir vasita kisitlamalari (yukseklik, agirlik, ADR/hazmat
 *     tunel kategorisi) YALNIZCA self-hosted OSRM, OZEL bir kamyon
 *     profiliyle (orn. `truck.lua`) on-islemden (extract/contract/
 *     customize) gecirilmisse desteklenir. Standart "car"/"driving"
 *     profili bunlari UYGULAMAZ. `OSRM_PROFILE` env degiskeniyle hangi
 *     profilin kullanilacagi acikca secilir (varsayilan yok, bilincli:
 *     yanlis profille sessizce kamyon-guvenli-olmayan bir rota donmemeli).
 *   - computeMatrix burada ILK KEZ implemente edildi (HereRoutingProvider
 *     henuz yapmiyor, kendi basligindaki "Phase 2" notuna bakin). Su an
 *     HICBIR caller yok (altyapi, Cem'in acik talebiyle hazirlandi) — VRP
 *     tarafinda coklu arac/gorev mesafe matrisi gerektiginde kullanilabilir.
 *
 * `OSRM_BASE_URL` ZORUNLU (HERE_API_KEY ile ayni "sessiz yanlis davranis
 * yerine loud throw" deseni) — public demo server'in production icin
 * kullanim sartlari (rate limit, SLA yok, ticari kullanim yasagi) uygun
 * degil; varsayilan olarak ona DUSMEZ. Self-hosted kurulum icin bkz.
 * docker-compose.osrm.yml (bu commit'te, root dizin).
 */

require("./contract"); // JSDoc typedefs only (no runtime export)

const OSRM_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS) > 0
  ? Number(process.env.OSRM_TIMEOUT_MS)
  : 8000;

class OsrmRoutingProvider {
  constructor() {
    /** @type {import("./contract").ProviderCapabilities} */
    this.capabilities = {
      computeRoute: true,
      computeMatrix: true,
      traffic: false, // bkz. dosya basligi: OSRM statik, canli trafik verisi yok
      solveVrp: false,
      tollCost: false,
      ecoRouting: false,
      evConsumption: false,
    };
  }

  _baseUrl() {
    const base = process.env.OSRM_BASE_URL;
    if (!base) {
      const e = new Error("OSRM_BASE_URL not configured");
      e.code = "NOT_CONFIGURED";
      throw e;
    }
    return base.replace(/\/+$/, "");
  }

  _profile() {
    // Bilincli varsayilansiz: yanlis profille sessizce kamyon-guvenli-
    // olmayan bir rota donulmemeli (bkz. dosya basligi).
    const profile = process.env.OSRM_PROFILE;
    if (!profile) {
      const e = new Error("OSRM_PROFILE not configured");
      e.code = "NOT_CONFIGURED";
      throw e;
    }
    return profile;
  }

  /**
   * OSRM Route service — tekil rota (trafik verisi YOK, bkz. dosya basligi).
   * @param {import("./contract").RouteRequest} req
   * @returns {Promise<import("./contract").RouteResult>}
   */
  async computeRoute(req) {
    const base = this._baseUrl();
    const profile = this._profile();

    const coords =
      req.origin.lon + "," + req.origin.lat + ";" +
      req.destination.lon + "," + req.destination.lat;
    const url =
      base + "/route/v1/" + profile + "/" + coords +
      "?overview=full&geometries=geojson&steps=false&alternatives=false";

    const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    const data = await res.json();

    if (data?.code !== "Ok" || !data?.routes?.[0]) {
      const e = new Error(
        "OSRM route error: " + (data?.code || "UNKNOWN") + (data?.message ? " (" + data.message + ")" : "")
      );
      e.code = "API_ERROR";
      throw e;
    }

    const route = data.routes[0];
    const durationSec = route.duration || 0;

    // geometries=geojson -> [[lon,lat], ...]; kontrat [lat,lon] cift bekliyor
    // (HereRoutingProvider'in decodeLatLng ciktisiyla ayni sira, Yol 2'nin
    // haritalama katmanini degistirmeden tuketebilmesi icin).
    let geometry;
    const coordsGeo = route.geometry?.coordinates;
    if (Array.isArray(coordsGeo) && coordsGeo.length >= 2) {
      geometry = coordsGeo.map(([lon, lat]) => [lat, lon]);
    }

    const result = {
      durationSec,
      baseDurationSec: durationSec, // canli trafik yok, bkz. dosya basligi
      delayMin: 0,
      incidents: [], // OSRM'de olay verisi yok
      raw: data,
    };
    if (geometry) result.geometry = geometry;
    if (Number.isFinite(route.distance)) result.distanceM = route.distance;
    return result;
  }

  /**
   * OSRM Table service — N x M mesafe/sure matrisi. Su an hicbir caller
   * yok (altyapi, bkz. dosya basligi); VRP coklu arac/gorev senaryosu
   * icin hazir.
   * @param {{lat:number, lon:number}[]} points - sources ve destinations olarak ayni kume kullanilir (tam N x N matris)
   * @returns {Promise<{durationsSec: number[][], distancesM: number[][]}>}
   */
  async computeMatrix(points) {
    if (!Array.isArray(points) || points.length < 2) {
      const e = new Error("computeMatrix requires at least 2 points");
      e.code = "INVALID_INPUT";
      throw e;
    }

    const base = this._baseUrl();
    const profile = this._profile();

    const coords = points.map((p) => p.lon + "," + p.lat).join(";");
    const url =
      base + "/table/v1/" + profile + "/" + coords +
      "?annotations=duration,distance";

    const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    const data = await res.json();

    if (data?.code !== "Ok" || !data?.durations) {
      const e = new Error(
        "OSRM table error: " + (data?.code || "UNKNOWN") + (data?.message ? " (" + data.message + ")" : "")
      );
      e.code = "API_ERROR";
      throw e;
    }

    return {
      durationsSec: data.durations,
      distancesM: data.distances || [],
    };
  }

  /**
   * Sunum paketlemesi (Yol 2), HereRoutingProvider.buildTrafficPayload ile
   * AYNI SEKIL (server.js'in bu metoda yaptigi cagri provider-agnostik
   * olsun diye). delayMin daima 0 oldugundan sonuc daima "OK"/"clear" —
   * bu DOGRU bir temsil (trafik verisi yok, kotu degil), gizli bir
   * eksiklik olarak degil acikca boyle belgelenmeli (cagiran taraf/UI
   * "trafik: bilinmiyor" ile "trafik: temiz"i ayirt etmek isterse
   * capabilities.traffic===false kontrolu kullanmali).
   * @param {import("./contract").RouteResult} routeResult
   * @param {string} routeLabel
   * @returns {import("./contract").TrafficPayload}
   */
  buildTrafficPayload(routeResult, routeLabel) {
    return {
      status_icon: "OK",
      status_code: "clear",
      delay_min: 0,
      duration_min: Math.round(routeResult.durationSec / 60),
      route_label: routeLabel,
      incidents: [],
    };
  }
}

module.exports = OsrmRoutingProvider;
