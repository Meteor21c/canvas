import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteDetails } from "../src/components/pricing/price-summary";
import { formatOfficialRate, formatPrice, priceNumber, pricingInputFromConfig, pricingUnit } from "../src/lib/meteor-pricing";
import { defaultConfig } from "../src/stores/use-config-store";
import type { MeteorQuote } from "../src/types/meteor-pricing";

test("personal reference can exceed the reservation cap without becoming a final price", () => {
    const quote: MeteorQuote = { available: true, kind: "video", model: "video-model", channelId: "test", billingMode: "token", currency: "CNY", siteUnitPrice: "20", officialUnitPrice: null, saleRateToOfficial: null, estimatedAmount: "10", prechargeAmount: "5", exact: false, notice: "完成后按实际用量多退少补。", estimateSource: "personal", estimateSamples: 3, estimateLow: "9", estimateHigh: "11" };
    const html = renderToStaticMarkup(<QuoteDetails quote={quote} duration={10} />);
    expect(html).toContain("历史参考");
    expect(html).toContain("¥9–¥11");
    expect(html).toContain("¥5");
    expect(html).toContain("3 次");
    expect(html).toContain("完成后将补扣差额");
    expect(html).not.toMatch(/1\.15|盈合|上游|当前参数价/);
});

test("unknown token cost never becomes a zero price or a per-image quote", () => {
    for (const input of [null, undefined, "", " ", "unknown", "NaN", "-1", "Infinity"]) {
        expect(priceNumber(input)).toBeNull();
        expect(formatPrice(input)).toBe("暂无报价");
    }
    expect(formatPrice("0")).toBe("$0");
    expect(formatPrice("0.00000000001")).not.toBe("$0");
    expect(pricingUnit("unknown", "unknown")).toBe("");
    expect(pricingUnit("token", "million_output_tokens")).toBe("/百万输出 Token");
    const quote: MeteorQuote = { available: true, kind: "image", model: "gpt-image-2", channelId: "test", billingMode: "token", unit: "million_output_tokens", currency: "USD", siteUnitPrice: null, officialUnitPrice: null, saleRateToOfficial: null, estimatedAmount: null, prechargeAmount: null, exact: false, notice: "按实际 Token 用量结算。", tokenPrices: { inputPerMillion: "5", cacheReadPerMillion: "1", imageInputPerMillion: "8", imageOutputPerMillion: "30", outputPerMillion: null } };
    const html = renderToStaticMarkup(<QuoteDetails quote={quote} count={4} />);
    expect(html).toContain("按实际 Token 用量结算");
    expect(html).toContain("图片输出");
    expect(html).toContain("$30");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("/张");
    expect(html).not.toContain("预扣");
});

test("official-relative rate uses ratio semantics and current request parameters stay intact", () => {
    expect(formatOfficialRate("0.345")).toBe("0.345 × 官方价（3.45 折）");
    expect(formatOfficialRate(null)).toBe("");
    const config = { ...defaultConfig, videoModel: "seedance-2.5", videoChannelId: "meteor-key-4-video", videoSeconds: "30", vquality: "4K", count: "4", quality: "medium", imageResolution: "2k", imageModel: "gpt-image-2", imageChannelId: "meteor-key-7", videoGenerateAudio: "true" };
    expect(pricingInputFromConfig(config, "video", { inputVideo: true })).toMatchObject({ model: "seedance-2.5", channelId: "meteor-key-4-video", duration: 30, resolution: "4k", count: 1, audio: true, inputVideo: true });
    expect(pricingInputFromConfig(config, "image", { count: 3 })).toMatchObject({ model: "gpt-image-2", channelId: "meteor-key-7", resolution: "2k", count: 3, audio: false, inputVideo: false });
    expect(pricingInputFromConfig({ ...config, quality: "auto", size: "1:1" }, "image").size).toBe("2048x2048");
    expect(pricingInputFromConfig({ ...config, quality: "low", size: "4096x4096" }, "image").size).toBe("4096x4096");
    expect(pricingInputFromConfig({ ...config, videoSeconds: "not-known" }, "video").duration).toBeUndefined();
});

