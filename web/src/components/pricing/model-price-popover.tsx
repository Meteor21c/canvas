"use client";

import { useState } from "react";
import Link from "next/link";
import { Popover } from "antd";
import { PriceSummary } from "./price-summary";
import type { AiConfig } from "@/stores/use-config-store";
import type { PricingKind } from "@/types/meteor-pricing";

// Nested inside a select option: all selecting gestures stop here. Merely
// inspecting a price must never change the active generation model.
export function stopPriceSelection(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    event.stopPropagation();
}

export function ModelPricePopover({ config, model, channelId, kind }: { config: AiConfig; model: string; channelId?: string; kind?: PricingKind }) {
    const [open, setOpen] = useState(false);
    return (
        <span className="ml-1 shrink-0" onPointerDown={stopPriceSelection} onPointerUp={stopPriceSelection} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === " " || event.key === "Enter" || event.key.startsWith("Arrow")) event.stopPropagation(); }}>
            <Popover open={open} onOpenChange={setOpen} trigger={["hover", "click"]} placement="rightTop" mouseEnterDelay={0.25} zIndex={1500} styles={{ container: { width: 320, maxWidth: "calc(100vw - 24px)", pointerEvents: "auto" } }} content={
                <div data-model-price-popup className="text-sm" onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                    <div className="mb-2 max-w-72 truncate font-medium" title={model}>{model}</div>
                    {kind ? <PriceSummary config={config} capability={kind} model={model} channelId={channelId} enabled={open} compact />
                        : <div className="text-xs leading-relaxed text-muted-foreground">当前创作台提供图片与视频报价。此模型的费用以主站用量记录为准。<Link className="mt-2 block underline" href="/pricing">查看计价标准</Link></div>}
                </div>
            }>
                <button type="button" aria-label={`查看 ${model} 价格`} aria-expanded={open} className="rounded px-1.5 py-1 text-[11px] text-foreground/60 underline decoration-foreground/20 underline-offset-2 transition hover:bg-foreground/5 hover:text-foreground focus-visible:outline focus-visible:outline-1" onClick={event => event.stopPropagation()}>价格</button>
            </Popover>
        </span>
    );
}
