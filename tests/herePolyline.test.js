"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encode, decodeLatLng } = require("../utils/herePolyline");

// Sample from the HERE flexible-polyline README.
const SAMPLE = "BFoz5xJ67i1B1B7PzIhaxL7Y";
const EXPECTED = [
  [50.1022829, 8.6982122],
  [50.1020076, 8.6956695],
  [50.1006313, 8.691496],
  [50.09878, 8.6875156],
];

test("decodes the HERE flexible polyline sample to lat,lng pairs", () => {
  assert.equal(encode({ polyline: EXPECTED }), SAMPLE);
  const pairs = decodeLatLng(SAMPLE);
  assert.equal(pairs.length, 4);
  pairs.forEach((pair, index) => {
    assert.equal(pair.length, 2);
    assert.ok(Math.abs(pair[0] - EXPECTED[index][0]) < 1e-5);
    assert.ok(Math.abs(pair[1] - EXPECTED[index][1]) < 1e-5);
  });
});
