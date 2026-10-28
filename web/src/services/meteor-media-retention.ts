"use client";

import localforage from "localforage";
import { useUserStore } from "@/stores/use-user-store";

const cache = localforage.createInstance({ name: "meteor-canvas-v082", storeName: "media" });
const legacy = localforage.createInstance({ name: "meteor-canvas-pilot", storeName: "media" });
const TTL = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OWNER_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 256;
type Entry = { blob: Blob; expires: number; kind: string };
const urls = new Map<string, { url: string; expires: number }>();
let pending: Promise<unknown> = Promise.resolve();

function owner() {
    const state = useUserStore.getState();
    if (!state.token || !state.user) throw new Error("请先登录流星 API 主站");
    return String(state.user.id);
}
function scoped(key: string, account = owner()) { return `${account}:${key}`; }
function checkAccount(account: string) { if (owner() !== account) throw new Error("登录账号已变化，请重新打开画布"); }
function revoke(key: string) {
    const row = urls.get(key);
    if (row) URL.revokeObjectURL(row.url);
    urls.delete(key);
}

export function clearMeteorMediaSession() {
    for (const key of urls.keys()) revoke(key);
}

export async function cleanupMeteorMedia() {
    const expired: string[] = [];
    await cache.iterate<Entry, void>((entry, key) => { if (!entry?.expires || entry.expires <= Date.now()) expired.push(key); });
    for (const key of expired) { await cache.removeItem(key); revoke(key); }
    for (const [key, row] of urls) if (row.expires <= Date.now()) revoke(key);
}

export function meteorObjectUrl(key: string, blob: Blob) {
    const id = scoped(key);
    const row = urls.get(id);
    if (row && row.expires > Date.now()) return row.url;
    revoke(id);
    const url = URL.createObjectURL(blob);
    urls.set(id, { url, expires: Date.now() + TTL });
    return url;
}

async function checkQuota(account: string, target: string, blob: Blob) {
    let bytes = 0, count = 0;
    await cache.iterate<Entry, void>((entry, id) => {
        if (id.startsWith(`${account}:`) && id !== target && entry.expires > Date.now()) { bytes += entry.blob.size; count++; }
    });
    if (bytes + blob.size > MAX_OWNER_BYTES || count >= MAX_FILES) throw new Error("浏览器媒体缓存已达到 256 MiB / 256 个上限，请先导出并删除不用的素材，或等待 24 小时清理");
}

export function createMeteorMediaStore(kind: "image" | "media") {
    return {
        async setItem<T extends Blob>(key: string, blob: T): Promise<T> {
            const account = owner();
            const operation = pending.catch(() => undefined).then(async () => {
                checkAccount(account);
                if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_FILE_BYTES) throw new Error("单个媒体文件须小于 64 MiB");
                await cleanupMeteorMedia();
                const target = scoped(key, account);
                await checkQuota(account, target, blob);
                checkAccount(account);
                await cache.setItem<Entry>(target, { blob, expires: Date.now() + TTL, kind });
                revoke(target);
            });
            pending = operation;
            await operation;
            return blob;
        },
        async getItem<T = Blob>(key: string): Promise<T | null> {
            const account = owner(), target = scoped(key, account);
            let entry = await cache.getItem<Entry>(target);
            checkAccount(account);
            // Read the previous trial's account-scoped cache without extending retention or deleting it.
            if (!entry && kind === "image") {
                const previousOwner = account.replace(/^meteor_user_/, "");
                const previous = await legacy.getItem<{ blob: Blob; expires: number }>(`${previousOwner}:${key}`);
                checkAccount(account);
                if (previous?.blob instanceof Blob && previous.expires > Date.now() && previous.blob.size <= MAX_FILE_BYTES) {
                    entry = { ...previous, kind };
                    const copy = pending.catch(() => undefined).then(async () => {
                        checkAccount(account);
                        await cleanupMeteorMedia();
                        await checkQuota(account, target, previous.blob);
                        await cache.setItem(target, entry);
                    });
                    pending = copy;
                    await copy;
                }
            }
            if (!entry) return null;
            if (entry.expires <= Date.now()) { await cache.removeItem(target); revoke(target); return null; }
            return entry.blob as T;
        },
        async removeItem(key: string) { const target = scoped(key); await cache.removeItem(target); revoke(target); },
        async iterate(iterator: (value: Blob, key: string) => void) {
            const account = owner();
            await cleanupMeteorMedia();
            await cache.iterate<Entry, void>((entry, id) => {
                if (id.startsWith(`${account}:`) && entry.kind === kind) iterator(entry.blob, id.slice(account.length + 1));
            });
        },
    };
}
