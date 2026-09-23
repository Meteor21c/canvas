import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const reference = { id: "ref", name: "ref.png", type: "image/png", dataUrl: "https://media.example/ref.png" };
const inlineImage = "data:image/png;base64,AQID";

// Exercise the real configuration, storage and image request modules with mocked I/O.
function fixture({ token = "", mode = "local", format = "json", protocol = "openai" } = {}) {
    const calls = [];
    const state = {
        response: { data: [{ b64_json: "AQID" }] },
        stream: "",
        storage: { mode: "local_indexeddb", autoSyncAllAssets: false, allowUserProvider: false },
        uploadedUrl: "https://media.example/uploaded.png",
        storedUrl: "https://media.example/stored.png",
        userProvider: null,
    };
    const modules = {
        axios: { isAxiosError: () => false },
        react: { useMemo: (run) => run() },
        zustand: { create: () => () => ({}) },
        "zustand/middleware": { persist: (value) => value },
        localforage: { createInstance: () => ({ getItem: async () => null, setItem: async () => {} }) },
        nanoid: { nanoid: () => "generated-id" },
        "@/lib/gemini": { isGeminiConfig: () => protocol === "gemini" },
        "@/lib/image-utils": { readImageMeta: async () => ({ width: 1, height: 1 }), dataUrlToFile: () => new File(["image"], "ref.png", { type: "image/png" }) },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ token, user: token ? { role: "admin" } : null, hydrateUser: async () => {} }) } },
        "@/services/api/request": { apiGet: async (url) => { assert.equal(url, "/api/storage/config"); return state.storage; } },
        "@/services/api/storage": { getStorageObjectInfo: async () => ({ publicUrl: state.storedUrl }) },
        "@/services/anonymous-storage": { uploadAnonymousStorageFile: async () => {
            calls.push({ url: "/api/anonymous/files" });
            return { url: state.uploadedUrl, storageKey: "server:anonymous" };
        } },
    };
    const load = (path) => {
        const exports = {};
        const bindings = {};
        let source = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"));
        source = source.replace(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";\s*/gm, (_, imports, name) => {
            if (imports.startsWith("{")) for (const key of imports.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean)) bindings[key] = modules[name]?.[key] || (() => false);
            else bindings[imports] = modules[name];
            return "";
        });
        source = source.replace(/import\("([^"]+)"\)/g, (_, name) => `Promise.resolve(modules[${JSON.stringify(name)}])`);
        const names = [...source.matchAll(/^export (?:async )?(?:function|class|const) (\w+)/gm)].map((match) => match[1]);
        source = source.replace(/^export /gm, "") + `\nObject.assign(exports, {${names.join(",")}});`;
        vm.runInNewContext(source, {
            exports, modules, ...bindings, Error, URL, FormData, Blob, File, Response, AbortController, TextDecoder,
            window: { setTimeout, clearTimeout, location: new URL("https://canvas.example"), localStorage: { getItem: (key) => key.endsWith(":user_storage_provider") ? JSON.stringify(state.userProvider) : null } },
            fetch: async (url, options) => {
                calls.push({ url, ...options });
                if (url.startsWith("data:")) return new Response(new Blob(["image"], { type: "image/png" }));
                if (url === "/api/v1/files") return Response.json({ code: 0, data: { url: state.uploadedUrl, storageKey: "server:uploaded" } });
                if (url === "/api/v1/canvas/image-tasks") return Response.json({ code: 0, data: { id: "task", status: "queued" } });
                return state.stream ? new Response(state.stream, { headers: { "Content-Type": "text/event-stream" } }) : Response.json(state.response);
            },
        }, { filename: path });
        return exports;
    };
    modules["@/lib/model-channel"] = load("../../lib/model-channel.ts");
    const store = modules["@/stores/use-config-store"] = load("../../stores/use-config-store.ts");
    const storage = modules["@/services/image-storage"] = load("../image-storage.ts");
    const channel = { id: "channel", protocol, imageEditFormat: format, name: "渠道", baseUrl: "https://gateway.example", apiKey: "channel-key", models: ["renamed-model"] };
    const config = { ...store.defaultConfig, model: "renamed-model", imageModel: "renamed-model", channelMode: mode, imageChannelId: channel.id, activeChannelId: channel.id, localChannels: [channel], publicChannels: [{ ...channel, apiKey: undefined }] };
    return { api: load("./image.ts"), config, channel, store, storage, calls, state };
}

test("JSON image edits follow the selected channel after model renaming in every request mode", async () => {
    for (const [token, mode] of [["", "local"], ["session", "local"], ["session", "remote"]]) {
        const { api, config, calls } = fixture({ token, mode });
        config.streamImages = "true";
        const images = await api.requestEdit(config, "修改背景", [reference]);
        assert.equal(images[0].dataUrl, inlineImage);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, token ? "/api/v1/images/edits" : "https://gateway.example/v1/images/edits");
        assert.equal(calls[0].headers["Content-Type"], "application/json");
        assert.equal(calls[0].headers.Authorization, `Bearer ${token || "channel-key"}`);
        assert.deepEqual(JSON.parse(calls[0].body), { model: "renamed-model", prompt: "修改背景", images: [{ image_url: reference.dataUrl }], size: "1024x1024", stream: true });
    }
});

test("background image tasks preserve JSON, stream and the local or remote channel selection", async () => {
    for (const mode of ["local", "remote"]) {
        const { api, config, calls } = fixture({ token: "session", mode });
        config.streamImages = "true";
        await api.createCanvasImageTask(config, "修改背景", [reference], { nodeId: "node" });
        assert.equal(calls[0].url, "/api/v1/canvas/image-tasks");
        assert.equal(calls[0].headers[mode === "local" ? "X-User-Model-Channel-ID" : "X-Model-Channel-ID"], "channel");
        const body = JSON.parse(calls[0].body);
        assert.equal(body.endpoint, "/images/edits");
        assert.equal(body.nodeId, "node");
        assert.equal(body.request.stream, true);
        assert.deepEqual(body.request.images, [{ image_url: reference.dataUrl }]);
    }
});

