export const GIF_ANIMATION_INSTRUCTION = "Create a looping animated GIF with multiple distinct frames showing the requested motion. Return the animated GIF file itself, not a static image or a sprite sheet.";

export function imageOutputWarning(requestedFormat?: string, mimeType?: string) {
    if (requestedFormat !== "gif" || !mimeType || mimeType === "image/gif") return "";
    const format = mimeType.replace(/^image\//, "").toUpperCase();
    return `未返回 GIF 动图，已保留 ${format} 原图。`;
}
