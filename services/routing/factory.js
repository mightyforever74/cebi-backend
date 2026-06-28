/**
 * factory.js — ADR-0014 §4 routing provider factory (tulipfleet-backend).
 *
 * createProvider() reads ROUTING_PROVIDER (default "here") and returns the
 * matching provider. Unknown value -> THROW (ADR-0014 §4), not silent fallback:
 * a typo'd env should fail loudly at startup, not silently route through HERE
 * and hide the misconfiguration.
 */

const HereRoutingProvider = require("./HereRoutingProvider");

/**
 * @returns {import("./contract").IRoutingProvider}
 */
function createProvider() {
  const providerType = (process.env.ROUTING_PROVIDER || "here").toLowerCase();

  switch (providerType) {
    case "here":
      return new HereRoutingProvider();
    default:
      throw new Error(
        "Unknown ROUTING_PROVIDER: '" + providerType + "' (expected 'here')"
      );
  }
}

module.exports = { createProvider };
