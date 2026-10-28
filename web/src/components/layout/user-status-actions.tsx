"use client";

import type { RefObject } from "react";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";

type UserStatusActionsProps = { className?: string; compact?: boolean; showConfig?: boolean; variant?: "default" | "canvas"; onOpenShortcuts?: () => void; accountOpen?: boolean; onAccountOpenChange?: (open: boolean) => void; accountRef?: RefObject<HTMLDivElement | null>; getPopupContainer?: (node: HTMLElement) => HTMLElement };
export function UserStatusActions({ className, onOpenShortcuts }: UserStatusActionsProps) {
    const theme = useThemeStore(state => state.theme);
    const setTheme = useThemeStore(state => state.setTheme);
    const user = useUserStore(state => state.user);
    return <div className={`inline-flex items-center gap-3 text-xs ${className || ""}`}>
        <a href="/dashboard" title="在主站查看实际余额和账单">{user?.displayName || user?.username || "站主"} · 查看余额与账单</a>
        {onOpenShortcuts ? <button type="button" onClick={onOpenShortcuts}>快捷键</button> : null}
        <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="size-7" aria-label="切换主题" />
    </div>;
}
