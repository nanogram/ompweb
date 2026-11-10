import { parseArgs } from "node:util";
import { addHostLink, isLoopbackHost, readHostLinks, readHostLogin, removeSecondaryHostLink } from "../lib/hosts/host-login";
import { hostForToken, LOCAL_HOST_ID } from "../lib/hosts/registry";

/** Customization never creates a daemon or rotates the existing local token. */
export function uiPreviewOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.port === "0"
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("UI customization requires a plain HTTP loopback origin");
  }
  return url.origin;
}

function readValidPrimary() {
  const links = readHostLinks();
  const primary = readHostLogin();
  if (!primary) {
    throw new Error("Start the normal OMPweb server and its separate host first; customization requires an existing primary link");
  }
  const primaryUrl = primary.url.replace(/\/+$/, "");
  if (hostForToken(primary.token)?.id !== LOCAL_HOST_ID
    || !links.some(link => link.url === primaryUrl && link.token === primary.token)) {
    throw new Error("The existing primary host link is not valid for this installation; customization will not rotate or replace it");
  }
  return { primary, primaryUrl, links };
}

export async function attachUiHostLink(value: string, { primary: reusePrimary = false } = {}): Promise<void> {
  const url = uiPreviewOrigin(value);
  if (reusePrimary) {
    if (readValidPrimary().primaryUrl !== url) {
      throw new Error("Primary customization must bind the existing primary host origin; no link was changed");
    }
    return;
  }
  await addHostLink(() => {
    const { primary, primaryUrl, links } = readValidPrimary();
    if (primaryUrl === url) {
      throw new Error("Preview customization must use another port; primary service reuse requires explicit --primary");
    }
    const existing = links.find(link => link.url === url);
    if (existing && existing.token !== primary.token) {
      throw new Error("This customization port already has a different host link; choose another port");
    }
    return { url, token: primary.token };
  });
}

export async function detachUiHostLink(value: string): Promise<boolean> {
  return removeSecondaryHostLink(uiPreviewOrigin(value));
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { remove: { type: "string" } }, strict: true });
  if (!values.remove) throw new Error("Expected --remove <preview-origin>");
  const removed = await detachUiHostLink(values.remove);
  console.log(removed ? "[omp-web UI] Secondary preview link removed" : "[omp-web UI] No removable secondary preview link");
}
