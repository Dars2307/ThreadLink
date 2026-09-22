import { describe, expect, it } from "vitest";

import { clerkVariables, parseTheme, THEMES } from "@/lib/theme";

describe("appearance preference", () => {
  it("accepts only the three choices and defaults to system", () => {
    expect(THEMES).toEqual(["system", "light", "dark"]);
    for (const t of THEMES) expect(parseTheme(t)).toBe(t);
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme("hot-pink")).toBe("system");
    expect(parseTheme({ toString: () => "dark" })).toBe("system");
  });

  it("gives Clerk a matching palette in dark mode", () => {
    expect(clerkVariables("dark")).toMatchObject({
      colorBackground: "#141419",
      colorText: "#f2f2f5",
    });
    expect(clerkVariables("light").colorBackground).toBeUndefined();
    expect(clerkVariables("system")).toEqual(clerkVariables("light"));
  });
});
