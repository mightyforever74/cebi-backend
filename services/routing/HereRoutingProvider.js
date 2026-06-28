/**
 * HereRoutingProvider.js — ADR-0014 HereRoutingProvider (computeRoute + helper).
 *
 * Built to match the LIVE server.js HERE block byte-for-byte in behaviour:
 *   - transportMode=truck (filo araci), return=summary,incidents
 *   - section.summary.{duration,baseDuration}
 *   - delayMin = max(0, round((dur-base)/60))
 *   - incidents: first 2, { text: description.value|null, type: normalized }
 *   - global fetch (Node 18+); no axios/node-fetch dependency
 *
 * computeRoute returns pure RouteResult (ADR-0014 §3).
 * buildTrafficPayload does the presentation packaging (Yol 2), so the two
 * handlers stop duplicating the status-threshold logic (ADR-0014 §5).
 */

require("./contract"); // JSDoc typedefs only (no runtime export)

class HereRoutingProvider {
  constructor() {
    /** @type {import("./contract").ProviderCapabilities} */
    this.capabilities = {
      computeRoute: true,
      computeMatrix: true,
      traffic: true,
      solveVrp: false,
      tollCost: false,
      ecoRouting: false,
      evConsumption: false,
    };
  }

  /**
   * HERE Routing API v8 — tekil rota + trafik.
   * API key yoksa THROW eder; handler bunu yakalayip mevcut
   * { traffic: null, reason: "NOT_CONFIGURED" } davranisini korur.
   * HTTP/parse hatasinda da throw eder; handler "API_ERROR" doner.
   *
   * @param {import("./contract").RouteRequest} req
   * @returns {Promise<import("./contract").RouteResult>}
   */
  async computeRoute(req) {
    const HERE_KEY = process.env.HERE_API_KEY;
    if (!HERE_KEY) {
      const e = new Error("HERE_API_KEY not configured");
      e.code = "NOT_CONFIGURED";
      throw e;
    }

    const mode = req.transportMode || "truck";
    const url =
      "https://router.hereapi.com/v8/routes?transportMode=" +
      mode +
      "&origin=" +
      req.origin.lat +
      "," +
      req.origin.lon +
      "&destination=" +
      req.destination.lat +
      "," +
      req.destination.lon +
      "&return=summary,incidents" +
      "&apiKey=" +
      HERE_KEY;

    const res = await fetch(url);
    const data = await res.json();

    const section = data?.routes?.[0]?.sections?.[0];
    const summary = section?.summary;
    const baseDurationSec = summary?.baseDuration || 0;
    const durationSec = summary?.duration || 0;
    const delayMin = Math.max(0, Math.round((durationSec - baseDurationSec) / 60));

    const incidents = (section?.incidents || []).slice(0, 2).map((i) => ({
      text: i.description?.value || null,
      type: (i.type || "incident").toLowerCase().replace(/[^a-z_]/g, "_"),
    }));

    return {
      durationSec,
      baseDurationSec,
      delayMin,
      incidents,
      raw: data,
    };
  }

  /**
   * Sunum paketlemesi (Yol 2). server.js'teki "traffic" zarfini birebir uretir.
   * DIKKAT: status_icon = OK/WARN/CRIT, status_code = clear/moderate/heavy.
   * Esikler canli kodla ayni: 0 -> OK/clear, <10 -> WARN/moderate, >=10 -> CRIT/heavy.
   *
   * @param {import("./contract").RouteResult} routeResult
   * @param {string} routeLabel
   * @returns {import("./contract").TrafficPayload}
   */
  buildTrafficPayload(routeResult, routeLabel) {
    const delayMin = routeResult.delayMin;

    let statusIcon, statusCode;
    if (delayMin === 0) {
      statusIcon = "OK";
      statusCode = "clear";
    } else if (delayMin < 10) {
      statusIcon = "WARN";
      statusCode = "moderate";
    } else {
      statusIcon = "CRIT";
      statusCode = "heavy";
    }

    return {
      status_icon: statusIcon,
      status_code: statusCode,
      delay_min: delayMin,
      duration_min: Math.round(routeResult.durationSec / 60),
      route_label: routeLabel,
      incidents: routeResult.incidents,
    };
  }
}

module.exports = HereRoutingProvider;
