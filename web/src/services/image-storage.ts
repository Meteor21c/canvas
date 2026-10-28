"use client";
import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { useUserStore } from "@/stores/use-user-store";
import { blobDataUrl, getMedia, mediaObjectUrl, putMedia, readMedia, safeMediaUrl } from "./meteor-media-cache";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type UserStorageProviderBase = {
    enabled: boolean;
    name: string;
    endpoint: string;
};

export type UserS3StorageProvider = UserStorageProviderBase & {
    type: "s3";
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    pathPrefix: string;
};

export type UserWebDAVStorageProvider = UserStorageProviderBase & {
    type: "webdav";
    pathPrefix: string;
    username: string;
    password: string;
};

export type UserStorageProvider = UserS3StorageProvider | UserWebDAVStorageProvider;


export type StorageConfig = { mode: string; allowUserProvider: boolean; allowUserGlobalProvider: boolean; autoSyncAllAssets: boolean };
export const USER_STORAGE_PROVIDER_KEY = "meteor-canvas:disabled-s3";
export const USER_WEBDAV_STORAGE_PROVIDER_KEY = "meteor-canvas:disabled-webdav";
export const STORAGE_SYNC_FAILED_EVENT = "meteor-canvas:storage-error";
export const getProxyUrl = safeMediaUrl;
export const canUseGlobalStorage = (_config: StorageConfig) => false;
export async function loadStorageConfig(): Promise<StorageConfig> { return { mode: "local", allowUserProvider: false, allowUserGlobalProvider: false, autoSyncAllAssets: false }; }
export function clearStorageConfigCache() { }
export function clearAutoSyncCache(_key: string) { }
export async function autoSyncToCloud<T extends { storageKey: string }>(_source: string | Blob, _upload: () => Promise<T | null>): Promise<T | null> { return null; }

export async function uploadImage(input: string | Blob, _options: {localOnly?: boolean} = {}): Promise<UploadedImage> {
    const owner = useUserStore.getState().user?.id;
    const blob = await readMedia(input);
    const storageKey = `image:${nanoid()}`;
    if (!owner || useUserStore.getState().user?.id !== owner) throw new Error("登录账号已变化");
    await putMedia(storageKey, blob);
    const url = await mediaObjectUrl(storageKey);
    const meta = await new Promise<{width:number;height:number}>((resolve,reject) => {
        const image = new Image();
        const timer = setTimeout(() => reject(new Error("图片解码超时")),10000);
        image.onload = () => { clearTimeout(timer); resolve({width:image.naturalWidth,height:image.naturalHeight}); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("图片无法解码")); };
        image.src = url;
    });
    if (!meta.width || !meta.height || meta.width * meta.height > 33554432) throw new Error("图片无法解码或超过 3200 万像素");
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type };
}
export async function uploadRemoteImageToServer(url: string, _filename: string) { return uploadImage(url); }
export async function autoSyncImage(url: string, _resultId: string, storageKey?: string) { return storageKey ? null : uploadImage(url); }
export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (storageKey) return mediaObjectUrl(storageKey);
    if (!fallback || fallback.startsWith("blob:")) return "";
    try { return safeMediaUrl(fallback); } catch { return ""; }
}
export const getImageBlob = getMedia;
export const setImageBlob = putMedia;
export async function imageToDataUrl(image: {url?: string; dataUrl?: string; storageKey?: string}) {
    if (image.storageKey) {
        const blob = await getMedia(image.storageKey);
        if (!blob) throw new Error("参考图缓存已过期（保留 24 小时），请重新上传");
        return blobDataUrl(blob);
    }
    const url = image.dataUrl || image.url;
    if (!url) throw new Error("参考图已过期，请重新上传");
    return blobDataUrl(await readMedia(url));
}
export const imageToPublicUrl = imageToDataUrl;
// Removing a canvas node does not delete shared cached media. TTL handles reclamation.
export async function deleteStoredImages(_keys: Iterable<string>, _ownerToken?: string) { }
export async function cleanupUnusedImages(_used: unknown, _keys: ReadonlyMap<string,string> = new Map(), _token?: string) { }
export function collectImageStorageKeys(value: unknown, keys = new Set<string>(), knownUrls?: ReadonlyMap<string,string>, capturedUrls?: Map<string,string>): Set<string> {
    if (typeof value === "string") {
        if (value.startsWith("image:")) keys.add(value);
        const known = knownUrls?.get(value); if (known) keys.add(known);
    } else if (value && typeof value === "object") {
        const row = value as Record<string,unknown>;
        if (typeof row.storageKey === "string" && row.storageKey.startsWith("image:")) {
            keys.add(row.storageKey);
            if (capturedUrls) for (const field of ["content","url","dataUrl"]) if (typeof row[field] === "string") capturedUrls.set(row[field] as string,row.storageKey);
        }
        Object.values(row).forEach(item => collectImageStorageKeys(item,keys,knownUrls,capturedUrls));
    }
    return keys;
}
export function defaultUserStorageProvider(): UserS3StorageProvider { return {type:"s3",enabled:false,name:"",endpoint:"",region:"",bucket:"",accessKeyId:"",secretAccessKey:"",publicBaseUrl:"",pathPrefix:""}; }
export function defaultUserWebDAVStorageProvider(): UserWebDAVStorageProvider { return {type:"webdav",enabled:false,name:"",endpoint:"",pathPrefix:"",username:"",password:""}; }
export const loadUserS3StorageProvider = () => null as UserS3StorageProvider | null;
export const loadUserWebDAVStorageProvider = () => null as UserWebDAVStorageProvider | null;
export const loadUserStorageProvider = () => null as UserStorageProvider | null;
export function saveUserStorageProvider(_provider: UserS3StorageProvider) { throw new Error("试用版存储由本站管理"); }
export function saveUserWebDAVStorageProvider(_provider: UserWebDAVStorageProvider) { throw new Error("试用版存储由本站管理"); }
export function toProviderPayload(_provider: UserStorageProvider) { throw new Error("试用版不支持外部存储"); }
