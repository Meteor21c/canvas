import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// All HTTP is mocked: these tests cannot create paid generation tasks.
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const storage = new Map<string, string>();
const media = new Map<string, { blob: Blob; expires: number }>();
const configState: { config: any } = { config: {} };
const state: any = {
    token: "", user: null,
    setSession(token: string, user: any) { state.token = token; state.user = user; },
    clearSession() { state.token = ""; state.user = null; },
    async hydrateUser() {},
};
let fixtures: any;
let requests: Array<{ url: string; init?: RequestInit }> = [];
let generation: (url: string, init?: RequestInit) => Promise<Response>;
mock.module("@/stores/use-user-store", () => ({ useUserStore: { getState: () => state } }));
mock.module("@/stores/use-config-store", () => ({
    defaultConfig: {},
    useConfigStore: { setState: (patch: any) => Object.assign(configState, patch) },
    channelIdForActiveModel: (config: any) => config.imageChannelId,
    modelMatchesCapability: (model: string) => /image|imagen/.test(model),
}));
mock.module("@/services/api/auth", () => ({ fetchCurrentUser: async () => fixtures.user }));
mock.module("@/services/api/request", () => ({ apiGet: async (url: string) => {
    if (url === "/api/v1/canvas/access") return { allowed: fixtures.allowed };
    if (url === "/api/v1/groups/available") return fixtures.groups;
    if (url === "/api/v1/groups/rates") return fixtures.rates;
    if (url === "/api/v1/keys") return { items: fixtures.keys, total: fixtures.keys.length };
    throw new Error(`unexpected API ${url}`);
} }));
mock.module("localforage", () => ({ default: { createInstance: () => ({
    async iterate(fn: (value: any, key: string) => void) { for (const [key, value] of media) fn(value, key); },
    async getItem(key: string) { return media.get(key) || null; },
    async setItem(key: string, value: any) { media.set(key, value); return value; },
    async removeItem(key: string) { media.delete(key); },
}) } }));
mock.module("@/services/image-storage", () => ({
    imageToDataUrl: async (image: any) => image.dataUrl || image.url,
    uploadImage: async () => ({ url: "blob:https://api.meteor21c.fun/example", storageKey: "image:test", width: 1024, height: 1024, bytes: 10, mimeType: "image/png" }),
}));
const gateway = await import("../src/services/api/meteor-gateway");
const images = await import("../src/services/api/image");
const cache = await import("../src/services/meteor-media-cache");

beforeEach(async () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { origin: "https://api.meteor21c.fun" },
        localStorage: { getItem: (key: string) => storage.get(key) || null },
    } });
    gateway.clearMeteorCanvasSession(); media.clear(); requests = [];
    storage.set("auth_token", `session-${Math.random()}`);
    fixtures = {
        allowed: true,
        user: { id: "1", role: "admin" },
        groups: [{ id: 2, name: "images", platform: "openai", status: "active", allow_image_generation: true, rate_multiplier: 1, image_price_1k: 0.2, image_price_2k: 0.5, image_price_4k: 1 }],
        rates: { "2": 0.5 },
        keys: [{ id: 3, user_id: 1, group_id: 2, name: "own-key", key: "test-secret-never-persist", status: "active", quota: 10, quota_used: 0 }],
    };
    generation = async () => Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input); requests.push({ url, init });
        if (url === "/v1/models") return Response.json({ data: [{ id: "gpt-image-2" }, { id: "gpt-text" }] });
        return generation(url, init);
    }) as typeof fetch;
    await gateway.initializeMeteorCanvas();
    requests = [];
});
afterAll(() => { globalThis.fetch = originalFetch; Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); mock.restore(); });
const config = () => ({ ...configState.config });

describe("owner and model permissions", () => {
    test("only active owned image keys are offered; credentials never enter config", async () => {
        fixtures.keys.push({ ...fixtures.keys[0], id: 4, user_id: 99 }, { ...fixtures.keys[0], id: 5, expires_at: "2000-01-01T00:00:00Z" }, { ...fixtures.keys[0], id: 6, quota_used: 10 });
        await gateway.initializeMeteorCanvas();
        expect(config().localChannels.map((channel: any) => channel.id)).toEqual(["3"]);
        expect(config().imageModels).toEqual(["gpt-image-2"]);
        expect(JSON.stringify(config())).not.toContain("test-secret-never-persist");
        expect(gateway.meteorImageAuthorization(config())).toBe("Bearer test-secret-never-persist");
        expect(() => gateway.meteorImageAuthorization({ ...config(), model: "gpt-text" })).toThrow("请选择当前密钥可用");
        expect(() => gateway.meteorImageAuthorization({ ...config(), imageChannelId: "999" })).toThrow("请选择当前密钥可用");
    });
    test("non-owner and changed login cannot use a retained key", async () => {
        fixtures.allowed = false;
        await expect(gateway.initializeMeteorCanvas()).rejects.toThrow("仅限站主");
        expect(() => gateway.meteorImageAuthorization(config())).toThrow();
        fixtures.allowed = true; await gateway.initializeMeteorCanvas();
        storage.set("auth_token", "different-session");
        expect(() => gateway.meteorImageAuthorization(config())).toThrow("登录状态已变化");
    });
    test("tier, ratio and quote use the selected model and group price", () => {
        expect(gateway.meteorImageSize(config())).toBe("1024x1024");
        expect(gateway.meteorImageSize({ ...config(), quality: "medium", size: "16:9" })).toBe("2048x1152");
        expect(() => gateway.meteorImageSize({ ...config(), quality: "high", size: "1:1" })).toThrow("不支持当前比例");
        expect(gateway.getMeteorImageQuote(config())).toContain("$0.1/张");
        expect(gateway.getMeteorImageQuote({ ...config(), model: "invalid", imageModel: "gpt-image-2" })).toContain("请选择");
    });
});