test("video shows explicit precharge separately from its final usage estimate", () => {
    const quote: MeteorQuote = { available: true, kind: "video", model: "video-model", channelId: "test", billingMode: "token", unit: "million_output_tokens", currency: "CNY", siteUnitPrice: "46", officialUnitPrice: "100", saleRateToOfficial: "0.46", estimatedAmount: null, prechargeAmount: "2.5", exact: false, notice: "以任务完成后的实际用量为准。" };
    const html = renderToStaticMarkup(<QuoteDetails quote={quote} duration={15} resolution="1080p" />);
    expect(html).toContain("按实际 Token 用量结算");
    expect(html).toContain("预扣");
    expect(html).toContain("¥2.5");
    expect(html).toContain("百万输出 Token");
    expect(html).toContain("4.6 折");
    expect(html).not.toContain("本次价格");
    expect(html).not.toMatch(/1\.15|盈合|上游/);
});

test("video enhancement keeps Token pricing and frame rate in the quote", () => {
    const input = pricingInputFromConfig({ ...defaultConfig, videoModel: "tencent-mps-superres", videoChannelId: "enhance-channel", vquality: "480p" }, "video", { frameRate: 60, sourceDurationSeconds: 12 });
    expect(input).toMatchObject({ model: "tencent-mps-superres", resolution: "1080p", frameRate: 60, sourceDurationSeconds: 12, count: 1 });
    const quote: MeteorQuote = { available: true, kind: "video", model: "tencent-mps-superres", channelId: "enhance-channel", billingMode: "token", unit: "million_output_tokens", currency: "CNY", siteUnitPrice: "0.9150435", officialUnitPrice: "1.263", saleRateToOfficial: "0.7245", estimatedAmount: null, prechargeAmount: "0.2", exact: false, notice: "先预扣，完成后按实际用量多退少补。" };
    const html = renderToStaticMarkup(<QuoteDetails quote={quote} resolution="1080p" />);
    expect(html).toContain("百万输出 Token");
    expect(html).toContain("¥0.2");
    expect(html).not.toContain("/分钟");
    expect(html).not.toMatch(/1\.15|盈合|上游/);
});

test("H3 shows chargeable image and input-video fees before submission", () => {
    const input = pricingInputFromConfig({ ...defaultConfig, videoModel: "MiniMax-H3", videoChannelId: "h3-channel", vquality: "480p" }, "video", { inputImageCount: 8, inputVideoSeconds: 6 });
    expect(input).toMatchObject({ resolution: "768p", inputImageCount: 8, inputVideoSeconds: 6 });
    const quote: MeteorQuote = { available: true, kind: "video", model: "MiniMax-H3", channelId: "h3-channel", billingMode: "duration", unit: "second", currency: "CNY", siteUnitPrice: "0.48875", officialUnitPrice: "0.5", saleRateToOfficial: "0.9775", estimatedAmount: "5.865", prechargeAmount: "5.865", estimatedSurchargeAmount: "3.519", exact: false, notice: "先预扣，完成后按实际用量多退少补。", surcharges: [{ code: "input_image", freeUnits: 5, unit: "image", siteUnitPrice: "0.1955", officialUnitPrice: "0.2" }, { code: "input_video", freeUnits: 0, unit: "second", siteUnitPrice: "0.48875", officialUnitPrice: "0.5" }] };
    const html = renderToStaticMarkup(<QuoteDetails quote={quote} duration={12} resolution="768p" />);
    expect(html).toContain("前 5 张免费");
    expect(html).toContain("¥0.1955 / 张");
    expect(html).toContain("参考视频 ¥0.48875 / 秒");
    expect(html).toContain("本次参考素材费用约 ¥3.519");
    expect(html).not.toMatch(/1\.15|盈合|上游/);
});
