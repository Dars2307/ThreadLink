"use client";

import { useEffect, useState } from "react";

import { BACKDROP_ID } from "@/lib/dashboard/appearance-client";
import type { Backdrop as BackdropKind } from "@/lib/dashboard/appearance";

/**
 * The app backdrop (0.11 design canvas): aurora, dusk, grid or plain, behind
 * the whole signed-in app. Decorative only (aria-hidden, no pointer events).
 * Motion is CSS-only on compositor layers (app/globals.css "App backdrop");
 * this component only pauses it while the tab is hidden.
 */
export function Backdrop({ kind, animate }: { kind: BackdropKind; animate: boolean }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return (
    <div
      id={BACKDROP_ID}
      aria-hidden="true"
      className="tl-backdrop"
      data-backdrop={kind}
      data-animate={animate ? "on" : "off"}
      data-paused={hidden ? "true" : "false"}
    >
      <div className="tl-bd tl-bd-a" />
      <div className="tl-bd tl-bd-b" />
      <div className="tl-bd tl-bd-c" />
      <div className="tl-bd tl-bd-dots" />
      <div className="tl-bd tl-bd-spot" />
    </div>
  );
}
