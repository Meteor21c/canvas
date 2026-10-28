import test from "node:test";
import assert from "node:assert/strict";
import { canvasApiTarget, isBlockedCanvasApi, isBlockedCanvasPage, stripStudio } from "../src/lib/meteor-route-policy.mjs";

test("full upstream workspace UI stays available while independent login/admin is closed", () => {
    for (const path of ["/studio", "/studio/canvas", "/studio/canvas/id", "/studio/prompts", "/studio/assets", "/studio/asset-library", "/studio/image", "/studio/video", "/studio/workflows", "/studio/source", "/studio/_next/static/a.js", "/studio/director/index.html"]) assert.equal(isBlockedCanvasPage(path), false, path);
    for (const path of ["/studio/login", "/studio/register", "/studio/auth/callback", "/studio/admin", "/studio/admin/settings"]) assert.equal(isBlockedCanvasPage(path), true, path);
    assert.equal(stripStudio("/studio"), "/"); assert.equal(stripStudio("/studioevil/a"), "/studioevil/a");
});
test("API targets are fixed internal paths and reject traversal and unsafe control endpoints", () => {
    for (const parts of [["auth", "register"], ["auth", "login"], ["auth", "linux-do", "callback"], ["admin", "settings"], ["anonymous", "files"], ["bridge", "comfy", "result"], ["ai", "direct-request"], ["v1", "workflow-tasks"], ["v1", "comfy-bridges"], ["..", "admin"], ["v1/../../admin"], ["\\admin"], ["a\u0000b"]]) {
        assert.equal(isBlockedCanvasApi(parts), true, String(parts));
        assert.throws(() => canvasApiTarget(parts));
    }
    for (const path of ["health", "auth/me", "settings", "storage/config", "proxy-image", "v1/canvas/projects", "v1/images/generations", "v1/videos", "v1/chat/completions", "prompts", "assets"]) {
        const parts = path.split("/"); assert.equal(isBlockedCanvasApi(parts), false, path);
        assert.equal(canvasApiTarget(parts), `http://127.0.0.1:8080/api/${path}`);
    }
    assert.equal(canvasApiTarget(["proxy-image"], "?url=https%3A%2F%2Fexample.com"), "http://127.0.0.1:8080/api/proxy-image?url=https%3A%2F%2Fexample.com");
});
