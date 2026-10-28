// Only the integrated canvas is served. Original admin, proxy and registration
// endpoints remain in the source tree for provenance, but are never exposed.
export function isPilotPathAllowed(pathname) {
    const path = pathname.replace(/^\/studio(?=\/|$)/, "") || "/";
    return path === "/canvas" || /^\/canvas\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
        path.startsWith("/_next/static/") ||
        ["/pilot-health", "/source", "/favicon.ico", "/logo.svg", "/LICENSE.txt"].includes(path);
}
