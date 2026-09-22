import { describe, expect, it } from "vitest";

import { maskIdentifier } from "@/lib/security/mask";

describe("maskIdentifier", () => {
  it("keeps the type prefix and a short tail only", () => {
    expect(maskIdentifier("user_2abcDEFghij1234")).toBe("user_…1234");
  });

  it("hides short identifiers entirely", () => {
    expect(maskIdentifier("user_abc")).toBe("user_…");
  });

  it("never returns the full identifier", () => {
    const id = "user_2NNEqL2nrIRdJ194ndJqAHwEfxC";
    expect(maskIdentifier(id)).not.toBe(id);
    expect(maskIdentifier(id).length).toBeLessThan(id.length);
  });
});
