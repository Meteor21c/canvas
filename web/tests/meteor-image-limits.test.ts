import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createCanvasImageTask, normalizeQuality } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
import { imageResolutionSelection, imageSizeAllowed, imageSizeTier, migrateImageSettings, resolveImageRequestSize } from "../src/lib/image-resolution";
import { pricingInputFromConfig } from "../src/lib/meteor-pricing";
import { useUserStore } from "../src/stores/use-user-store";
import { normalizeCanvasAgentAction } from "../src/app/(user)/canvas/agent/canvas-agent-tools";

const config = { ...defaultConfig, channelMode: "remote" as const, model: "gpt-image-2", imageModel: "gpt-image-2", imageChannelId: "meteor-test", activeChannelId: "meteor-test", quality: "high", count: "1", apiMode: "responses" as const, codexCli: "old-token" };
const originalUser = useUserStore.getState();
afterEach(() => { mock.restore(); useUserStore.setState(originalUser); });

test("legacy image mode cannot replace Images or strip quality", async () => {
    useUserStore.setState({ token: "mock-image-owner", hydrateUser: async () => {} });
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { id: "mock-task", status: "processing" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await createCanvasImageTask(config, "mock", []);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/studio/api/v1/canvas/image-tasks");
    const body = JSON.parse(String(init?.body));
    expect(body.endpoint).toBe("/images/generations");
    expect(body.request.quality).toBe("high");
    expect(body.request.prompt).toBe("mock");
});

test("image count and references reject before any network request", async () => {
    const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    for (const count of ["0", "5", "1.5"]) await expect(createCanvasImageTask({ ...config, count }, "mock", [])).rejects.toThrow("最多生成 4 张");
    await expect(createCanvasImageTask({ ...config, seedCount: 5 }, "mock", [])).rejects.toThrow("最多生成 4 张");
    const refs = Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: "mock.png", type: "image/png", dataUrl: "" }));
    await expect(createCanvasImageTask(config, "mock", refs)).rejects.toThrow("参考图最多 4 张");
    expect(request).not.toHaveBeenCalled();
});

test("Canvas agent rejects image batches above four", () => {
    for (const name of ["generate_image", "edit_image"]) {
        expect(() => normalizeCanvasAgentAction(name, { prompt: "mock", sourceNodeIds: ["image-ref"], count: 5 })).toThrow();
        expect(normalizeCanvasAgentAction(name, { prompt: "mock", sourceNodeIds: ["image-ref"], count: 4 }).arguments.count).toBe(4);
    }
    expect(() => normalizeCanvasAgentAction("generate_video", { prompt: "mock", sourceNodeIds: [], seconds: -1 })).toThrow();
});

test("quality and resolution independently control Images requests and the quote", async () => {
    useUserStore.setState({ token: "mock-image-owner", hydrateUser: async () => {} });
    const request = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { id: "mock-task", status: "processing" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    for (const resolution of ["2k", "4k"]) {
        for (const quality of ["low", "medium", "high"]) {
            const selected = { ...config, quality, imageResolution: resolution, size: "16:9" };
            const quote = pricingInputFromConfig(selected, "image");
            await createCanvasImageTask(selected, "mock", []);
            const body = JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body));
            expect(body.request.quality).toBe(quality);
            expect(body.request.size).toBe(resolution === "2k" ? "2048x1152" : "3840x2160");
            expect(quote.size).toBe(body.request.size);
            expect(quote.resolution).toBe(resolution);
            expect(quote.quality).toBe(quality);
        }
    }
});

test("image size tiers match actual longest-edge billing and valid model bounds", () => {
    expect(resolveImageRequestSize("1k", "1:1")).toBe("1024x1024");
    expect(resolveImageRequestSize("2k", "auto")).toBe("2048x2048");
    expect(resolveImageRequestSize("2k", "16:9")).toBe("2048x1152");
    expect(resolveImageRequestSize("4k", "1:1")).toBe("2880x2880");
    expect(imageSizeAllowed("gpt-image-2", "4096x4096")).toBe(false);
    expect(imageSizeAllowed("gpt-image-2", "1024x576")).toBe(false);
    expect(imageSizeAllowed("gpt-image-2", "3840x2160")).toBe(true);
    for (const [size, tier] of [["1024x768", "1k"], ["1280x768", "2k"], ["2048x2048", "2k"], ["2560x1600", "4k"]]) {
        expect(imageSizeTier(size)).toBe(tier);
        expect(pricingInputFromConfig({ ...config, size, imageResolution: "1k" }, "image").resolution).toBe(tier);
    }
    expect(imageResolutionSelection("gpt-image-2", "2k", "3840x2160")).toEqual({ imageResolution: "2k", size: "16:9" });
    expect(imageResolutionSelection("gpt-image-2", "1k", "16:9")).toEqual({ imageResolution: "1k", size: "1:1" });
});

test("legacy tier-valued quality migrates without reinterpreting real quality", () => {
    const oldTier = migrateImageSettings({ quality: "2k" });
    expect(oldTier.imageResolution).toBe("2k");
    expect(oldTier.quality).toBe("auto");
    const oldQuality = migrateImageSettings({ quality: "high", size: "3840x2160" });
    expect(oldQuality.quality).toBe("high");
    expect(oldQuality.imageResolution).toBe("4k");
    expect(normalizeQuality("4k")).toBe("auto");
});

test("invalid image size rejects before any network request", async () => {
    const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    await expect(createCanvasImageTask({ ...config, size: "4096x4096" }, "mock", [])).rejects.toThrow("当前尺寸不受此模型支持");
    expect(request).not.toHaveBeenCalled();
});
