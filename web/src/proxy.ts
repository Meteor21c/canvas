import { NextResponse, type NextRequest } from "next/server";
import { isBlockedCanvasPage } from "@/lib/meteor-route-policy.mjs";

export function proxy(request: NextRequest) {
    if (isBlockedCanvasPage(request.nextUrl.pathname)) {
        return NextResponse.json({ code: 1, data: null, msg: "请通过流星 API 主站登录和管理账号" }, {
            status: 404, headers: { "Cache-Control": "no-store" },
        });
    }
    return NextResponse.next();
}
