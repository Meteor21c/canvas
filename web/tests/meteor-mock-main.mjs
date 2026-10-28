import http from "node:http";
const send = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: status === 200 ? 0 : status, data, message: status === 200 ? "ok" : "denied" })); };
const key = "ci-secret-only-never-public";
const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://main.invalid");
    const auth = req.headers.authorization || "";
    const owner = auth === "Bearer meteor-ci-owner";
    const outsider = auth === "Bearer meteor-ci-outsider";
    if (url.pathname === "/health") { res.end("ok"); return; }
    if (url.pathname === "/v1/models") {
        if (auth !== `Bearer ${key}`) return send(res, null, 401);
        return sendRaw(res, { object: "list", data: [{ id: "gpt-image-2" }, { id: "gpt-5.5" }, { id: "grok-imagine-video" }] });
    }
    if (!owner && !outsider) return send(res, null, 401);
    if (url.pathname === "/api/v1/auth/me") return send(res, { id: owner ? 1 : 2, email: owner ? "owner@example.invalid" : "outsider@example.invalid", role: owner ? "admin" : "user", status: "active", balance: 100, created_at: "2026-10-28T00:00:00Z" });
    if (url.pathname === "/api/v1/canvas/access") return send(res, { enabled: true, allowed: owner });
    if (url.pathname === "/api/v1/keys") return send(res, { total: 1, items: [{ id: 7, user_id: 1, group_id: 2, status: "active", name: "CI test key", key, quota: 100, quota_used: 0 }] });
    if (url.pathname === "/api/v1/groups/available") return send(res, [{ id: 2, name: "CI images", platform: "openai", status: "active", allow_image_generation: true, allow_video_generation: true, rate_multiplier: 1, image_price_1k: 0.1, image_price_2k: 0.2, image_price_4k: 0.4 }]);
    if (url.pathname === "/api/v1/groups/rates") return send(res, { "2": 1 });
    return send(res, null, 404);
});
function sendRaw(res, data) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
server.listen(3000, "0.0.0.0", () => console.log("Mock main API ready; no paid generation endpoint exists"));
