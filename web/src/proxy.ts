import { NextResponse, type NextRequest } from "next/server";
import { isPilotPathAllowed } from "@/lib/pilot-route-policy.mjs";

export function proxy(request: NextRequest) {
    if (!isPilotPathAllowed(request.nextUrl.pathname)) {
        return NextResponse.json({ code: 404, data: null, message: "该功能未在创作画布试用版开放" }, {
            status: 404, headers: { "Cache-Control": "no-store" },
        });
    }
    if (!["GET", "HEAD"].includes(request.method)) {
        return NextResponse.json({ code: 405, data: null, message: "画布前端不接受写入请求" }, {
            status: 405, headers: { "Allow": "GET, HEAD", "Cache-Control": "no-store" },
        });
    }
    return NextResponse.next();
}