test("JSON edit streams read final images both in data arrays and top-level b64_json", async () => {
    for (const final of [{ data: [{ b64_json: "AQID" }] }, { b64_json: "AQID" }]) {
        const { api, config, state } = fixture();
        config.streamImages = "true";
        state.stream = `data: {"progress":50}\n\nevent: completed\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`;
        assert.equal((await api.requestEdit(config, "背景", [reference]))[0].dataUrl, inlineImage);
    }
});

test("channel normalization preserves JSON and selecting another channel restores file uploads", async () => {
    const { api, config, channel, store, calls } = fixture();
    assert.equal(store.normalizeLocalChannels(config)[0].imageEditFormat, "json");
    config.localChannels.push({ ...channel, id: "files", imageEditFormat: "multipart" });
    config.imageChannelId = "files";
    config.activeChannelId = "files";
    await api.requestEdit(config, "背景", [{ ...reference, dataUrl: inlineImage }]);
    const request = calls.find((call) => call.url.endsWith("/images/edits"));
    assert.ok(request.body instanceof FormData);
    assert.ok(request.body.get("image") instanceof File);
});

test("JSON format does not change text-to-image requests", async () => {
    const { api, config, calls } = fixture();
    await api.requestEdit(config, "背景", []);
    assert.equal(calls[0].url, "https://gateway.example/v1/images/generations");
    assert.equal(JSON.parse(calls[0].body).images, undefined);
});

test("inline references upload to configured object storage before image generation", async () => {
    const { api, config, calls, state } = fixture({ token: "session" });
    state.storage.mode = "server_sqlite_s3";
    await api.requestEdit(config, "背景", [{ ...reference, dataUrl: inlineImage }]);
    assert.deepEqual(calls.map((call) => call.url), [inlineImage, "/api/v1/files", "/api/v1/images/edits"]);
    assert.equal(JSON.parse(calls[2].body).images[0].image_url, state.uploadedUrl);
});

test("stored references reuse their public URL without uploading again", async () => {
    const { storage, calls, state } = fixture();
    const url = await storage.imageToPublicUrl({ storageKey: "server:existing", dataUrl: "blob:cached" });
    assert.equal(url, state.storedUrl);
    assert.equal(calls.length, 0);
});

test("anonymous uploads use the public URL instead of their cached browser blob URL", async () => {
    const { api, config, calls, state } = fixture();
    state.storage.allowUserProvider = true;
    state.userProvider = { type: "s3", enabled: true, endpoint: "https://s3.example", bucket: "images", accessKeyId: "key", secretAccessKey: "secret", publicBaseUrl: "https://media.example" };
    await api.requestEdit(config, "背景", [{ ...reference, dataUrl: inlineImage }]);
    assert.deepEqual(calls.map((call) => call.url), [inlineImage, "/api/anonymous/files", "https://gateway.example/v1/images/edits"]);
    assert.equal(JSON.parse(calls[2].body).images[0].image_url, state.uploadedUrl);
});

test("missing public storage rejects before a generation request", async () => {
    const { api, config, calls } = fixture();
    await assert.rejects(api.requestEdit(config, "背景", [{ ...reference, dataUrl: inlineImage }]), /图生图需要公网图片地址/);
    assert.equal(calls.some((call) => call.url.endsWith("/images/edits")), false);
});

test("private, relative and credential-protected upload URLs never reach the image API", async () => {
    for (const uploadedUrl of ["/api/files/id/content", "http://localhost/ref.png", "http://192.168.1.2/ref.png", "http://10.0.0.2/ref.png", "http://[::1]/ref.png", "http://[fd00::1]/ref.png", "https://user:secret@media.example/ref.png"]) {
        const { api, config, calls, state } = fixture({ token: "session" });
        Object.assign(state.storage, { mode: "server_sqlite_s3" });
        state.uploadedUrl = uploadedUrl;
        await assert.rejects(api.requestEdit(config, "背景", [{ ...reference, dataUrl: inlineImage }]), /对象存储未返回公网图片直链/);
        assert.equal(calls.some((call) => call.url.endsWith("/images/edits")), false);
    }
});

test("Seedream edits bypass channel JSON public-URL mode and send inline data URLs to generations", async () => {
    const { api, config, channel, calls } = fixture({ token: "session", mode: "local" });
    config.model = config.imageModel = "seedream5";
    channel.models = ["seedream5"];
    const result = await api.requestEdit(config, "调整光线", [{ ...reference, dataUrl: inlineImage }]);
    assert.equal(result[0].dataUrl, inlineImage);
    assert.equal(calls[0].url, "/api/v1/images/generations");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, "seedream5");
    assert.equal(body.prompt, "调整光线");
    assert.deepEqual(body.image, [inlineImage]);
});

test("remote Canvas Seedream tasks keep the generations JSON request shape", async () => {
    const { api, config, channel, calls } = fixture({ token: "session", mode: "remote" });
    config.model = config.imageModel = "seedream5";
    channel.models = ["seedream5"];
    await api.createCanvasImageTask(config, "调整光线", [{ ...reference, dataUrl: inlineImage }], { nodeId: "node-seedream" });
    assert.equal(calls[0].url, "/api/v1/canvas/image-tasks");
    const task = JSON.parse(calls[0].body);
    assert.equal(task.endpoint, "/images/generations");
    assert.equal(task.nodeId, "node-seedream");
    assert.deepEqual(task.request.image, [inlineImage]);
});
