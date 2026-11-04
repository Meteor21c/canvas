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
        return sendRaw(res, { object: "list", data: [{ id: "gpt-image-2" }, { id: "gpt-5.5" }, { id: "doubao-seedance-2.0-mini" }, { id: "MiniMax-H3" }, { id: "tencent-mps-superres" }] });
    }
    if (url.pathname === "/v1/videos/pricing") {
        if (auth !== `Bearer ${key}`) return send(res, null, 401);
        // Match the real gateway's validation, including unrelated estimates.
        // Explicit zero FPS/source duration must not silently pass this fixture.
        const model = url.searchParams.get("model");
        const duration = Number(url.searchParams.get("duration") ?? 5);
        const frameRate = Number(url.searchParams.get("frame_rate") ?? 30);
        const sourceSeconds = Number(url.searchParams.get("source_duration_seconds") ?? 5);
        const inputSeconds = Number(url.searchParams.get("input_video_seconds") ?? 0);
        const images = Number(url.searchParams.get("input_image_count") ?? 0);
        if (!Number.isInteger(duration) || duration < 3 || duration > 30 || ![30, 60, 120].includes(frameRate) || !Number.isFinite(sourceSeconds) || sourceSeconds <= 0 || sourceSeconds > 86400 || !Number.isFinite(inputSeconds) || inputSeconds < 0 || inputSeconds > 86400 || !Number.isInteger(images) || images < 0 || images > 10) return send(res, null, 400);
        if (model === "MiniMax-H3") {
            const surcharges = [
                { code: "input_video_seconds", metric_key: "h3_input_video_seconds", unit: "second", free_units: 0, official_unit_price: "0.5", sale_unit_price: "0.1" },
                { code: "extra_images", metric_key: "h3_input_extra_images", unit: "image", free_units: 5, official_unit_price: "0.1", sale_unit_price: "0.02" },
            ];
            const scenario = { resolutions: ["768P", "2K"], audio: null, input_video: null, billing_mode: "second", currency: "CNY", sale_per_second: "0.2", official_per_second: "1", sale_rate_to_official: "0.2", surcharges };
            if (url.searchParams.get("catalog") === "true") return sendRaw(res, { model, resolutions: scenario.resolutions, scenarios: [scenario] });
            const surcharge = inputSeconds * 0.1 + Math.max(images - 5, 0) * 0.02;
            return sendRaw(res, { ...scenario, precharge_amount: (duration * 0.2 + surcharge).toFixed(6), estimated_surcharge_amount: surcharge.toFixed(6) });
        }
        if (model === "tencent-mps-superres") {
            const scenarios = [30, 60].map(fps => ({ resolutions: ["720p", "1080p", "2K", "4K"], audio: null, input_video: null, billing_mode: "token", currency: "CNY", frame_rate: fps, sale_per_million: fps === 30 ? "1.2" : "2.3", official_per_million: "10", sale_rate_to_official: fps === 30 ? "0.12" : "0.23" }));
            if (url.searchParams.get("catalog") === "true") return sendRaw(res, { model, resolutions: scenarios[0].resolutions, scenarios });
            const scenario = scenarios.find(row => row.frame_rate === frameRate);
            if (!scenario) return send(res, null, 400);
            return sendRaw(res, { ...scenario, precharge_amount: "0.2" });
        }
        if (model !== "doubao-seedance-2.0-mini") return send(res, null, 400);
        const scenario = { resolutions: ["480p", "720p"], audio: false, input_video: false, billing_mode: "token", currency: "CNY", sale_per_million: "41.791", official_per_million: "46", sale_rate_to_official: "0.9085" };
        if (url.searchParams.get("catalog") === "true") return sendRaw(res, { model, resolutions: ["480p", "720p"], scenarios: [scenario] });
        return sendRaw(res, { ...scenario, precharge_amount: "0.25" });
    }
    if (!owner && !outsider) return send(res, null, 401);
    if (url.pathname === "/api/v1/auth/me") return send(res, { id: owner ? 1 : 2, email: owner ? "owner@example.invalid" : "outsider@example.invalid", role: owner ? "admin" : "user", status: "active", balance: 100, created_at: "2026-10-28T00:00:00Z" });
    if (url.pathname === "/api/v1/canvas/access") return send(res, { enabled: true, allowed: owner || outsider });
    if (url.pathname === "/api/v1/keys") return send(res, { total: 1, items: [{ id: 7, user_id: owner ? 1 : 2, group_id: 2, status: "active", name: "CI test key", key, quota: 100, quota_used: 0 }] });
    if (url.pathname === "/api/v1/groups/available") return send(res, [{ id: 2, name: "CI images", platform: "openai", status: "active", allow_image_generation: true, allow_video_generation: true, rate_multiplier: 1, image_price_1k: 0.1, image_price_2k: 0.2, image_price_4k: 0.4 }]);
    if (url.pathname === "/api/v1/groups/rates") return send(res, { "2": 1 });
    if (url.pathname === "/api/v1/groups/2/creative-pricing") {
        return send(res, { id: 2, model_pricing: [] });
    }
    // The selected image group is intentionally absent from the display plaza.
    // Runtime pricing must use its actual billing configuration instead.
    if (url.pathname === "/api/v1/model-plaza") return send(res, { groups: [] });
    return send(res, null, 404);
});
function sendRaw(res, data) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
server.listen(3000, "0.0.0.0", () => console.log("Mock main API ready; no paid generation endpoint exists"));
