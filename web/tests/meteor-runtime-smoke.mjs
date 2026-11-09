import assert from "node:assert/strict";
import { videoUploadFixture } from "./fixtures/meteor-upload-video.mjs";
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
for (const path of ["/studio/login", "/studio/register", "/studio/auth/callback", "/studio/admin", "/studio/admin/settings"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
for (const path of ["auth/login", "auth/register", "auth/linux-do/authorize", "admin/login", "admin/settings", "anonymous/files/session", "bridge/comfy/poll", "ai/direct-request", "v1/comfy-bridges"]) {
    const r = await fetch(`${base}/studio/api/${path}`, { method: "POST", headers: owner, body: "{}" });
    assert.equal(r.status, 403, path);
}
for (const path of ["auth/me", "settings", "v1/canvas/projects", "v1/meteor/capabilities?kind=image", "files/not-present/content", "proxy-image?url=http://127.0.0.1"]) {
    const r = await fetch(`${base}/studio/api/${path}`);
    assert.ok([401, 403].includes(r.status), `${path} must require a valid account: ${r.status}`);
}
const settings = await (await fetch(`${base}/studio/api/settings`, { headers: owner })).json();
assert.equal(settings.data.storage.retentionDays, 7);
const channels = settings.data.modelChannel.channels;
const imageChannel = channels.find(channel => channel.models.includes("gpt-image-2"));
const videoChannel = channels.find(channel => channel.models.includes("doubao-seedance-2.0-mini"));
const h3Channel = channels.find(channel => channel.models.includes("MiniMax-H3"));
const enhanceChannel = channels.find(channel => channel.models.includes("tencent-mps-superres"));
assert.ok(imageChannel && videoChannel && h3Channel && enhanceChannel);
const capQuery = new URLSearchParams({ kind: "video", model: "doubao-seedance-2.0-mini", channelId: videoChannel.id });
const cap = await (await fetch(`${base}/studio/api/v1/meteor/capabilities?${capQuery}`, { headers: owner })).json();
assert.equal(cap.data.available, true); assert.equal(cap.data.maxBatch, 1); assert.equal(cap.data.watermark, false);
assert.equal(cap.data.uploads.imageMaxBytes, 10 * 1024 * 1024);
assert.equal(cap.data.uploads.videoMaxBytes, 50 * 1024 * 1024);
assert.equal(cap.data.uploads.audioMaxBytes, 20 * 1024 * 1024);
assert.equal(cap.data.uploads.totalReferenceMaxBytes, 100 * 1024 * 1024);
assert.deepEqual(cap.data.videoInput.referenceLimits, { images: 9, videos: 3, audios: 3, total: 10 });
assert.equal(cap.data.videoInput.audioOnlyReferences, false);
assert.equal(cap.data.videoInput.framesWithReferences, false);
assert.deepEqual(cap.data.videoInput.referenceDuration, { min: 2, max: 15 });
assert.deepEqual(cap.data.duration, { min: 4, max: 15 }); assert.deepEqual(cap.data.resolutions, ["480p", "720p"]);
// Exercise ffprobe and the writable data volume inside the restricted image.
const sampleRate = 16000, pcmBytes = sampleRate * 2 * 3;
const wav = Buffer.alloc(44 + pcmBytes);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcmBytes, 40);
const form = new FormData(); form.append("file", new Blob([wav], { type: "audio/wav" }), "ci-probe-3s.wav");
const uploadedResponse = await fetch(`${base}/studio/api/v1/files`, { method: "POST", headers: owner, body: form });
assert.equal(uploadedResponse.status, 200);
const uploaded = (await uploadedResponse.json()).data;
assert.equal(uploaded.bytes, wav.length); assert.ok(Math.abs(uploaded.durationSeconds - 3) < 0.05);
assert.ok(uploaded.mimeType.startsWith("audio/")); assert.ok(uploaded.storageKey.startsWith("server:"));
const prepared = await fetch(`${base}/studio/api/v1/meteor/download`, { method: "POST", headers: { ...owner, "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: uploaded.storageKey, filename: "ci-download.wav" }) });
assert.equal(prepared.status, 200);
const downloadUrl = (await prepared.json()).data.url;
assert.ok(downloadUrl.startsWith("/studio/api/files/"));
const nativeDownload = await fetch(`${base}${downloadUrl}`, { headers: { Range: "bytes=0-43" } });
assert.equal(nativeDownload.status, 206);
assert.equal(nativeDownload.headers.get("Content-Length"), "44");
assert.equal(nativeDownload.headers.get("Content-Range"), `bytes 0-43/${wav.length}`);
assert.ok(nativeDownload.headers.get("Content-Disposition").includes("attachment"));
assert.ok(nativeDownload.headers.get("Content-Disposition").includes("ci-download.wav"));
assert.equal((await nativeDownload.arrayBuffer()).byteLength, 44);
const crossOwnerDownload = await fetch(`${base}/studio/api/v1/meteor/download`, { method: "POST", headers: { Authorization: "Bearer meteor-ci-outsider", "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: uploaded.storageKey, filename: "stolen.wav" }) });
assert.equal(crossOwnerDownload.status, 403);
assert.equal((await fetch(`${base}/studio/api/v1/files/${encodeURIComponent(uploaded.id)}`, { method: "DELETE", headers: owner })).status, 200);
// Upload through the actual compiled Next -> Go path. Page-only middleware
// must not truncate media at 10 MiB or buffer the site's full 50 MiB allowance.
for (const bytes of [12 * 1024 * 1024, 50 * 1024 * 1024]) {
    const videoForm = new FormData();
    videoForm.append("file", new Blob([videoUploadFixture(bytes)], { type: "video/mp4" }), "ci-upload-limit.mp4");
    const response = await fetch(`${base}/studio/api/v1/files`, { method: "POST", headers: owner, body: videoForm });
    assert.equal(response.status, 200, `${bytes} byte video must reach storage intact`);
    const payload = await response.json();
    assert.equal(payload.code, 0); assert.equal(payload.data.bytes, bytes);
    assert.equal(payload.data.width, 16); assert.equal(payload.data.height, 16);
    assert.ok(Math.abs(payload.data.durationSeconds - 1) < 0.05);
    assert.ok(payload.data.storageKey.startsWith("server:"));
}
const oversizedVideo = new FormData();
oversizedVideo.append("file", new Blob([videoUploadFixture(50 * 1024 * 1024 + 1)], { type: "video/mp4" }), "ci-over-limit.mp4");
const rejectedVideo = await fetch(`${base}/studio/api/v1/files`, { method: "POST", headers: owner, body: oversizedVideo });
assert.equal(rejectedVideo.status, 400, "media upload limit must still reject more than 50 MiB");
assert.match((await rejectedVideo.json()).msg, /50 MiB/);
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
const capabilities = async (model, channelId) => {
    const query = new URLSearchParams({ kind: "video", model, channelId });
    const response = await fetch(`${base}/studio/api/v1/meteor/capabilities?${query}`, { headers: owner });
    assert.equal(response.status, 200, `${model} capabilities`);
    return (await response.json()).data;
};
const enhanceCap = await capabilities("tencent-mps-superres", enhanceChannel.id);
assert.equal(enhanceCap.available, true); assert.equal(enhanceCap.operation, "enhance");
assert.equal(enhanceCap.duration, null); assert.equal(enhanceCap.retentionHours, 24);
assert.equal(enhanceCap.retentionDays, 1); assert.equal(enhanceCap.maxBatch, 1);
assert.deepEqual(enhanceCap.frameRates, [30, 60]);
assert.deepEqual(enhanceCap.resolutions, ["720p", "1080p", "2K", "4K"]);
const enhanceInput = { kind: "video", channelId: enhanceChannel.id, model: "tencent-mps-superres", count: 1, resolution: "2K", frameRate: 60, sourceDurationSeconds: 12.5, audio: false, inputVideo: true };
const enhancePrice = await quote(enhanceInput);
assert.equal(enhancePrice.status, 200); assert.equal(enhancePrice.body.data.available, true);
assert.equal(enhancePrice.body.data.billingMode, "token");
assert.equal(enhancePrice.body.data.unit, "million_output_tokens");
assert.equal(enhancePrice.body.data.siteUnitPrice, "2.3");
assert.equal(enhancePrice.body.data.prechargeAmount, "0.2");
assert.equal(enhancePrice.body.data.estimatedAmount, null, "enhancement duration must never become fabricated tokens");
const fps30Price = await quote({ ...enhanceInput, frameRate: 30, sourceDurationSeconds: undefined });
assert.equal(fps30Price.status, 200); assert.equal(fps30Price.body.data.available, true);
assert.equal(fps30Price.body.data.siteUnitPrice, "1.2");
for (const invalid of [{ frameRate: 0 }, { frameRate: 120 }, { resolution: "8K" }, { count: 2 }]) assert.equal((await quote({ ...enhanceInput, ...invalid })).status, 400);
const h3Cap = await capabilities("MiniMax-H3", h3Channel.id);
assert.equal(h3Cap.available, true); assert.equal(h3Cap.retentionDays, 7);
assert.deepEqual(h3Cap.duration, { min: 4, max: 15 });
assert.deepEqual(h3Cap.resolutions, ["768P", "2K"]);
assert.equal(h3Cap.maxReferences, 10); assert.equal(h3Cap.supportsAudio, false);
const h3Input = { kind: "video", channelId: h3Channel.id, model: "MiniMax-H3", count: 1, duration: 5, resolution: "768P", audio: false, inputVideo: true, inputVideoSeconds: 3.5, inputImageCount: 8 };
const h3Price = await quote(h3Input);
assert.equal(h3Price.status, 200); assert.equal(h3Price.body.data.available, true);
assert.equal(h3Price.body.data.billingMode, "second");
assert.equal(h3Price.body.data.siteUnitPrice, "0.2");
assert.equal(h3Price.body.data.prechargeAmount, "1.41");
assert.equal(h3Price.body.data.estimatedSurchargeAmount, "0.41");
assert.equal(h3Price.body.data.estimatedAmount, "1.41");
assert.deepEqual(h3Price.body.data.surcharges.map(row => ({ code: row.code, unit: row.unit, freeUnits: row.freeUnits, siteUnitPrice: row.siteUnitPrice })), [
    { code: "input_video_seconds", unit: "second", freeUnits: 0, siteUnitPrice: "0.1" },
    { code: "extra_images", unit: "image", freeUnits: 5, siteUnitPrice: "0.02" },
]);
for (const invalid of [{ duration: 0 }, { duration: 16 }, { inputImageCount: 11 }, { resolution: "4K" }]) assert.equal((await quote({ ...h3Input, ...invalid })).status, 400);
const publicPrices = JSON.stringify([cap, videoPrice, imagePrice, enhanceCap, enhancePrice, h3Cap, h3Price]);
for (const forbidden of ["ci-secret-only-never-public", "upstream", "markup", "fzyinghe"]) assert.ok(!publicPrices.includes(forbidden), `private field must not be serialized: ${forbidden}`);
const meResponse = await fetch(`${base}/studio/api/auth/me`, { headers: owner });
assert.equal(meResponse.status, 200); const me = await meResponse.json();
assert.equal(me.code, 0); assert.equal(String(me.data.id), "meteor_user_1");
const outsider = await fetch(`${base}/studio/api/auth/me`, { headers: { Authorization: "Bearer meteor-ci-outsider" } });
assert.equal(outsider.status, 200);
assert.equal((await outsider.json()).data.id, "meteor_user_2");
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
console.log("Workspace, customer API, 7-day retention, MPS Token/FPS/24h contract, H3 input tariffs and parameter limits verified without generation");
