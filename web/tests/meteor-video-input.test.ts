import { expect, test } from "bun:test";
import { assertReferenceFileSize, referenceAccept, SITE_REFERENCE_UPLOADS, videoInputError } from "../src/lib/meteor-video-input";
import type { MeteorCapabilities } from "../src/types/meteor-pricing";

const caps = {
    available: true, maxReferences: 4, uploads: SITE_REFERENCE_UPLOADS,
    videoInput: { modes: ["text", "frames", "reference"], referenceTypes: ["image", "video", "audio"],
        firstFrame: true, lastFrame: true, lastFrameRequiresFirst: true, framesWithReferences: false,
        audioOnlyReferences: false, referenceVideoWithGeneratedAudio: true,
        referenceLimits: { images: 4, videos: 3, audios: 3, total: 4 }, referenceDuration: { min: 2, max: 15 } },
} as MeteorCapabilities;
const image = { bytes: 1024 }, clip = { bytes: 2048, durationMs: 3000 };

test("reference sizes reject before reading or uploading the payload", () => {
    for (const [type, size] of [["image/png", 20], ["video/mp4", 50], ["audio/mpeg", 20]] as const) {
        expect(() => assertReferenceFileSize({ type, size: size * 1024 * 1024 })).not.toThrow();
        expect(() => assertReferenceFileSize({ type, size: size * 1024 * 1024 + 1 })).toThrow("MiB");
    }
    expect(() => assertReferenceFileSize({ type: "text/html", size: 2 })).toThrow();
});

test("video role limits apply to the original selection without dropping materials", () => {
    expect(videoInputError(caps, { firstFrame: image, lastFrame: image })).toBe("");
    expect(videoInputError(caps, { lastFrame: image })).toContain("首帧");
    expect(videoInputError(caps, { firstFrame: image, references: [image] })).toContain("其中一种");
    expect(videoInputError(caps, { references: [image], videoReferences: [clip], audioReferences: [clip] })).toBe("");
    expect(videoInputError(caps, { audioReferences: [clip] })).toContain("搭配");
    expect(videoInputError(caps, { videoReferences: [clip, clip, clip, clip] })).toContain("最多支持");
    expect(videoInputError(caps, { references: [image, image, image], videoReferences: [clip, clip] })).toContain("最多4");
    expect(videoInputError(caps, { videoReferences: [{ ...clip, durationMs: 16000 }] })).toContain("2–15");
});

test("per-model capabilities allow audio-only or disallow generated audio with reference video", () => {
    const audioOnly = { ...caps, videoInput: { ...caps.videoInput!, audioOnlyReferences: true, referenceDuration: { min: 2, max: 30 } } };
    expect(videoInputError(audioOnly, { audioReferences: [{ ...clip, durationMs: 28000 }] })).toBe("");
    const omni = { ...caps, videoInput: { ...caps.videoInput!, referenceVideoWithGeneratedAudio: false, referenceTypes: ["image", "video"], referenceLimits: { images: 4, videos: 4, audios: 0, total: 4 } } };
    expect(videoInputError(omni, { videoReferences: [clip] }, true)).toContain("关闭生成音频");
    expect(videoInputError(omni, { videoReferences: [clip] }, false)).toBe("");
    expect(referenceAccept(omni)).not.toContain("audio");
    const frames = { ...caps, videoInput: { ...caps.videoInput!, referenceTypes: [], referenceLimits: { images: 0, videos: 0, audios: 0, total: 4 } } };
    expect(videoInputError(frames, { references: [image] })).toContain("最多支持");
    expect(videoInputError(frames, { firstFrame: image })).toBe("");
});

test("aggregate budgets use bytes as well as counts", () => {
    const generous = { ...caps, videoInput: { ...caps.videoInput!, referenceLimits: { images: 4, videos: 4, audios: 4, total: 4 } } };
    expect(videoInputError(generous, { videoReferences: Array.from({ length: 3 }, () => ({ bytes: 40 * 1024 * 1024, durationMs: 5000 })) })).toContain("100 MiB");
});
