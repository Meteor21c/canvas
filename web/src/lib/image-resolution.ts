export const imageResolutionOptions = [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];

export function normalizeImageResolution(value?: string) {
    const resolution = value?.trim().toLowerCase();
    return resolution === "2k" || resolution === "4k" ? resolution : "1k";
}

export function migrateImageSettings(config: { quality?: string; imageResolution?: string; size?: string }) {
    const legacyResolution = /^[124]k$/i.test(config.quality || "") ? config.quality!.toLowerCase() : undefined;
    return { quality: legacyResolution ? "auto" : config.quality || "auto", imageResolution: imageSizeTier(config.size) || normalizeImageResolution(config.imageResolution || legacyResolution) };
}

export function imageSizeTier(size?: string) {
    const match = size?.trim().match(/^(\d+)x(\d+)$/i);
    if (!match) return undefined;
    const edge = Math.max(Number(match[1]), Number(match[2]));
    return edge > 2048 ? "4k" : edge > 1024 ? "2k" : "1k";
}

export function imageAspectRatio(size: string) {
    if (!size.trim() || size.trim().toLowerCase() === "auto") return "1:1";
    const match = size.trim().match(/^(\d+)x(\d+)$/i);
    if (!match) return size;
    const ratio = Number(match[1]) / Number(match[2]);
    const presets = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
    const matching = presets.find(preset => { const [w, h] = preset.split(":").map(Number); return Math.abs(w / h - ratio) / ratio < 0.025; });
    if (matching) return matching;
    let a = Number(match[1]), b = Number(match[2]);
    while (b) [a, b] = [b, a % b];
    return a > 0 ? `${Number(match[1]) / a}:${Number(match[2]) / a}` : "1:1";
}

export function resolveImageRequestSize(resolution: string | undefined, size: string) {
    const selected = size.trim().toLowerCase();
    const value = !selected || selected === "auto" ? "1:1" : selected;
    if (/^\d+x\d+$/.test(value)) return value;
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const widthRatio = Number(match[1]), heightRatio = Number(match[2]);
    if (widthRatio <= 0 || heightRatio <= 0) return undefined;
    const ratio = widthRatio / heightRatio;
    const tier = normalizeImageResolution(resolution);
    const edge = tier === "4k" ? 3840 : tier === "2k" ? 2048 : 1024;
    const limit = tier === "4k" ? 8294400 : edge * edge;
    const width = Math.min(ratio >= 1 ? edge : edge * ratio, Math.sqrt(limit * ratio));
    const height = width / ratio;
    return `${Math.max(16, Math.floor(width / 16) * 16)}x${Math.max(16, Math.floor(height / 16) * 16)}`;
}

export function imageSizeAllowed(model: string, size?: string) {
    if (!/^gpt[-_]image[-_]2/i.test(model) || !size) return true;
    const match = size.match(/^(\d+)x(\d+)$/i);
    if (!match) return false;
    const width = Number(match[1]), height = Number(match[2]);
    const pixels = width * height;
    return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 && Math.max(width / height, height / width) <= 3 && pixels >= 655360 && pixels <= 8294400;
}

export function imageResolutionSelection(model: string, resolution: string, size: string) {
    const ratio = imageAspectRatio(size);
    return { imageResolution: normalizeImageResolution(resolution), size: imageSizeAllowed(model, resolveImageRequestSize(resolution, ratio)) ? ratio : "1:1" };
}
