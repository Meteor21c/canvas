// This pilot has no independent backend and must never proxy a caller supplied
// path, URL, credentials or request body to the original canvas Go service.
function denied() {
    return Response.json({ code: 404, data: null, message: "画布使用本站统一接口" }, {
        status: 404, headers: { "Cache-Control": "no-store" },
    });
}

export const GET = denied;
export const HEAD = denied;
export const POST = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
export const OPTIONS = denied;
