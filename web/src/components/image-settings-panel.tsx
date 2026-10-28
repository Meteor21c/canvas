"use client";

import type { ReactNode } from "react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

export const imageSizeOptions = ["1:1", "16:9", "9:16"].map(value => ({ value, label: value }));
type Props = { config: AiConfig; onConfigChange: (key: "quality" | "size" | "count", value: string) => void; theme: CanvasTheme; showTitle?: boolean; showSize?: boolean; showCount?: boolean; className?: string; maxCount?: number; quickCount?: number };
export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, showSize = true, className = "space-y-4" }: Props) {
    const quality = ["low", "medium", "high"].includes(config.quality) ? config.quality : "low";
    const size = imageSizeOptions.some(item => item.value === config.size) ? config.size : "1:1";
    const optionStyle = (active: boolean) => ({ color: theme.node.text, borderColor: active ? theme.node.text : theme.node.stroke, background: active ? theme.toolbar.activeBg : "transparent" });
    return <div className={className} style={{ color: theme.node.text }}>
        {showTitle ? <h3 className="text-sm font-medium">图片规格</h3> : null}
        <div className="space-y-2"><p className="text-xs" style={{ color: theme.node.muted }}>清晰度（按本站分组计价）</p><div className="grid grid-cols-3 gap-2">{[{ value: "low", label: "1K" }, { value: "medium", label: "2K" }, { value: "high", label: "4K" }].map(item => <button key={item.value} type="button" className="rounded-lg border px-3 py-2 text-sm" style={optionStyle(quality === item.value)} onClick={() => { onConfigChange("quality", item.value); if (item.value === "high" && size === "1:1") onConfigChange("size", "16:9"); }}>{item.label}</button>)}</div></div>
        {showSize ? <div className="space-y-2"><p className="text-xs" style={{ color: theme.node.muted }}>画面比例</p><div className="grid grid-cols-3 gap-2">{imageSizeOptions.map(item => <button key={item.value} type="button" disabled={quality === "high" && item.value === "1:1"} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-30" style={optionStyle(size === item.value)} onClick={() => onConfigChange("size", item.value)}>{item.label}</button>)}</div></div> : null}
        <p className="text-xs leading-5" style={{ color: theme.node.muted }}>站主试用每次生成 1 张。生成与编辑沿用本站原有扣费；4K 暂不提供方图。</p>
    </div>;
}
export function ImageSettingsTheme({ children }: { theme: CanvasTheme; children: ReactNode }) { return <>{children}</>; }
export function imageQualityLabel(value: string) { return ({ auto: "1K", low: "1K", medium: "2K", high: "4K" } as Record<string, string>)[value] || "1K"; }
export function imageSizeLabel(size: string) { return imageSizeOptions.find(item => item.value === size)?.label || "1:1"; }
export function imageFormatLabel(format: string) { return format.toUpperCase(); }
