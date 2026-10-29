"use client";

import { useEffect, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";

// Renew playback links without changing the saved project or extending file retention.
export function useMediaUrl(storageKey: string | undefined, fallback = "", kind: "image" | "media" = "image") {
    const account = useUserStore(state => state.user?.id);
    const scope = `${account}:${storageKey}:${fallback}`;
    const [resolved, setResolved] = useState({ scope, url: fallback });
    useEffect(() => {
        if (!storageKey?.startsWith("server:") || storageKey.startsWith("server:webdav:")) return;
        let active = true, current = fallback;
        let timer: ReturnType<typeof setTimeout>;
        const expiry = () => {
            try { return Number(new URL(current, window.location.origin).searchParams.get("expires")) * 1000; }
            catch { return 0; }
        };
        const schedule = () => {
            clearTimeout(timer);
            if (expiry()) timer = setTimeout(() => { void refresh(); }, Math.max(60_000, expiry() - Date.now() - 60_000));
        };
        const refresh = async () => {
            try {
                const url = await (kind === "image" ? resolveImageUrl : resolveMediaUrl)(storageKey, current);
                if (!active) return;
                if (url) { current = url; setResolved({ scope, url }); }
            } catch { /* Keep the current media visible while a temporary renewal failure is retried. */ }
            finally { if (active) schedule(); }
        };
        const resume = () => {
            if (document.visibilityState !== "hidden" && expiry() && expiry() <= Date.now() + 60_000) void refresh();
        };
        if (expiry() && expiry() <= Date.now() + 60_000) void refresh();
        else schedule();
        window.addEventListener("focus", resume);
        document.addEventListener("visibilitychange", resume);
        return () => { active = false; clearTimeout(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
    }, [storageKey, fallback, kind, account, scope]);
    return resolved.scope === scope ? resolved.url : fallback;
}
