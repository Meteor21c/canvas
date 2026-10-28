import type { MeteorCapabilities, MeteorUploadPolicy } from "@/types/meteor-pricing";

export const SITE_REFERENCE_UPLOADS: MeteorUploadPolicy = {
    imageMaxBytes: 20 * 1024 * 1024, videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 20 * 1024 * 1024, totalReferenceMaxBytes: 100 * 1024 * 1024,
    policySource: "site", metadataRequired: true,
};
export const REFERENCE_UPLOAD_NOTICE = "图片≤20 MiB · 视频≤50 MiB · 音频≤20 MiB · 每次合计≤100 MiB";
type Material = { bytes?: number; durationMs?: number };
export type VideoMaterialSelection = {
    references?: Material[]; videoReferences?: Material[]; audioReferences?: Material[];
    firstFrame?: Material | null; lastFrame?: Material | null;
};

export function assertReferenceFileSize(file: Pick<Blob, "size" | "type">, policy = SITE_REFERENCE_UPLOADS) {
    const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : "";
    if (!kind) throw new Error("请选择图片、视频或音频文件");
    const limit = kind === "video" ? policy.videoMaxBytes : kind === "audio" ? policy.audioMaxBytes : policy.imageMaxBytes;
    const name = kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
    if (file.size > limit) throw new Error(name + "不能超过" + limit / 1024 / 1024 + " MiB");
}

export async function inspectReferenceFile(file: Blob, capabilities?: MeteorCapabilities): Promise<Material> {
    assertReferenceFileSize(file, capabilities?.uploads);
    const kind = file.type.split("/")[0];
    const policy = capabilities?.videoInput;
    if (policy && !policy.referenceTypes.includes(kind)) throw new Error("当前模型不支持这种参考素材");
    if (kind !== "video" && kind !== "audio") return { bytes: file.size };
    const durationMs = await new Promise<number>((resolve, reject) => {
        const media = document.createElement(kind);
        const url = URL.createObjectURL(file);
        const finish = (error?: Error) => {
            clearTimeout(timer);
            const seconds = media.duration;
            media.onloadedmetadata = null; media.onerror = null;
            media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url);
            if (error) reject(error);
            else if (!Number.isFinite(seconds) || seconds <= 0) reject(new Error("无法读取素材时长，请转换为MP4、MP3或WAV后上传"));
            else resolve(seconds * 1000);
        };
        const timer = setTimeout(() => finish(new Error("读取素材时长超时，请检查文件")), 8000);
        media.preload = "metadata";
        media.onloadedmetadata = () => finish();
        media.onerror = () => finish(new Error("无法读取素材，请检查文件格式"));
        media.src = url;
    });
    const bounds = policy?.referenceDuration;
    if (bounds && (durationMs < bounds.min * 1000 || durationMs > bounds.max * 1000 + 50)) throw new Error(`参考视频、音频须为${bounds.min}–${bounds.max}秒`);
    return { bytes: file.size, durationMs };
}

export function videoInputError(capabilities: MeteorCapabilities | undefined, input: VideoMaterialSelection, generateAudio = false): string {
    const policy = capabilities?.videoInput;
    const uploads = capabilities?.uploads || SITE_REFERENCE_UPLOADS;
    const images = input.references || [], videos = input.videoReferences || [], audios = input.audioReferences || [];
    const frames = [input.firstFrame, input.lastFrame].filter((item): item is Material => Boolean(item));
    const all = [...images, ...videos, ...audios, ...frames];
    for (const [items, limit, name] of [[images.concat(frames), uploads.imageMaxBytes, "图片"], [videos, uploads.videoMaxBytes, "视频"], [audios, uploads.audioMaxBytes, "音频"]] as const) {
        if (items.some(item => typeof item.bytes === "number" && item.bytes > limit)) return name + "超过本站单文件大小限制";
    }
    if (all.reduce((total, item) => total + (item.bytes || 0), 0) > uploads.totalReferenceMaxBytes) return "单次参考素材总大小不能超过100 MiB";
    if (!policy) return all.length > (capabilities?.maxReferences || 4) ? "单次素材最多4个" : "";
    if (input.firstFrame && !policy.firstFrame) return "当前模型不支持首帧";
    if (input.lastFrame && !policy.lastFrame) return "当前模型不支持尾帧";
    if (input.lastFrame && !input.firstFrame && policy.lastFrameRequiresFirst) return "尾帧需要同时提供首帧";
    if (frames.length && images.length + videos.length + audios.length && !policy.framesWithReferences) return "请选择首尾帧或参考素材其中一种输入方式";
    const limits = policy.referenceLimits;
    if (images.length > limits.images || videos.length > limits.videos || audios.length > limits.audios) return `当前模型最多支持${limits.images}张参考图、${limits.videos}段参考视频、${limits.audios}段参考音频`;
    if (all.length > limits.total) return `单次素材最多${limits.total}个`;
    if (audios.length && !images.length && !videos.length && !policy.audioOnlyReferences) return "音频参考需要搭配图片或视频";
    if (videos.length && generateAudio && !policy.referenceVideoWithGeneratedAudio) return "使用参考视频时，请关闭生成音频";
    if (policy.referenceDuration) {
        const bounds = policy.referenceDuration;
        if ([...videos, ...audios].some(item => typeof item.durationMs === "number" && (item.durationMs < bounds.min * 1000 || item.durationMs > bounds.max * 1000 + 50))) return `参考视频、音频须为${bounds.min}–${bounds.max}秒`;
    }
    return "";
}

export function referenceAccept(capabilities?: MeteorCapabilities) {
    const types = capabilities?.videoInput?.referenceTypes || ["image", "video", "audio"];
    return types.flatMap(type => type === "video" ? ["video/mp4", "video/quicktime"] : type === "audio" ? ["audio/mpeg", "audio/wav", ".mp3", ".wav"] : ["image/*"]).join(",");
}
