import { permanentRedirect } from "next/navigation";

/** Moved in the Team Mode redesign; kept so bookmarks and desktop notifications still work. */
export default function MovedPage(): never {
  permanentRedirect("/dashboard/devices");
}
