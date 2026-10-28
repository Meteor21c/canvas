// Preserve the upstream workspace UI while identity/admin/control channels
// are provided exclusively by the main Sub2API site.
export function stripStudio(pathname) {
    return pathname.replace(/^\/studio(?=\/|$)/, "") || "/";
}
export function isBlockedCanvasPage(pathname) {
    const path = stripStudio(pathname);
    return /^\/(?:admin|login|register|auth)(?:\/|$)/.test(path);
}
export function isBlockedCanvasApi(parts) {
    if (!Array.isArray(parts) || !parts.length || parts.some(part => !part || part === "." || part === ".." || /[\\/\u0000-\u001f]/.test(part))) return true;
    const path = parts.join("/");
    return /^(?:admin|anonymous|bridge)(?:\/|$)/.test(path) ||
        /^auth\/(?:login|register|linux-do)(?:\/|$)/.test(path) ||
        /^ai\/(?:direct-request|autodl)(?:\/|$)/.test(path) ||
        /^v1\/(?:workflow-providers|workflow-tasks|comfy-bridges)(?:\/|$)/.test(path);
}
export function canvasApiTarget(parts, search = "") {
    if (isBlockedCanvasApi(parts)) throw new Error("canvas API disabled");
    return `http://127.0.0.1:8080/api/${parts.map(encodeURIComponent).join("/")}${search}`;
}
