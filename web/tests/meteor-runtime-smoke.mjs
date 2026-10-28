import assert from "node:assert/strict";
const base = process.env.CANVAS_BASE_URL || "http://127.0.0.1:3010";
const owner = { Authorization: "Bearer meteor-ci-owner" };
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) {
    try { const r = await fetch(`${base}/studio/studio-health`); if (r.ok && (await r.json()).service === "meteor-canvas") { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(ready, true, "both Next and Go must become ready under production limits");
for (const path of ["/studio", "/studio/canvas", "/studio/prompts", "/studio/assets", "/studio/asset-library", "/studio/image", "/studio/video", "/studio/workflows", "/studio/source", "/studio/LICENSE.txt"]) {
    const r = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
}
for (const path of ["/studio/login", "/studio/admin", "/studio/admin/settings"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
for (const path of ["auth/login", "auth/register", "auth/linux-do/authorize", "admin/login", "admin/settings", "anonymous/files/session", "bridge/comfy/poll", "ai/direct-request", "v1/comfy-bridges"]) {
    const r = await fetch(`${base}/studio/api/${path}`, { method: "POST", headers: owner, body: "{}" });
    assert.equal(r.status, 403, path);
}
for (const path of ["auth/me", "settings", "v1/canvas/projects", "files/not-present/content", "proxy-image?url=http://127.0.0.1"]) {
    const r = await fetch(`${base}/studio/api/${path}`);
    assert.ok([401, 403].includes(r.status), `${path} must require site owner: ${r.status}`);
}
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
console.log("Full workspace, owner API, disabled control endpoints and source/assets verified without generation");
