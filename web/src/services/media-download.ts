"use client";

import { prepareMediaDownload } from "@/services/api/meteor-download";
import { useUserStore } from "@/stores/use-user-store";

export async function downloadVideoFile(source: string, storageKey: string | undefined, filename: string) {
    const { token, user } = useUserStore.getState();
    const current = () => useUserStore.getState().token === token && useUserStore.getState().user?.id === user?.id;
    let target: string;
    if (storageKey?.startsWith("server:")) {
        target = (await prepareMediaDownload({ storageKey, filename }, token)).url;
    } else {
        const sourceUrl = storageKey ? await (await import("@/services/file-storage")).resolveMediaUrl(storageKey, source) : source;
        const parsed = new URL(sourceUrl, window.location.origin);
        if (parsed.protocol === "blob:" && parsed.origin === window.location.origin) target = sourceUrl;
        else {
            if (parsed.origin !== window.location.origin) throw new Error("视频地址不可用，请重新打开作品后下载");
            const file = parsed.pathname.match(/^\/studio\/api\/files\/([^/]+)\/content$/);
            const video = parsed.pathname.match(/^\/studio\/api\/v1\/videos\/([^/]+)\/content$/);
            if (!file && !video) throw new Error("视频地址不可用，请重新打开作品后下载");
            const input = file ? { storageKey: `server:${decodeURIComponent(file[1])}`, filename } : { videoTaskId: decodeURIComponent(video![1]), filename };
            if (!current()) throw new Error("登录状态已变化，请重新下载");
            target = (await prepareMediaDownload(input, token)).url;
        }
    }
    if (!current()) throw new Error("登录状态已变化，请重新下载");
    const parsed = new URL(target, window.location.origin);
    if (parsed.origin !== window.location.origin || !["blob:", "http:", "https:"].includes(parsed.protocol)) throw new Error("下载地址无效");
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}
