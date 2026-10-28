"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="aurora-app flex h-full flex-col overflow-hidden bg-background text-foreground">
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
                <div className="flex items-center gap-3"><a href="/" className="font-medium">流星 API</a><Link href="/canvas">创作画布 · 站主试用</Link></div>
                <div className="flex items-center gap-3 text-foreground/60"><span>素材仅在当前浏览器缓存 24 小时，请及时导出</span><a href="/studio/source" target="_blank" rel="noopener noreferrer">Infinite Canvas · 源码与许可</a></div>
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
    );
}
