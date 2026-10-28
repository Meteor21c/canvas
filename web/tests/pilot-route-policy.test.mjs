import test from "node:test";
import assert from "node:assert/strict";
import { isPilotPathAllowed } from "../src/lib/pilot-route-policy.mjs";

test("only canvas, compiled assets and source/health are exposed", () => {
    for (const path of ["/canvas", "/canvas/abc-123_A", "/studio/canvas", "/studio/canvas/a", "/_next/static/chunks/a.js", "/source", "/pilot-health", "/LICENSE.txt"]) {
        assert.equal(isPilotPathAllowed(path), true, path);
    }
    for (const path of ["/", "/login", "/admin", "/admin/users", "/video", "/workflows", "/api/proxy-image", "/api/v1/storage", "/studio/api/x", "/canvas/a/b", "/canvas/../admin", "/canvas/a%2Fb", "/_next/image", "/studioevil/canvas"]) {
        assert.equal(isPilotPathAllowed(path), false, path);
    }
});
