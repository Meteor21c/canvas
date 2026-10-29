import type { NextRequest } from "next/server";
import { canvasApiTarget, isBlockedCanvasApi } from "@/lib/meteor-route-policy.mjs";

export const runtime = "nodejs";
export const maxDuration = 600;
type RouteContext = { params: Promise<{ path: string[] }> };
const hopHeaders = ["host", "content-length", "connection", "expect", "transfer-encoding", "keep-alive", "upgrade", "proxy-authorization", "proxy-authenticate", "cookie"];

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    if (isBlockedCanvasApi(path)) return Response.json({ code: 1, data: null, msg: "此独立认证或管理接口已停用" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    const target = canvasApiTarget(path, request.nextUrl.search);
    const headers = new Headers(request.headers);
    hopHeaders.forEach(name => headers.delete(name));
    for (const name of [...headers.keys()]) if (name.startsWith("x-forwarded-") || name === "forwarded") headers.delete(name);
    const hasBody = !["GET", "HEAD"].includes(request.method);
    try {
        const response = await fetch(target, {
            method: request.method, headers,
            body: hasBody ? request.body : undefined,
            duplex: hasBody ? "half" : undefined,
            redirect: "manual",
            signal: request.headers.get("X-Canvas-Node-Request") === "true" ? request.signal : AbortSignal.timeout(610000),
        } as RequestInit & { duplex?: "half" });
        // No internal redirect, cookie, service address or executable content
        // policy is inherited from the original standalone backend.
        if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel();
            return Response.json({ code: 1, data: null, msg: "媒体接口返回了不可转发的重定向" }, { status: 502 });
        }
        const outgoing = new Headers(response.headers);
        ["content-encoding", "transfer-encoding", "connection", "set-cookie", "server"].forEach(name => outgoing.delete(name));
        const mediaPath = path[0] === "proxy-image" || path[0] === "files" || (path[0] === "v1" && path.includes("content"));
        // fetch may transparently decompress encoded bodies; only keep exact
        // unencoded media lengths so native downloads can display progress.
        if (!mediaPath || response.headers.has("content-encoding")) outgoing.delete("content-length");
        if (mediaPath) {
            const contentType = outgoing.get("Content-Type") || "";
            if (/text\/html|image\/svg\+xml|(?:java|ecma)script/i.test(contentType)) {
                void response.body?.cancel();
                return Response.json({ code: 1, data: null, msg: "不支持作为媒体交付的文件类型" }, { status: 415 });
            }
            outgoing.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
        }
        outgoing.set("Cache-Control", "no-store");
        outgoing.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, { status: response.status, headers: outgoing });
    } catch {
        // Never log targets/query strings: media signatures can be present.
        return Response.json({ code: 1, data: null, msg: "创作服务暂时无法连接，请核对原任务后重试" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
