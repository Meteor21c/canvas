"use client";
import { getMedia, mediaObjectUrl, putMedia } from "./meteor-media-cache";
import { uploadImage } from "./image-storage";
export type UploadedFile = {url:string;storageKey:string;bytes:number;mimeType:string;width?:number;height?:number;durationMs?:number};
export async function uploadMediaFile(input:string|Blob,_prefix="file",_syncId?:string):Promise<UploadedFile> { return uploadImage(input); }
export async function uploadAssetMediaFile(file:File,_prefix="asset-media"):Promise<UploadedFile> { return uploadImage(file); }
export async function uploadRemoteMediaToServer(url:string,_filename:string) { return uploadImage(url); }
export async function uploadMediaBlob(blob:Blob,_filename:string) { return uploadImage(blob); }
export async function downloadRemoteMedia(_url:string):Promise<Blob> { throw new Error("试用版视频请使用原视频页面"); }
export function clearStorageConfigCache() { }
export async function resolveMediaUrl(storageKey?:string,_fallback="") { return storageKey ? mediaObjectUrl(storageKey) : ""; }
export const getMediaBlob = getMedia;
export const setMediaBlob = putMedia;
export async function deleteStoredMedia(_keys:Iterable<string>) { }
export async function cleanupUnusedMedia(_used:unknown) { }
export function collectMediaStorageKeys(_used:unknown,keys=new Set<string>()) { return keys; }
