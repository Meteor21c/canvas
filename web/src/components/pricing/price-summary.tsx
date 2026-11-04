"use client";

import Link from "next/link";
import { Info, RefreshCw } from "lucide-react";
import { useMeteorPricing } from "@/hooks/use-meteor-pricing";
import { formatOfficialRate, formatPrice, priceNumber, pricingUnit, type PricingSelection } from "@/lib/meteor-pricing";
import { cn } from "@/lib/utils";
import type { AiConfig } from "@/stores/use-config-store";
import type { MeteorQuote, PricingKind } from "@/types/meteor-pricing";

export type PriceSummaryProps = PricingSelection & {
    config: AiConfig;
    capability: PricingKind;
    compact?: boolean;
    className?: string;
    enabled?: boolean;
    showLink?: boolean;
};

export function PriceSummary({ config, capability, compact = false, className, enabled = true, showLink = true, ...selection }: PriceSummaryProps) {
    const { input, quote } = useMeteorPricing(config, capability, { ...selection, enabled });
    const params = new URLSearchParams({ kind: capability, model: input.model, channelId: input.channelId });
    return (
        <div className={cn("min-w-0 text-xs leading-relaxed text-muted-foreground", !compact && "rounded-xl border border-border/70 bg-muted/20 p-3", className)} aria-live="polite">
            {quote.isLoading ? <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-3 animate-spin" />正在读取当前计价…</span>
                : quote.error ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>报价暂不可用，请核对计价标准后再生成。</span><button type="button" className="underline underline-offset-2" onClick={() => void quote.refetch()}>重新读取</button></div>
                    : quote.data ? <QuoteDetails quote={quote.data} count={input.count} duration={input.duration} resolution={capability === "image" ? input.size : input.resolution} compact={compact} />
                        : <span>选择模型和分组后显示当前参数价格。</span>}
            {showLink ? <Link href={`/pricing?${params}`} className={cn("inline-flex items-center gap-1 text-foreground/75 underline underline-offset-2 hover:text-foreground", compact ? "mt-2" : "mt-2.5")} onClick={event => event.stopPropagation()}><Info className="size-3" />计价标准</Link> : null}
        </div>
    );
}

export function QuoteDetails({ quote, count = 1, duration, resolution, compact = false }: { quote: MeteorQuote; count?: number; duration?: number; resolution?: string; compact?: boolean }) {
    const hasEstimate = priceNumber(quote.estimatedAmount) !== null;
    const hasPrecharge = priceNumber(quote.prechargeAmount) !== null;
    const hasUnit = priceNumber(quote.siteUnitPrice) !== null;
    const rate = formatOfficialRate(quote.saleRateToOfficial);
    const unit = pricingUnit(quote.billingMode, quote.unit);
    const personal = quote.estimateSource === "personal";
    const range = personal && priceNumber(quote.estimateLow) !== null && priceNumber(quote.estimateHigh) !== null;
    const exceedsHold = hasEstimate && hasPrecharge && Math.max(Number(quote.estimatedAmount), priceNumber(quote.estimateHigh) ?? 0) > Number(quote.prechargeAmount);
    return (
        <div className={cn("space-y-1.5", !compact && "text-sm")}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {hasEstimate ? <span className="font-medium text-foreground">{personal ? "历史参考" : quote.exact ? "当前参数价" : "本次估算"} {range ? `${formatPrice(quote.estimateLow, quote.currency)}–${formatPrice(quote.estimateHigh, quote.currency)}` : formatPrice(quote.estimatedAmount, quote.currency)}{quote.kind === "image" ? ` / ${count} 张` : duration ? ` / ${duration} 秒` : ""}</span>
                    : <span>{unit === "/百万输出 Token" || quote.tokenPrices ? "按实际 Token 用量结算" : "当前参数暂无报价"}</span>}
                {hasPrecharge ? <span>预扣 <strong className="font-medium text-foreground">{formatPrice(quote.prechargeAmount, quote.currency)}</strong></span> : null}
            </div>
            {personal ? <p className="m-0 text-xs">参考本人近 90 天 {quote.estimateSamples} 次相同规格用量，按当前单价估算。</p> : quote.estimateSource === "default" ? <p className="m-0 text-xs">相同规格记录不足，采用模型默认预扣。</p> : null}
            {exceedsHold ? <p className="m-0 font-medium text-foreground">预计费用高于预扣，完成后将补扣差额。</p> : null}
            {hasUnit ? <div>{resolution ? <span className="mr-2 uppercase">{resolution}</span> : null}本站单价 <span className="font-medium text-foreground">{formatPrice(quote.siteUnitPrice, quote.currency)}{unit}</span>{priceNumber(quote.officialUnitPrice) !== null ? <span className="ml-2">官方 {formatPrice(quote.officialUnitPrice, quote.currency)}{unit}</span> : null}</div> : null}
            {rate ? <div>{rate}</div> : null}
            {quote.surcharges?.map(charge => <div key={charge.code} className="text-xs">{charge.unit === "image" ? `参考图前 ${charge.freeUnits} 张免费，超出 ${formatPrice(charge.siteUnitPrice, quote.currency)} / 张` : charge.unit === "second" ? `参考视频 ${formatPrice(charge.siteUnitPrice, quote.currency)} / 秒` : null}</div>)}
            {priceNumber(quote.estimatedSurchargeAmount) !== null && Number(quote.estimatedSurchargeAmount) > 0 ? <p className="m-0 font-medium text-foreground">本次参考素材费用约 {formatPrice(quote.estimatedSurchargeAmount, quote.currency)}</p> : null}
            {quote.tokenPrices ? <div className="space-y-0.5 text-xs">{([
                ["inputPerMillion", "文本输入"], ["cacheReadPerMillion", "缓存读取"], ["imageInputPerMillion", "图片输入"], ["imageOutputPerMillion", "图片输出"], ["outputPerMillion", "文本输出"],
            ] as const).filter(([key]) => priceNumber(quote.tokenPrices?.[key]) !== null).map(([key, label]) => <div key={key}>{label} {formatPrice(quote.tokenPrices?.[key], quote.currency)} / 百万 Token</div>)}</div> : null}
            {quote.notice ? <p className="m-0 text-xs opacity-80">{quote.notice}</p> : null}
            {!quote.exact && hasPrecharge && !quote.notice ? <p className="m-0 text-xs opacity-80">先预扣，完成后按实际用量多退少补。</p> : null}
        </div>
    );
}
