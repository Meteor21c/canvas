"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { AppSideNav } from "@/components/layout/app-side-nav";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { AnnouncementBanner } from "@/components/layout/announcement-banner";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const isCanvasEditor = /^\/canvas\/[^/]+/.test(pathname);
    const user = useUserStore((state) => state.user);
    const token = useUserStore((state) => state.token);
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
        if (!token) return;
        const owner = user.id;
        let canceled = false;
        const current = () => !canceled && useUserStore.getState().token === token && useUserStore.getState().user?.id === owner;
        wasLoggedOutRef.current = false;
        fetchUserConfig(token)
            .then(async (config) => {
                if (!current()) return;
                const syncEnabled = config.syncCapabilities?.userData === true;
                const { useCanvasStore, hydrateCanvasProjects } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                if (!current()) return;
                const canvasStore = useCanvasStore.getState();
                canvasStore.setSyncEnabled(syncEnabled);
                if (!canvasStore.hydrated) await hydrateCanvasProjects();
                if (!current()) return;
                if (syncCanvasAfterLogin && syncEnabled && canvasStore.hydrated) {
                    void canvasStore.syncWithRemote(token, true);
                }
                const { useAssetStore } = await import("@/stores/use-asset-store");
                if (!current()) return;
                void useAssetStore.getState().hydrateAccountAssets(token, syncEnabled).catch(() => {});
            })
            .catch(() => {});
        return () => { canceled = true; };
    }, [isReady, token, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground lg:flex-row">
            <AppSideNav />
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {!isCanvasEditor ? <AnnouncementBanner /> : null}
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
            <AppConfigModal />
        </div>
    );
}
