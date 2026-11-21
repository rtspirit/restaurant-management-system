// The run-book's demo numbers, checked against the seed's raw records (helpers/expected.ts).
// No browser and no server: if this fails, the run-book or the seed is wrong, and every beat that
// shows a number would be checked against the wrong figure.
import { LAST_WEEK, dollars, weekFigures } from "../helpers/expected.js";
import { expect, test } from "../fixtures.js";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Pure arithmetic: once is enough."));

test("Marigold Kitchen, week of 9 November: $84,310.00 net, food and drink $25,460.00, staff $26,220.00, prime cost 61.3%", () => {
  const w = weekFigures("marigold", LAST_WEEK);
  expect(dollars(w.netSalesMinor)).toBe("$84,310.00");
  expect(dollars(w.foodAndDrinkMinor)).toBe("$25,460.00");
  expect(dollars(w.staffMinor)).toBe("$26,220.00");
  expect(w.primeCost).toBe("61.3%");
  // Run-book 4.1 step 1: Mon to Sun, Saturday the biggest.
  expect(w.daily.map(dollars)).toEqual(["$8,140.00", "$8,960.00", "$9,870.00", "$11,420.00", "$15,830.00", "$17,950.00", "$12,140.00"]);
});

test("Marigold Kitchen, the slow week of 19 October: $61,480.00 net, prime cost 64.1%", () => {
  const w = weekFigures("marigold", "2026-10-19");
  expect(dollars(w.netSalesMinor)).toBe("$61,480.00");
  expect(w.primeCost).toBe("64.1%");
});

test("Slice Yard, week of 9 November: $28,750.00 net, food and drink $8,150.00, staff $7,743.00, prime cost 55.3%", () => {
  const w = weekFigures("slice_yard", LAST_WEEK);
  expect(dollars(w.netSalesMinor)).toBe("$28,750.00");
  expect(dollars(w.foodAndDrinkMinor)).toBe("$8,150.00");
  expect(dollars(w.staffMinor)).toBe("$7,743.00");
  expect(w.primeCost).toBe("55.3%");
});