describe("manual paid request boundary", () => {
    test("one image only, same-origin endpoint and exact parameters", async () => {
        await images.requestGeneration({ ...config(), count: "9", canvasImageCount: "10" }, "a test image");
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("/v1/images/generations");
        expect(JSON.parse(String(requests[0].init?.body))).toEqual({ model: "gpt-image-2", prompt: "a test image", n: 1, response_format: "b64_json", size: "1024x1024" });
    });
    test("attempt limit retains uncertain ids instead of allowing an evicted replay", async () => {
        for (let index = 0; index < 128; index++) {
            await images.createCanvasImageTask(config(), "test", [], { clientTaskId: `limit-${index}` });
        }
        await expect(images.createCanvasImageTask(config(), "test", [], { clientTaskId: "limit-new" })).rejects.toThrow("128 次请求上限");
        await images.createCanvasImageTask(config(), "test", [], { clientTaskId: "limit-0" });
        expect(requests).toHaveLength(128);
    });
    test("reference bytes are bounded before any paid POST", async () => {
        generation = async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } });
        await expect(images.requestEdit(config(), "test", [{ url: "https://img.meteor21c.fun/reference.png" }] as any)).rejects.toThrow("单张参考图最多 10 MB");
        expect(requests.filter(item => item.init?.method === "POST")).toHaveLength(0);
    });
    test("invalid prompt and too many references do not submit", async () => {
        await expect(images.requestGeneration(config(), "")).rejects.toThrow("提示词不能为空");
        await expect(images.requestEdit(config(), "test", Array.from({ length: 5 }, () => ({ url: "data:image/png;base64,AA==" })) as any)).rejects.toThrow("参考图最多");
        expect(requests).toHaveLength(0);
    });
    test("unknown network result is never retried, including duplicate task id", async () => {
        generation = async () => { throw new Error("connection lost"); };
        await expect(images.createCanvasImageTask(config(), "test", [], { clientTaskId: "uncertain" })).rejects.toThrow("不会自动重试");
        await expect(images.createCanvasImageTask(config(), "test", [], { clientTaskId: "uncertain" })).rejects.toThrow("不会自动重试");
        expect(requests).toHaveLength(1);
        storage.set("auth_token", "changed");
        await expect(images.createCanvasImageTask(config(), "test", [], { clientTaskId: "uncertain" })).rejects.toThrow("登录状态已变化");
        expect(requests).toHaveLength(1);
    });
});

describe("media URL and local cache limits", () => {
    test("blocks arbitrary APIs, executable formats and unrelated outbound URLs", () => {
        for (const value of ["/api/v1/keys", "/api/v1/auth/me", "/admin", "https://evil.example/a.png", "https://img.meteor21c.fun:8080/a.png", "http://img.meteor21c.fun/a.png", "https://u:p@img.meteor21c.fun/a.png", "data:image/svg+xml;base64,PHN2Zz4="]) {
            expect(() => cache.safeMediaUrl(value)).toThrow();
        }
        expect(cache.safeMediaUrl("/v1/images/content/abc")).toBe("https://api.meteor21c.fun/v1/images/content/abc");
        expect(cache.safeMediaUrl("https://img.meteor21c.fun/a.png")).toBe("https://img.meteor21c.fun/a.png");
    });
    test("remote fetch has no cookies, no referrer and refuses redirect", async () => {
        generation = async (_url, init) => {
            expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error"); expect(init?.referrerPolicy).toBe("no-referrer");
            return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } });
        };
        expect((await cache.readMedia("https://img.meteor21c.fun/a.png")).size).toBe(1);
        generation = async () => new Response("<html>", { headers: { "Content-Type": "text/html" } });
        await expect(cache.readMedia("https://img.meteor21c.fun/a.png")).rejects.toThrow("仅支持");
    });
    test("cache is owner scoped, expires and serializes count limits", async () => {
        const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
        await cache.putMedia("image:a", blob);
        state.user = { id: "2", role: "admin" };
        expect(await cache.getMedia("image:a")).toBeNull();
        state.user = { id: "1", role: "admin" };
        const expiredObjectUrl = await cache.mediaObjectUrl("image:a");
        const record = media.get("1:image:a")!; record.expires = Date.now() - 1;
        expect(await cache.getMedia("image:a")).toBeNull();
        expect(() => cache.safeMediaUrl(expiredObjectUrl)).toThrow("引用已过期");
        expect(media.has("1:image:a")).toBe(false);
        const outcomes = await Promise.allSettled(Array.from({ length: 129 }, (_, index) => cache.putMedia(`image:${index}`, blob)));
        expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(128);
        expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(1);
        expect(media.size).toBe(128);
    });
    test("empty, overlarge and executable blob types are rejected", async () => {
        await expect(cache.putMedia("image:empty", new Blob([], { type: "image/png" }))).rejects.toThrow();
        await expect(cache.putMedia("image:html", new Blob(["<html>"], { type: "text/html" }))).rejects.toThrow();
        await expect(cache.readMedia(new Blob([new Uint8Array(cache.MAX_MEDIA_BYTES + 1)], { type: "image/png" }))).rejects.toThrow("超过");
        expect(media.size).toBe(0);
    });
});
