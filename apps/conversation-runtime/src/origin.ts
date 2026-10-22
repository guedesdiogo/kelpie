// The admin API's origin as a deploy sets it (Story 3.11), in a module of its own, so the tools that
// link its pages don't import the configuration tools.

/** The origin, when the value is a bare https origin; otherwise empty, as if it weren't set. */
export function bareHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  const bare =
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return bare ? url.origin : "";
}
