import assert from "node:assert/strict";
const base = process.env.CANVAS_BASE_URL || "http://127.0.0.1:3010";
const owner = { Authorization: "Bearer meteor-ci-owner" };
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) {
    try { const r = await fetch(`${base}/studio/studio-health`); if (r.ok && (await r.json()).service === "meteor-canvas") { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(ready, true, "both Next and Go must become ready under production limits");
for (const path of ["/studio", "/studio/canvas", "/studio/prompts", "/studio/assets", "/studio/asset-library", "/studio/image", "/studio/video", "/studio/pricing", "/studio/workflows", "/studio/source", "/studio/LICENSE.txt"]) {
    const r = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
}
for (const path of ["/studio/login", "/studio/admin", "/studio/admin/settings"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
for (const path of ["auth/login", "auth/register", "auth/linux-do/authorize", "admin/login", "admin/settings", "anonymous/files/session", "bridge/comfy/poll", "ai/direct-request", "v1/comfy-bridges"]) {
    const r = await fetch(`${base}/studio/api/${path}`, { method: "POST", headers: owner, body: "{}" });
    assert.equal(r.status, 403, path);
}
for (const path of ["auth/me", "settings", "v1/canvas/projects", "v1/meteor/capabilities?kind=image", "files/not-present/content", "proxy-image?url=http://127.0.0.1"]) {
    const r = await fetch(`${base}/studio/api/${path}`);
    assert.ok([401, 403].includes(r.status), `${path} must require site owner: ${r.status}`);
}
const settings = await (await fetch(`${base}/studio/api/settings`, { headers: owner })).json();
assert.equal(settings.data.storage.retentionDays, 7);
const channels = settings.data.modelChannel.channels;
const imageChannel = channels.find(channel => channel.models.includes("gpt-image-2"));
const videoChannel = channels.find(channel => channel.models.includes("doubao-seedance-2.0-mini"));
assert.ok(imageChannel && videoChannel);
const capQuery = new URLSearchParams({ kind: "video", model: "doubao-seedance-2.0-mini", channelId: videoChannel.id });
const cap = await (await fetch(`${base}/studio/api/v1/meteor/capabilities?${capQuery}`, { headers: owner })).json();
assert.equal(cap.data.available, true); assert.equal(cap.data.maxBatch, 1); assert.equal(cap.data.watermark, false);
assert.deepEqual(cap.data.duration, { min: 4, max: 15 }); assert.deepEqual(cap.data.resolutions, ["480p", "720p"]);
const quote = async input => {
    const response = await fetch(`${base}/studio/api/v1/meteor/quote`, { method: "POST", headers: { ...owner, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
};
const videoInput = { kind: "video", channelId: videoChannel.id, model: "doubao-seedance-2.0-mini", count: 1, duration: 6, resolution: "720p", audio: false, inputVideo: false };
const videoPrice = await quote(videoInput);
assert.equal(videoPrice.status, 200); assert.equal(videoPrice.body.data.siteUnitPrice, "41.791");
assert.equal(videoPrice.body.data.prechargeAmount, "0.25"); assert.equal(videoPrice.body.data.estimatedAmount, null);
for (const invalid of [{ duration: 16 }, { duration: 3 }, { resolution: "4K" }, { count: 2 }]) assert.equal((await quote({ ...videoInput, ...invalid })).status, 400);
const imagePrice = await quote({ kind: "image", channelId: imageChannel.id, model: "gpt-image-2", count: 4, quality: "auto", size: "2048x2048", resolution: "2k" });
assert.equal(imagePrice.status, 200); assert.equal(imagePrice.body.data.estimatedAmount, "0.8");
assert.equal((await quote({ kind: "image", channelId: imageChannel.id, model: "gpt-image-2", count: 5 })).status, 400);
assert.ok(!JSON.stringify([cap, videoPrice, imagePrice]).includes("ci-secret-only-never-public"));
const meResponse = await fetch(`${base}/studio/api/auth/me`, { headers: owner });
assert.equal(meResponse.status, 200); const me = await meResponse.json();
assert.equal(me.code, 0); assert.equal(String(me.data.id), "meteor_user_1");
const outsider = await fetch(`${base}/studio/api/auth/me`, { headers: { Authorization: "Bearer meteor-ci-outsider" } });
assert.ok([401, 403].includes(outsider.status));
for (const path of ["settings", "v1/user-config"]) {
    const r = await fetch(`${base}/studio/api/${path}`, { headers: owner });
    assert.equal(r.status, 200, path); const text = await r.text();
    assert.ok(!text.includes("ci-secret-only-never-public"), "channel keys must never be serialized");
    const result = JSON.parse(text); assert.equal(result.code, 0, path);
}
const html = await (await fetch(`${base}/studio`)).text();
const asset = html.match(/src="(\/studio\/_next\/static\/[^"<>]+\.js[^"<>]*)"/);
assert.ok(asset, "HTML must reference /studio-prefixed compiled JS");
assert.equal((await fetch(new URL(asset[1].replaceAll("&amp;", "&"), base))).status, 200);
console.log("Workspace, owner API, 7-day retention, live pricing contract and parameter limits verified without generation");
