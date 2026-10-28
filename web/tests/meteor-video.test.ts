import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as images from "../src/services/image-storage";
import * as media from "../src/services/file-storage";
import * as requests from "../src/services/api/request";
import { createVideoRequestBody, type VideoReferenceInput } from "../src/services/api/video";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const origin = "https://api.meteor21c.fun";
const model = "doubao-seedance-2.0";
const config: AiConfig = {
    ...defaultConfig, channelMode: "remote", model, videoModel: model,
    videoChannelId: "meteor-video", activeChannelId: "meteor-video",
    publicChannels: [{ id: "meteor-video", name: "本站视频", protocol: "sub2api", models: [model] }],
    videoSeconds: "30", vquality: "4K", size: "16:9", videoMode: "pro", videoGenerateAudio: "true",
};
const image = (key: string) => ({ id: key, name: key, type: "image/png", storageKey: key, dataUrl: "" });
const clip = (key: string, type: string) => ({ id: key, name: key, type, storageKey: key, url: "" });
const input = (overrides: VideoReferenceInput = {}): Required<VideoReferenceInput> => ({ references: [], videoReferences: [], audioReferences: [], firstFrame: null, lastFrame: null, ...overrides });

beforeEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
    spyOn(images, "resolveImageUrl").mockImplementation(async key => `/studio/api/files/${key?.replace("server:", "")}/content?expires=123&signature=mock`);
    spyOn(media, "resolveMediaUrl").mockImplementation(async (key, fallback) => key?.startsWith("server:") ? `/studio/api/files/${key.slice(7)}/content?expires=123&signature=mock` : fallback || "blob:legacy-media");
});
afterEach(() => {
    mock.restore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("main-site video keeps 30s/4K and sends signed image, video, audio and frame references", async () => {
    const uploadImage = spyOn(images, "uploadImage").mockRejectedValue(new Error("server refs must not upload"));
    const uploadMedia = spyOn(media, "uploadMediaBlob").mockRejectedValue(new Error("server refs must not upload"));
    const body = await createVideoRequestBody(config, model, "mock prompt", input({
        references: [image("server:image")], firstFrame: image("server:first"), lastFrame: image("server:last"),
        videoReferences: [clip("server:video", "video/mp4")], audioReferences: [clip("server:audio", "audio/mpeg")],
    }));
    expect(body).not.toBeInstanceOf(FormData);
    expect(body).toMatchObject({ model, prompt: "mock prompt", duration: 30, resolution: "4k", aspect_ratio: "16:9", audio: true,
        reference_images: [
            `${origin}/studio/api/files/image/content?expires=123&signature=mock`,
            `video:${origin}/studio/api/files/video/content?expires=123&signature=mock`,
            `audio:${origin}/studio/api/files/audio/content?expires=123&signature=mock`,
        ],
        start_image_url: `${origin}/studio/api/files/first/content?expires=123&signature=mock`,
        end_image_url: `${origin}/studio/api/files/last/content?expires=123&signature=mock`,
    });
    expect(JSON.stringify(body)).not.toMatch(/data:|blob:/);
    expect(uploadImage).not.toHaveBeenCalled(); expect(uploadMedia).not.toHaveBeenCalled();
});

test("legacy local references are uploaded before video creation instead of sending blob/data URLs", async () => {
    spyOn(images, "imageToDataUrl").mockResolvedValue("data:image/png;base64,bW9jaw==");
    const imageUpload = spyOn(images, "uploadImage").mockResolvedValue({ storageKey: "server:uploaded-image" } as any);
    const mediaUpload = spyOn(media, "uploadMediaBlob").mockResolvedValue({ storageKey: "server:uploaded-media" } as any);
    const fetch = spyOn(requests, "studioFetch").mockResolvedValue(new Response(new Blob(["mock"], { type: "video/mp4" })));
    const body = await createVideoRequestBody(config, model, "mock", input({ references: [image("image:legacy")], videoReferences: [clip("media:legacy", "video/mp4")] }));
    expect(imageUpload).toHaveBeenCalledTimes(1); expect(mediaUpload).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ reference_images: [
        `${origin}/studio/api/files/uploaded-image/content?expires=123&signature=mock`,
        `video:${origin}/studio/api/files/uploaded-media/content?expires=123&signature=mock`,
    ] });
    expect(JSON.stringify(body)).not.toMatch(/data:|blob:/);
});

test("missing/unsynced references fail visibly rather than silently losing input", async () => {
    spyOn(images, "resolveImageUrl").mockResolvedValue("");
    await expect(createVideoRequestBody(config, model, "mock", input({ firstFrame: image("server:expired") }))).rejects.toThrow("参考图缓存已过期");
    spyOn(images, "imageToDataUrl").mockResolvedValue("data:image/png;base64,bW9jaw==");
    spyOn(images, "uploadImage").mockResolvedValue({ storageKey: "image:local-only" } as any);
    await expect(createVideoRequestBody(config, model, "mock", input({ references: [image("image:legacy")] }))).rejects.toThrow("参考图尚未同步到本站");
});
