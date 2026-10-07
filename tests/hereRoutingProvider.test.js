"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const HereRoutingProvider = require("../services/routing/HereRoutingProvider");

const SAMPLE = "BFoz5xJ67i1B1B7PzIhaxL7Y";

function withFetch(body, fn) {
  const prevKey = process.env.HERE_API_KEY;
  const original = global.fetch;
  process.env.HERE_API_KEY = "test-key";
  let seen = "";
  global.fetch = async (url) => {
    seen = String(url);
    return { json: async () => body };
  };
  return Promise.resolve()
    .then(() => fn(seenHolder(seen)))
    .finally(() => {
      global.fetch = original;
      if (prevKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = prevKey;
    });

  function seenHolder() {
    return {
      get url() {
        return seen;
      },
    };
  }
}

test("computeRoute adds geometry and keeps the traffic fields", async () => {
  const provider = new HereRoutingProvider();
  let traffic;
  await withFetch(
    {
      routes: [
        {
          sections: [
            {
              summary: { duration: 120, baseDuration: 100, length: 1500 },
              polyline: SAMPLE,
              incidents: [
                { description: { value: "roadwork" }, type: "construction" },
              ],
            },
          ],
        },
      ],
    },
    async (seen) => {
      const result = await provider.computeRoute({
        origin: { lat: 1, lon: 2 },
        destination: { lat: 3, lon: 4 },
      });
      assert.match(seen.url, /return=summary,polyline,incidents/);
      assert.equal(result.durationSec, 120);
      assert.equal(result.baseDurationSec, 100);
      assert.equal(result.delayMin, 0);
      assert.equal(result.distanceM, 1500);
      assert.equal(result.geometry.length, 4);
      assert.ok(Math.abs(result.geometry[0][0] - 50.10228) < 1e-4);
      assert.ok(Math.abs(result.geometry[0][1] - 8.69821) < 1e-4);
      traffic = provider.buildTrafficPayload(result, "label");
    }
  );
  assert.equal(traffic.status_icon, "OK");
  assert.equal(traffic.status_code, "clear");
  assert.equal(traffic.delay_min, 0);
  assert.equal(traffic.duration_min, 2);
  assert.equal(traffic.incidents[0].text, "roadwork");
  assert.equal(traffic.geometry, undefined);
});

test("a bad polyline omits geometry and still returns the summary", async () => {
  const provider = new HereRoutingProvider();
  await withFetch(
    {
      routes: [
        {
          sections: [
            {
              summary: { duration: 90, baseDuration: 90, length: 400 },
              polyline: "!!!",
              incidents: [],
            },
          ],
        },
      ],
    },
    async () => {
      const result = await provider.computeRoute({
        origin: { lat: 1, lon: 2 },
        destination: { lat: 3, lon: 4 },
      });
      assert.equal(result.durationSec, 90);
      assert.equal(result.geometry, undefined);
      assert.equal(result.distanceM, 400);
    }
  );
});
