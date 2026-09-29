import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Backdrop } from "@/components/dashboard/backdrop";
import {
  appearanceCookie,
  BACKDROP_COOKIE,
  BACKDROPS,
  MOTION_COOKIE,
  parseBackdrop,
  parseMotion,
} from "@/lib/dashboard/appearance";

const css = readFileSync("app/globals.css", "utf8");

/** The body of every @keyframes rule, by name. */
function keyframes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.set(m[1]!, source.slice(re.lastIndex, i - 1));
  }
  return out;
}

/** The value of a custom property inside a block that starts at `from`. */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`missing --${name}`);
  return m[1]!.trim();
}

type RGBA = [number, number, number, number];
function rgba(v: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/.exec(v);
  if (!m) throw new Error(`not a colour: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
const over = (top: RGBA, under: RGBA): RGBA => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1,
];
function luminance([r, g, b]: RGBA): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a: RGBA, b: RGBA) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const light = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = css.slice(css.indexOf(':root[data-theme="dark"] {'), css.indexOf("@theme inline"));

describe("appearance preferences", () => {
  it("parses and defaults", () => {
    expect(BACKDROPS).toEqual(["aurora", "dusk", "grid", "plain"]);
    expect(parseBackdrop("dusk")).toBe("dusk");
    expect(parseBackdrop("evil")).toBe("aurora");
    expect(parseBackdrop(undefined)).toBe("aurora");
    expect(parseMotion(undefined)).toBe(true);
    expect(parseMotion("off")).toBe(false);
    expect(appearanceCookie(BACKDROP_COOKIE, "grid")).toMatch(
      /^tl-backdrop=grid; path=\/; max-age=\d+; samesite=lax$/,
    );
    expect(MOTION_COOKIE).toBe("tl-motion");
  });

  it("renders a decorative, inert backdrop", () => {
    const html = renderToStaticMarkup(createElement(Backdrop, { kind: "aurora", animate: true }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-backdrop="aurora"');
    expect(html).toContain('data-animate="on"');
    expect(html).toContain('data-paused="false"');
    expect(html.match(/class="tl-bd /g)).toHaveLength(5);
    const off = renderToStaticMarkup(createElement(Backdrop, { kind: "plain", animate: false }));
    expect(off).toContain('data-animate="off"');
  });
});

describe("backdrop animation stays cheap (compositor-only)", () => {
  const frames = keyframes(css);

  it("every keyframe animates only transform and opacity", () => {
    expect(frames.size).toBeGreaterThanOrEqual(10);
    for (const [name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) {
        expect([name, p]).toEqual([name, expect.stringMatching(/^(transform|opacity)$/)]);
      }
    }
  });

  it("the layer is fixed, inert, contained and never filter-blurred", () => {
    const layer = /\.tl-backdrop \{([^}]*)\}/.exec(css)![1]!;
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(layer).toMatch(/contain:\s*strict/);
    expect(layer).toMatch(/z-index:\s*-1/);
    const backdropRules = css.slice(css.indexOf("App backdrop"));
    expect(backdropRules).not.toMatch(/(^|[^-])filter:\s*blur/);
    expect(backdropRules).toMatch(/will-change:\s*transform/);
  });

  it("pauses when hidden, and is static under reduced motion or when turned off", () => {
    expect(css).toMatch(/\[data-paused="true"\] \.tl-bd \{\s*animation-play-state: paused;/);
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.tl-backdrop \.tl-bd \{\s*animation: none !important;/);
    for (const cls of ["tl-ping", "tl-shimmer-win", "tl-shimmer-copy", "tl-grow", "tl-float"]) {
      expect(reduced).toContain(`.${cls}`);
    }
    // Animations are attached only when data-animate="on".
    const attached = [...css.matchAll(/\n([^\n{]*)\{\s*animation:\s*\n?\s*tl-(drift|dots|spot)/g)];
    expect(attached.length).toBeGreaterThan(0);
    for (const a of attached) expect(a[1]).toContain('[data-animate="on"]');
  });

  it("glass surfaces have a solid fallback without backdrop-filter", () => {
    for (const s of ["side", "head", "glass", "panel", "inset"]) {
      expect(css).toMatch(new RegExp(`\\.tl-${s} \\{\\s*background: var\\(--${s}-solid\\);`));
    }
    expect(css).toMatch(
      /@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter/,
    );
    expect(css).toContain("prefers-reduced-transparency: reduce");
  });
});

describe("contrast over the brightest part of each backdrop (WCAG AA 4.5:1)", () => {
  for (const [name, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`${name}: subtle and muted text stay readable`, () => {
      const base = rgba(token(block, "bd-base"));
      const brightest = ["bd-indigo", "bd-clay", "bd-teal", "bd-violet", "bd-pink"].map((t) =>
        over(rgba(token(block, t)), base),
      );
      const inset = rgba(token(block, "inset"));
      const side = rgba(token(block, "side"));
      for (const text of ["subtle", "muted", "foreground"]) {
        const fg = rgba(token(block, text));
        for (const bg of brightest) {
          // Sidebar text sits straight on the backdrop.
          expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
          // Everything else sits on a translucent surface over it.
          expect(contrast(fg, over(inset, bg))).toBeGreaterThanOrEqual(4.5);
          expect(contrast(fg, over(side, bg))).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
