export function GET() {
    return Response.json({ status: "ok", service: "meteor-canvas-pilot" }, {
        headers: { "Cache-Control": "no-store" },
    });
}
