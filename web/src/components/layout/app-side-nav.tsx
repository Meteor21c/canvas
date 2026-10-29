"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Drawer, Tooltip } from "antd";
import { ArrowLeft, Clock3, Home, Menu, PanelLeftClose, PanelLeftOpen, ReceiptText, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useUserStore } from "@/stores/use-user-store";

const items = [
    { href: "/", label: "创作首页", icon: Home },
    ...navigationTools.map((tool) => ({ href: `/${tool.slug}`, label: tool.label, icon: tool.icon })),
    { href: "/pricing", label: "计价标准", icon: ReceiptText },
];
const itemClass = "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
// antd 的非 layer 重置会覆盖链接颜色，选中态显式保留前景与背景对比。
const idleItemClass = "!bg-card/70 !text-foreground/65 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:!bg-card hover:!text-foreground";
const activeItemClass = "!bg-foreground font-medium !text-background shadow-[0_6px_16px_-6px_rgba(0,0,0,0.3)]";

export function AppSideNav() {
    const pathname = usePathname();
    const user = useUserStore((state) => state.user);
    const [collapsed, setCollapsed] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    const activeItem = items.find((item) => item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`));

    useEffect(() => setMobileOpen(false), [pathname]);
    useEffect(() => {
        const desktop = window.matchMedia("(min-width: 1024px)");
        const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
        desktop.addEventListener("change", closeOnDesktop);
        return () => desktop.removeEventListener("change", closeOnDesktop);
    }, []);

    if (/^\/canvas\/[^/]+/.test(pathname)) return null;

    const renderContent = (compact: boolean, mobile = false) => {
        const wrap = (label: string, node: ReactNode) => compact ? <Tooltip key={label} title={label} placement="right">{node}</Tooltip> : node;
        return (
            <div className="flex h-full min-h-0 flex-col gap-5 p-3">
                <div className={cn("flex items-center gap-2 px-1 pt-1", compact ? "flex-col" : "justify-between")}>
                    <Link href="/" onClick={() => setMobileOpen(false)} className="flex min-w-0 items-center gap-2.5 !text-foreground" aria-label="流星创作台首页">
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-foreground text-background">
                            <span className="size-4 bg-current" style={{ mask: "url(/studio/logo.svg) center / contain no-repeat", WebkitMask: "url(/studio/logo.svg) center / contain no-repeat" }} />
                        </span>
                        {!compact ? <span className="truncate text-base font-semibold tracking-tight">流星创作台</span> : null}
                    </Link>
                    <button
                        type="button"
                        onClick={() => mobile ? setMobileOpen(false) : setCollapsed(!collapsed)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg !text-foreground/50 transition hover:bg-foreground/5 hover:!text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        aria-label={mobile ? "关闭导航菜单" : compact ? "展开侧边栏" : "收起侧边栏"}
                        aria-expanded={mobile ? mobileOpen : !collapsed}
                    >
                        {mobile ? <X className="size-4" /> : compact ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                    </button>
                </div>

                <nav aria-label="创作台导航" className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-1">
                    {items.map(({ href, label, icon: Icon }) => wrap(label,
                        <Link
                            key={href}
                            href={href}
                            onClick={() => setMobileOpen(false)}
                            className={cn(itemClass, compact && "justify-center px-0", activeItem?.href === href ? activeItemClass : idleItemClass, href === "/pricing" && "mt-3")}
                            aria-current={activeItem?.href === href ? "page" : undefined}
                            aria-label={compact ? label : undefined}
                        >
                            <Icon className="size-4 shrink-0" aria-hidden="true" />
                            {!compact ? <span>{label}</span> : null}
                        </Link>,
                    ))}
                </nav>

                <div className="flex shrink-0 flex-col gap-3">
                    {!compact ? <p className="flex gap-2 px-2 text-[11px] leading-5 text-foreground/45"><Clock3 className="mt-1 size-3 shrink-0" /><span>画布与素材保留 7 天<br />请及时导出并备份到本地</span></p> : null}
                    {wrap("返回流星 API", <a href="/" className={cn(itemClass, idleItemClass, compact && "justify-center px-0")} aria-label="返回流星 API"><ArrowLeft className="size-4 shrink-0" />{!compact ? <span>返回流星 API</span> : null}</a>)}
                    <div className={cn("rounded-2xl bg-card/80 p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)]", compact && "px-0")}>
                        {!compact && user ? <div className="mb-2 flex items-center justify-between gap-2 px-1"><span className="min-w-0 truncate text-xs font-medium text-foreground/75">{user.displayName || user.username}</span><span className="shrink-0 text-[11px] tabular-nums text-foreground/50">余额 {(user.balance ?? user.credits ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div> : null}
                        <UserStatusActions variant="sidebar" showConfig={false} showReturnLink={false} className={compact ? "w-full flex-col gap-2" : "w-full justify-between"} />
                    </div>
                </div>
            </div>
        );
    };

    return (
        <>
            <aside className={cn("relative z-10 hidden shrink-0 border-r border-border/60 bg-muted/50 transition-[width] duration-200 lg:block", collapsed ? "w-[72px]" : "w-[232px]")}>
                {renderContent(collapsed)}
            </aside>
            <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/50 bg-background/90 px-3 backdrop-blur-xl lg:hidden">
                <button type="button" onClick={() => setMobileOpen(true)} className="inline-flex size-9 items-center justify-center rounded-lg !text-foreground/70 transition hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring" aria-label="打开导航菜单" aria-haspopup="dialog" aria-expanded={mobileOpen} aria-controls="studio-mobile-navigation"><Menu className="size-5" /></button>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{activeItem?.label || "流星创作台"}</span>
                <a href="/" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs !text-foreground/70 focus-visible:outline-2 focus-visible:outline-ring"><ArrowLeft className="size-3.5" />返回流星 API</a>
            </header>
            <Drawer aria-label="创作台导航" placement="left" size={280} open={mobileOpen} onClose={() => setMobileOpen(false)} closable={false} keyboard focusable={{ trap: true, focusTriggerAfterClose: true }} rootClassName="lg:hidden" styles={{ body: { padding: 0, background: "var(--sidebar)" } }}>
                <div id="studio-mobile-navigation" className="h-full">{renderContent(false, true)}</div>
            </Drawer>
        </>
    );
}
