import { channelIdForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { normalizeQuality, resolveRequestSize } from "@/services/api/image";
import type { MeteorQuoteInput, PriceValue, PricingKind, PricingUnit } from "@/types/meteor-pricing";

export type PricingSelection = { model?: string; channelId?: string; count?: number; inputVideo?: boolean };

export function pricingInputFromConfig(config: AiConfig, kind: PricingKind, selection: PricingSelection = {}): MeteorQuoteInput {
    const model = selection.model ?? (kind === "image" ? config.imageModel : config.videoModel);
    const channelId = selection.channelId ?? channelIdForActiveModel({ ...config, model });
    const quality = config.quality.trim().toLowerCase();
    const imageResolution = ({ low: "1k", standard: "1k", medium: "2k", hd: "2k", high: "4k" } as Record<string, string>)[quality] || quality;
    const videoQuality = config.vquality.trim().toLowerCase();
    const videoResolution = /^\d+$/.test(videoQuality) ? `${videoQuality}p` : videoQuality;
    const duration = Number(config.videoSeconds);
    const count = Number(selection.count ?? config.count);
    const actualImageSize = resolveRequestSize(normalizeQuality(config.quality), config.size);
    return {
        kind, model, channelId,
        count: kind === "video" ? 1 : Number.isInteger(count) && count > 0 ? count : 1,
        resolution: kind === "video" ? videoResolution : imageResolution,
        quality: config.quality,
        size: kind === "image" ? actualImageSize || "auto" : config.size,
        ...(kind === "video" && Number.isInteger(duration) && duration > 0 ? { duration } : {}),
        audio: kind === "video" && config.videoGenerateAudio === "true",
        inputVideo: kind === "video" && selection.inputVideo === true,
    };
}

export function priceNumber(value: PriceValue | undefined): number | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function formatPrice(value: PriceValue | undefined, currency = "USD") {
    const amount = priceNumber(value);
    if (amount === null) return "暂无报价";
    const unit = currency === "USD" ? "$" : currency === "CNY" || currency === "RMB" ? "¥" : `${currency} `;
    if (amount > 0 && amount < 0.00000001) return `<${unit}0.00000001`;
    const number = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 8 }).format(amount);
    return `${unit}${number}`;
}

export function formatOfficialRate(value: PriceValue | undefined) {
    const rate = priceNumber(value);
    if (rate === null) return "";
    const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
    return `${decimal.format(rate)} × 官方价${rate < 1 ? `（${decimal.format(rate * 10)} 折）` : ""}`;
}

export function pricingUnit(mode: string, unit?: PricingUnit) {
    if (unit === "unknown" || mode === "unknown") return "";
    if (unit === "million_output_tokens" || mode === "token" || mode === "tokens" || mode === "per_token") return "/百万输出 Token";
    if (mode === "second" || mode === "seconds" || mode === "per_second") return "/秒";
    if (mode === "image" || mode === "per_image") return "/张";
    if (mode === "request" || mode === "per_request" || mode === "fixed") return "/次";
    return "";
}
