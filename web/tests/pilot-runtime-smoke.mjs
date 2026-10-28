import assert from "node:assert/strict";
const base = process.env.PILOT_BASE_URL || "http://127.0.0.1:3010";
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
    try {
        const response = await fetch(`${base}/studio/pilot-health`);
        if (response.ok && (await response.json()).service === "meteor-canvas-pilot") {
            healthy = true;
            break;
        }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(healthy, true, "frontend process must start with read-only root and bounded memory");
for (const path of ["/studio/canvas", "/studio/source", "/studio/LICENSE.txt"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
}
for (const path of ["/studio/login", "/studio/admin", "/studio/video", "/studio/api/proxy-image?url=http://127.0.0.1", "/studio/api/v1/storage", "/studio/_next/image?url=http://127.0.0.1"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
}
assert.equal((await fetch(`${base}/studio/api/v1/storage`, { method: "POST", body: "{}" })).status, 404);
assert.equal((await fetch(`${base}/studio/canvas`, { method: "POST", body: "{}" })).status, 405);
const html = await (await fetch(`${base}/studio/canvas`)).text();
const asset = html.match(/src="(\/studio\/_next\/static\/[^"<>]+\.js[^"<>]*)"/);
assert.ok(asset, "canvas must reference the prefix-aware compiled JS assets");
assert.equal((await fetch(new URL(asset[1].replaceAll("&amp;", "&"), base))).status, 200);
console.log("Pilot runtime boundaries and prefix-aware assets verified");
