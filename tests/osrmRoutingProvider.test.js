"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const OsrmRoutingProvider = require("../services/routing/OsrmRoutingProvider");

function withFetch(body, fn) {
  const prevBase = process.env.OSRM_BASE_URL;
  const prevProfile = process.env.OSRM_PROFILE;
  const original = global.fetch;
  process.env.OSRM_BASE_URL = "http://localhost:5000";
  process.env.OSRM_PROFILE = "driving";
  let seen = "";
  global.fetch = async (url) => {
    seen = String(url);
    return { json: async () => body };
  };
  return Promise.resolve()
    .then(() => fn(seenHolder()))
    .finally(() => {
      global.fetch = original;
      if (prevBase === undefined) delete process.env.OSRM_BASE_URL;
      else process.env.OSRM_BASE_URL = prevBase;
      if (prevProfile === undefined) delete process.env.OSRM_PROFILE;
      else process.env.OSRM_PROFILE = prevProfile;
    });

  function seenHolder() {
    return {
      get url() {
        return seen;
      },
    };
  }
}

test("computeRoute converts geojson geometry and reports no traffic", async () => {
  const provider = new OsrmRoutingProvider();
  let traffic;
  await withFetch(
    {
      code: "Ok",
      routes: [
        {
          duration: 300,
          distance: 5000,
          geometry: {
            type: "LineString",
            coordinates: [
              [29.01, 41.02],
              [29.03, 41.04],
            ],
          },
        },
      ],
      waypoints: [],
    },
    async (seen) => {
      const result = await provider.computeRoute({
        origin: { lat: 41.02, lon: 29.01 },
        destination: { lat: 41.04, lon: 29.03 },
      });
      assert.match(seen.url, /\/route\/v1\/driving\//);
      assert.match(seen.url, /geometries=geojson/);
      assert.equal(result.durationSec, 300);
      assert.equal(result.baseDurationSec, 300);
      assert.equal(result.delayMin, 0);
      assert.deepEqual(result.incidents, []);
      assert.equal(result.distanceM, 5000);
      assert.equal(result.geometry.length, 2);
      // geojson [lon,lat] -> contract [lat,lon]
      assert.equal(result.geometry[0][0], 41.02);
      assert.equal(result.geometry[0][1], 29.01);
      traffic = provider.buildTrafficPayload(result, "label");
    }
  );
  assert.equal(traffic.status_icon, "OK");
  assert.equal(traffic.status_code, "clear");
  assert.equal(traffic.delay_min, 0);
  assert.equal(traffic.duration_min, 5);
  assert.deepEqual(traffic.incidents, []);
});

test("an OSRM error code (NoRoute) throws instead of returning a fake result", async () => {
  const provider = new OsrmRoutingProvider();
  await withFetch({ code: "NoRoute", message: "no route found" }, async () => {
    await assert.rejects(
      () =>
        provider.computeRoute({
          origin: { lat: 1, lon: 2 },
          destination: { lat: 3, lon: 4 },
        }),
      /OSRM route error: NoRoute/
    );
  });
});

test("missing OSRM_BASE_URL throws NOT_CONFIGURED rather than silently defaulting", async () => {
  const prevBase = process.env.OSRM_BASE_URL;
  delete process.env.OSRM_BASE_URL;
  try {
    const provider = new OsrmRoutingProvider();
    await assert.rejects(
      () =>
        provider.computeRoute({
          origin: { lat: 1, lon: 2 },
          destination: { lat: 3, lon: 4 },
        }),
      (err) => err.code === "NOT_CONFIGURED"
    );
  } finally {
    if (prevBase === undefined) delete process.env.OSRM_BASE_URL;
    else process.env.OSRM_BASE_URL = prevBase;
  }
});

test("computeMatrix returns duration/distance matrices from the Table service", async () => {
  const provider = new OsrmRoutingProvider();
  await withFetch(
    {
      code: "Ok",
      durations: [
        [0, 120],
        [130, 0],
      ],
      distances: [
        [0, 2000],
        [2100, 0],
      ],
    },
    async (seen) => {
      const result = await provider.computeMatrix([
        { lat: 41.0, lon: 29.0 },
        { lat: 41.1, lon: 29.1 },
      ]);
      assert.match(seen.url, /\/table\/v1\/driving\//);
      assert.deepEqual(result.durationsSec, [
        [0, 120],
        [130, 0],
      ]);
      assert.deepEqual(result.distancesM, [
        [0, 2000],
        [2100, 0],
      ]);
    }
  );
});

test("computeMatrix rejects fewer than 2 points without calling the network", async () => {
  const provider = new OsrmRoutingProvider();
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("should not be called");
  };
  try {
    await assert.rejects(
      () => provider.computeMatrix([{ lat: 1, lon: 2 }]),
      (err) => err.code === "INVALID_INPUT"
    );
  } finally {
    global.fetch = original;
  }
});
