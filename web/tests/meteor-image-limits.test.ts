import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createCanvasImageTask } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
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
