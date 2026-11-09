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

// Only these pages need the standalone-login/admin fence. Matching API uploads
// would make Next clone and truncate their streams at its default 10 MiB limit.
// API authorization and route restrictions remain in app/api/[...path]/route.ts.
export const config = {
    matcher: ["/admin/:path*", "/login/:path*", "/register/:path*", "/auth/:path*"],
};
