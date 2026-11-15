import { describe, expect, it } from "vitest";
import { label } from "../src/pipeline/answer.js";

// The answer a player reads when no language model writes it is assembled from the engineering models'
// field names. Those names must come out as words a person would write.
describe("field names shown to the player", () => {
  it("splits words where letters meet digits and writes units the usual way", () => {
    expect(label("maxDataRateBpsAt3DbMargin").text).toBe("Max data rate bit/s at 3 dB margin");
    expect(label("ebN0").text).toBe("Eb/N0");
  });
  it("keeps ordinary names unchanged apart from spacing", () => {
    expect(label("closes").text).toBe("Closes");
    expect(label("harnessMass").text).toBe("Harness mass");
  });
});
