export const dynamic = "force-dynamic";
export async function GET() {
    try {
        const upstream = await fetch("http://127.0.0.1:8080/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
        if (upstream.ok && await upstream.text() === "ok") return Response.json({ status: "ok", service: "meteor-canvas", version: process.env.NEXT_PUBLIC_APP_VERSION }, { headers: { "Cache-Control": "no-store" } });
    } catch { /* A failed backend must fail the combined container check. */ }
    return Response.json({ status: "unavailable", service: "meteor-canvas" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
