import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "../export-types";
import { safeCanvasProject, type CanvasProject } from "../stores/use-canvas-store";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无限画布") {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const assets = new Map<string, CanvasExportAsset>();
    const keys = [...new Set(projects.flatMap(project => collectStorageKeys(project)))];
    if (projects.length > 20 || keys.length > 128) throw new Error("单次导出最多 20 个工程和 128 张图片");
    let bytes = 0;
    for (const storageKey of keys) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) continue;
        bytes += blob.size;
        if (bytes > 128 * 1024 * 1024) throw new Error("导出图片超过 128 MiB，请分批导出");
        const path = `media/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
        assets.set(storageKey, { storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
        zipFiles.push({ name: path, data: blob });
    }
    const missing = keys.length - assets.size;
    const exportedProjects = projects.map(project => ({ project: safeCanvasProject(project), files: collectStorageKeys(project).map(key => assets.get(key)).filter((asset): asset is CanvasExportAsset => Boolean(asset)) }));
    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const note = `流星创作画布导出\n\n本包仅包含当前浏览器可读取的图片。工程元数据不包含 API 密钥或临时签名链接。\n图片临时缓存保留 24 小时。\n本次已失效或不在当前浏览器的图片引用：${missing} 个。\n`;
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, { name: "export-info.txt", data: note }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
    if (missing) window.dispatchEvent(new CustomEvent("meteor-canvas:export-warning", { detail: `已导出工程；${missing} 个图片引用已过期或不在当前浏览器，包内 export-info.txt 已记录。` }));
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
