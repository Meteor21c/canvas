"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { App, Button } from "antd";
import { initializeMeteorCanvas, clearMeteorCanvasSession } from "@/services/api/meteor-gateway";
import { cleanupExpiredMedia } from "@/services/meteor-media-cache";
import { clearCanvasSession, hydrateCanvasProjects, useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const publicPage = /\/(?:source|pilot-health)\/?$/.test(pathname);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const serial = useRef(0);
    const syncError = useCanvasStore(state => state.syncError);
    const saving = useCanvasStore(state => state.saving);
    const retrySaves = useCanvasStore(state => state.retrySaves);
    useEffect(() => {
        const onExportWarning = (event: Event) => message.warning((event as CustomEvent<string>).detail);
        window.addEventListener("meteor-canvas:export-warning", onExportWarning);
        return () => window.removeEventListener("meteor-canvas:export-warning", onExportWarning);
    }, [message]);
    useEffect(() => {
        if (publicPage) return;
        let disposed = false;
        const start = async () => {
            const generation = ++serial.current;
            setReady(false); setError(""); clearCanvasSession(); clearMeteorCanvasSession();
            try {
                await initializeMeteorCanvas();
                if (disposed || generation !== serial.current) return;
                await hydrateCanvasProjects();
                if (!disposed && generation === serial.current) setReady(true);
            } catch (failure) {
                if (!disposed && generation === serial.current) setError(failure instanceof Error ? failure.message : "无法初始化画布");
            }
        };
        let previousToken = localStorage.getItem("auth_token");
        const onSession = () => {
            const token = localStorage.getItem("auth_token");
            if (token === previousToken) return;
            previousToken = token;
            void start();
        };
        const onStorage = (event: StorageEvent) => { if (event.key === "auth_token" || event.key === "auth_user" || event.key === null) onSession(); };
        const onVisibility = () => { if (document.visibilityState === "visible") onSession(); };
        const onBeforeUnload = (event: BeforeUnloadEvent) => { if (useCanvasStore.getState().saving || useCanvasStore.getState().syncError) event.preventDefault(); };
        void start();
        window.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("beforeunload", onBeforeUnload);
        const cleanupTimer = window.setInterval(() => { if (useCanvasStore.getState().hydrated) void cleanupExpiredMedia().catch(() => undefined); }, 60000);
        return () => { window.clearInterval(cleanupTimer); disposed = true; serial.current++; window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("beforeunload", onBeforeUnload); clearCanvasSession(); clearMeteorCanvasSession(); };
    }, [publicPage]);
    if (publicPage) return <>{children}</>;
    if (!ready) return <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background p-8 text-foreground"><h1 className="text-xl font-medium">流星创作画布 · 试用</h1><p>{error || "正在验证站主身份并读取画布…"}</p>{error ? <a href="/login">返回流星 API 登录</a> : null}<a href="/">返回主站</a></main>;
    return <div className="flex h-dvh flex-col overflow-hidden"><div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-1 text-xs text-foreground" role="status"><span>{syncError || (saving ? "正在保存画布…" : "画布已自动保存 · 每次仅手动生成一张图片")}</span>{syncError ? <Button size="small" onClick={retrySaves}>重试保存</Button> : null}</div><div className="min-h-0 flex-1">{children}</div></div>;
}
