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
test("signed media reaches the exact content endpoint with its query and no invented identity", async () => {
    reply = () => new Response("media", { headers: { "Content-Type": "video/mp4" } });
    for (const path of ["files/file-id/content", "v1/videos/video-id/content"]) {
        const query = "?expires=1793200000&signature=test-signature";
        const result = await route.GET(request(path + query), context(path));
        expect(result.status).toBe(200);
        expect(calls.at(-1)!.url).toBe(`http://127.0.0.1:8080/api/${path}${query}`);
        expect((calls.at(-1)!.init!.headers as Headers).get("Authorization")).toBeNull();
        expect(result.headers.get("Content-Security-Policy")).toContain("sandbox");
    }
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

test("native media downloads stream before completion and preserve length, range and attachment headers", async () => {
    let finish!: () => void;
    reply = () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finish = () => { controller.enqueue(new TextEncoder().encode("last")); controller.close(); };
    } }), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": "9", "Content-Range": "bytes 0-8/20", "Accept-Ranges": "bytes", "Content-Disposition": "attachment; filename=video.mp4", "X-Accel-Buffering": "no" } });
    const result = await route.GET(request("v1/videos/id/content?download=1", "GET", { Range: "bytes=0-8" }), context("v1/videos/id/content"));
    expect(result.status).toBe(206);
    expect((calls[0].init!.headers as Headers).get("Range")).toBe("bytes=0-8");
    expect(result.headers.get("Content-Length")).toBe("9");
    expect(result.headers.get("Content-Range")).toBe("bytes 0-8/20");
    expect(result.headers.get("Accept-Ranges")).toBe("bytes");
    expect(result.headers.get("Content-Disposition")).toContain("attachment");
    expect(result.headers.get("X-Accel-Buffering")).toBe("no");
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
    expect((await reader.read()).done).toBe(true);
});

test("encoded media never forwards a stale compressed content length", async () => {
    reply = () => new Response("decompressed", { headers: { "Content-Type": "video/mp4", "Content-Encoding": "gzip", "Content-Length": "5" } });
    const result = await route.GET(request("files/id/content"), context("files/id/content"));
    expect(result.headers.get("Content-Length")).toBeNull();
    expect(result.headers.get("Content-Encoding")).toBeNull();
});
