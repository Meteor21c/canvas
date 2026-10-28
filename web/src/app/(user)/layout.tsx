"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const wasLoggedOutRef = useRef(false);
    const error = useUserStore((state) => state.error);
    const syncError = useCanvasStore((state) => state.syncError);
    const loginHint = error ? "暂时无法进入创作台，请重新登录或联系支持。" : "登录后开始创作";

    useEffect(() => {
        if (!isReady) return;
        if (!user) {
            wasLoggedOutRef.current = true;
            return;
        }
        const syncCanvasAfterLogin = wasLoggedOutRef.current;
        const token = useUserStore.getState().token;
        if (!token) return;
        wasLoggedOutRef.current = false;
        fetchUserConfig(token)
            .then(async (config) => {
                const syncEnabled = config.syncCapabilities?.userData === true;
                const { useCanvasStore, hydrateCanvasProjects } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                const canvasStore = useCanvasStore.getState();
                canvasStore.setSyncEnabled(syncEnabled);
                if (!canvasStore.hydrated) await hydrateCanvasProjects();
                if (syncCanvasAfterLogin && syncEnabled && canvasStore.hydrated) {
                    void canvasStore.syncWithRemote(token, true);
                }
                const { useAssetStore } = await import("@/stores/use-asset-store");
                void useAssetStore.getState().hydrateAccountAssets(token, syncEnabled);
            })
            .catch(() => {});
    }, [isReady, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            {user && syncError ? (
                <div role="status" className="shrink-0 border-b border-[var(--ant-color-border)] px-6 py-2 text-sm text-[var(--ant-color-warning-text)]">
                    {syncError}
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
                {!isReady ? (
                    <div className="flex h-full items-center justify-center text-sm opacity-60">正在加载创作空间…</div>
                ) : !user ? (
                    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                        <p>{loginHint}</p>
                        <a href="/login?redirect=%2Fstudio" className="rounded-full bg-stone-900 px-5 py-2.5 text-sm text-white dark:bg-stone-100 dark:text-stone-900">
                            前往登录
                        </a>
                    </div>
                ) : (
                    children
                )}
            </div>
        </div>
    );
}
