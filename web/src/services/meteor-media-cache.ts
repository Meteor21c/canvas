"use client";

import localforage from "localforage";
import { useUserStore } from "@/stores/use-user-store";

const cache = localforage.createInstance({ name: "meteor-canvas-pilot", storeName: "media" });
const urls = new Map<string, string>();
const TTL = 24 * 60 * 60 * 1000;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const OWNER_BYTES = 128 * 1024 * 1024;
type RecordValue = { blob: Blob; expires: number };
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export function mediaOwner() {
    const user = useUserStore.getState().user;
    if (!user || !useUserStore.getState().token) throw new Error("请先登录流星 API");
    return String(user.id);
}

function scoped(key: string, owner = mediaOwner()) { return `${owner}:${key}`; }
function checkOwner(owner: string) {
    if (mediaOwner() !== owner) throw new Error("登录账号已变化，请重新打开画布");
}

export function safeMediaUrl(value: string): string {
    if (/^blob:/.test(value)) {
        if (![...urls.values()].includes(value)) throw new Error("图片引用已过期，请重新上传");
        return value;
    }
    if (/^data:image\/(png|jpeg|webp|gif|avif);base64,/i.test(value)) {
        if (value.length > MAX_MEDIA_BYTES * 1.4) throw new Error("图片超过 20 MB");
        return value;
    }
    const url = new URL(value, window.location.origin);
    const sameOrigin = url.origin === window.location.origin;
    if (url.username || url.password || (!sameOrigin && url.port !== "" && url.port !== "443") || (!sameOrigin && (url.protocol !== "https:" || !["img.meteor21c.fun", "dl.meteor21c.fun"].includes(url.hostname)))) {
        throw new Error("试用画布仅接受本站图片；请下载图片后上传");
    }
    if (!sameOrigin || /^\/(?:v1\/images\/|api\/v1\/images\/|media\/|files\/)/.test(url.pathname)) return url.href;
    throw new Error("不是受支持的本站图片地址");
}

export async function readMedia(input: string | Blob): Promise<Blob> {
    let blob: Blob;
    if (typeof input !== "string") blob = input;
    else {
        const response = await fetch(safeMediaUrl(input), { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
        const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
        if (!imageTypes.has(type)) throw new Error("仅支持 PNG、JPEG、WebP、GIF、AVIF 图片");
        if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) throw new Error("图片超过 20 MB");
        if (!response.body) throw new Error("图片内容为空");
        const reader = response.body.getReader();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_MEDIA_BYTES) throw new Error("图片超过 20 MB");
                parts.push(new Uint8Array(value));
            }
        } finally { await reader.cancel().catch(() => undefined); }
        blob = new Blob(parts, { type });
    }
    if (!imageTypes.has(blob.type.toLowerCase()) || !blob.size || blob.size > MAX_MEDIA_BYTES) throw new Error("图片格式不支持、为空或超过 20 MB");
    return blob;
}

export async function cleanupExpiredMedia() {
    const owner = mediaOwner();
    const expired: string[] = [];
    await cache.iterate<RecordValue, void>((record, key) => {
        if (key.startsWith(`${owner}:`) && (!record?.expires || record.expires <= Date.now())) expired.push(key);
    });
    for (const key of expired) {
        checkOwner(owner);
        const url = urls.get(key);
        if (url) URL.revokeObjectURL(url);
        urls.delete(key);
        await cache.removeItem(key);
    }
}

// Serialize quota checks so concurrent imports cannot bypass the owner limit.
let pending: Promise<unknown> = Promise.resolve();
export function putMedia(key: string, blob: Blob): Promise<void> {
    const owner = mediaOwner();
    const operation = pending.catch(() => undefined).then(async () => {
        checkOwner(owner);
        await readMedia(blob);
        await cleanupExpiredMedia();
        let bytes = 0, count = 0;
        const target = scoped(key, owner);
        await cache.iterate<RecordValue, void>((record, storedKey) => {
            if (storedKey.startsWith(`${owner}:`) && storedKey !== target) { bytes += record.blob.size; count++; }
        });
        if (bytes + blob.size > OWNER_BYTES || count >= 128) throw new Error("本机画布图片缓存已达到 128 MB / 128 张上限，请导出或等待 24 小时清理");
        checkOwner(owner);
        await cache.setItem<RecordValue>(target, { blob, expires: Date.now() + TTL });
        const previous = urls.get(target);
        if (previous) URL.revokeObjectURL(previous);
        urls.delete(target);
    });
    pending = operation;
    return operation;
}

export async function getMedia(key: string): Promise<Blob | null> {
    const owner = mediaOwner(), target = scoped(key, owner);
    const record = await cache.getItem<RecordValue>(target);
    checkOwner(owner);
    if (!record || record.expires <= Date.now()) {
        if (record) await cache.removeItem(target);
        return null;
    }
    return record.blob;
}

export async function mediaObjectUrl(key: string) {
    const owner = mediaOwner(), target = scoped(key, owner);
    const blob = await getMedia(key);
    if (!blob) return "";
    checkOwner(owner);
    if (!urls.has(target)) urls.set(target, URL.createObjectURL(blob));
    return urls.get(target)!;
}

export function clearMediaSession() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
}

export function blobDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
