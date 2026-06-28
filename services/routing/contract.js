/**
 * contract.js — IRoutingProvider cross-repo contract (JSDoc typedefs).
 *
 * ADR-0014 §3 contract, expressed as plain-JS JSDoc (this backend is JS, not TS).
 * Type-only module: defines shapes, exports nothing at runtime.
 *
 * Shapes here mirror the LIVE server.js behaviour (route-traffic / drive-conditions)
 * so a provider migration does not change the mobile response shape.
 */

/**
 * @typedef {Object} LatLon
 * @property {number} lat - Enlem
 * @property {number} lon - Boylam
 */

/**
 * @typedef {Object} RouteRequest
 * @property {LatLon} origin
 * @property {LatLon} destination
 * @property {("truck"|"car")} [transportMode] - Varsayilan: "truck" (filo araci)
 */

/**
 * @typedef {Object} IncidentItem
 * @property {(string|null)} text - HERE incident description.value (yoksa null)
 * @property {string} type - Normalize edilmis tip ([^a-z_] -> "_")
 */

/**
 * RouteResult — provider'in dondurdugu SAF veri (ADR-0014 §3).
 * Sunum/paketleme burada YOK; o buildTrafficPayload'da yapilir (Yol 2).
 * @typedef {Object} RouteResult
 * @property {number} durationSec - Trafikli toplam sure (saniye)
 * @property {number} baseDurationSec - Trafiksiz ham sure (saniye)
 * @property {number} delayMin - max(0, round((dur-base)/60))
 * @property {IncidentItem[]} incidents - Ilk 2 olay
 * @property {Object} [raw] - Ureticiden gelen ham govde (audit)
 */

/**
 * ProviderCapabilities — ADR-0014 §3/§4: TAM matris, her alan acikca true/false.
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} computeRoute
 * @property {boolean} computeMatrix
 * @property {boolean} traffic
 * @property {boolean} solveVrp
 * @property {boolean} tollCost
 * @property {boolean} ecoRouting
 * @property {boolean} evConsumption
 */

/**
 * TrafficPayload — mobil "traffic" zarfi. server.js'teki shape ile BIREBIR.
 * DIKKAT: status_icon = "OK"|"WARN"|"CRIT", status_code = "clear"|"moderate"|"heavy".
 * (Bu sira canli kodda boyledir; ters cevirmek mobil app'i kirar.)
 * @typedef {Object} TrafficPayload
 * @property {("OK"|"WARN"|"CRIT")} status_icon
 * @property {("clear"|"moderate"|"heavy")} status_code
 * @property {number} delay_min
 * @property {number} duration_min
 * @property {string} route_label
 * @property {IncidentItem[]} incidents
 */

/**
 * IRoutingProvider — ADR-0014 §3 kontrati (JSDoc bicimi).
 * Optional metotlar capabilities matrisine gore implemente edilir.
 * @typedef {Object} IRoutingProvider
 * @property {ProviderCapabilities} capabilities
 * @property {(req: RouteRequest) => Promise<RouteResult>} [computeRoute]
 */

module.exports = {};
