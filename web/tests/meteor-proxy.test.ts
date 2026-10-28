import { afterAll, beforeEach, expect, test } from "bun:test";
const originalFetch = globalThis.fetch;
const route = await import("../src/app/api/[...path]/route");
let calls: Array<{ url: string; init?: RequestInit }> = [];
let reply: () => Response;
beforeEach(() => {
    calls = []; reply = () => Response.json({ code: 0, data: { safe: true } });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return reply(); }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });
function request(path: string, method = "GET", headers: Record<string, string> = {}) {
    return { method, nextUrl: new URL(`https://api.meteor21c.fun/studio/api/${path}`), headers: new Headers(headers), body: method === "GET" ? null : new Blob(["{}"]).stream(), signal: new AbortController().signal } as any;
}
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

test("proxy always uses internal Go and forwards owner/channel headers without cookies or spoofed forwarding", async () => {
    process.env.API_BASE_URL = "https://attacker.invalid";
    const result = await route.POST(request("v1/canvas/projects", "POST", { Authorization: "Bearer owner-test", Cookie: "main=private", "X-Forwarded-Host": "attacker.invalid", "X-User-Model-Channel-ID": "channel-7", "Content-Type": "application/json" }), context("v1/canvas/projects"));
    expect(result.status).toBe(200); expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8080/api/v1/canvas/projects");
    const headers = calls[0].init!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer owner-test");
    expect(headers.get("X-User-Model-Channel-ID")).toBe("channel-7");
    expect(headers.get("Cookie")).toBeNull(); expect(headers.get("X-Forwarded-Host")).toBeNull();
    expect(calls[0].init!.redirect).toBe("manual");
    delete process.env.API_BASE_URL;
});
test("dangerous auth/admin/control endpoints never make a backend request", async () => {
    for (const path of ["auth/login", "auth/register", "admin/settings", "anonymous/files", "bridge/comfy/poll", "ai/direct-request", "v1/workflow-tasks"]) {
        expect((await route.POST(request(path, "POST"), context(path))).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
});
test("internal redirects cannot reveal a service location or relay credentials", async () => {
    reply = () => new Response(null, { status: 302, headers: { Location: "https://attacker.invalid", "Set-Cookie": "session=private" } });
    const result = await route.GET(request("files/a/content"), context("files/a/content"));
    expect(result.status).toBe(502); expect(result.headers.get("Location")).toBeNull(); expect(result.headers.get("Set-Cookie")).toBeNull();
});
test("media does not execute upstream HTML/SVG and JSON does not set cookies", async () => {
    for (const type of ["text/html", "image/svg+xml", "application/javascript"]) {
        reply = () => new Response("untrusted", { headers: { "Content-Type": type } });
        expect((await route.GET(request("proxy-image?url=https://media.invalid/a"), context("proxy-image"))).status).toBe(415);
    }
    reply = () => Response.json({ code: 0, data: {} }, { headers: { "Set-Cookie": "private=1", Server: "internal" } });
    const result = await route.GET(request("settings"), context("settings"));
    expect(result.headers.get("Set-Cookie")).toBeNull(); expect(result.headers.get("Server")).toBeNull();
    expect(result.headers.get("Cache-Control")).toBe("no-store");
});
