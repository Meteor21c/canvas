"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, Coins, ImageIcon, RefreshCw, Video } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { boundVideoSeconds, VideoDurationControl } from "@/components/video-settings-panel";
import { QuoteDetails } from "@/components/pricing/price-summary";
import { useMeteorPricing } from "@/hooks/use-meteor-pricing";
import { formatOfficialRate, formatPrice, priceNumber, pricingUnit } from "@/lib/meteor-pricing";
import { useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import type { MeteorQuote, PricingKind } from "@/types/meteor-pricing";

export default function PricingPage() {
    return <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">正在读取计价标准…</div>}><PricingWorkspace /></Suspense>;
}

function PricingWorkspace() {
    const search = useSearchParams();
    const config = useEffectiveConfig();
    const [kind, setKind] = useState<PricingKind>(search.get("kind") === "video" ? "video" : "image");
    const [selected, setSelected] = useState({ model: search.get("model") || "", channelId: search.get("channelId") || "" });
    const [parameters, setParameters] = useState<Partial<AiConfig>>({});
    const [inputVideo, setInputVideo] = useState(false);
    const choices = useMemo(() => config.publicChannels.flatMap(channel => (channel.models || []).filter(model => channel.modelCapabilities?.[model] === kind).map(model => ({ model, channelId: channel.id || "", channelName: channel.name || "本站分组" }))), [config.publicChannels, kind]);
    const current = choices.find(option => option.model === selected.model && option.channelId === selected.channelId) || choices[0];
    const localConfig = useMemo(() => ({ ...config, ...parameters, ...(kind === "image" ? { imageModel: current?.model || "", imageChannelId: current?.channelId || "" } : { videoModel: current?.model || "", videoChannelId: current?.channelId || "" }) }), [config, parameters, kind, current?.model, current?.channelId]);
    const { input, capabilities, quote } = useMeteorPricing(localConfig, kind, { model: current?.model || "", channelId: current?.channelId || "", inputVideo });
    const capability = capabilities.data;
    const duration = capability?.duration;
    const imageMaxBatch = Math.min(4, Math.max(1, capability?.maxBatch || 4));
    const hasAudio = capability?.scenarios.some(scenario => scenario.audio) === true;
    const update = (patch: Partial<AiConfig>) => setParameters(previous => ({ ...previous, ...patch }));
    useEffect(() => {
        if (!capability?.available) return;
        const patch: Partial<AiConfig> = {};
        if (capability.resolutions.length && !capability.resolutions.some(value => value.toLowerCase() === input.resolution.toLowerCase())) {
            if (kind === "video") patch.vquality = capability.resolutions[0];
            else patch.quality = capability.resolutions[0];
        }
        if (kind === "video" && duration) {
            const seconds = String(boundVideoSeconds(localConfig.videoSeconds, duration));
            if (seconds !== localConfig.videoSeconds) patch.videoSeconds = seconds;
        }
        if (kind === "image") {
            const count = String(Math.max(1, Math.min(imageMaxBatch, Math.round(Number(localConfig.count)) || 1)));
            if (count !== localConfig.count) patch.count = count;
        }
        if (kind === "video" && !capability.scenarios.some(scenario => scenario.audio) && localConfig.videoGenerateAudio === "true") patch.videoGenerateAudio = "false";
        if (Object.keys(patch).length) setParameters(previous => ({ ...previous, ...patch }));
    }, [capability, duration, imageMaxBatch, input.resolution, kind, localConfig.count, localConfig.videoSeconds, localConfig.videoGenerateAudio]);
    const changeKind = (next: PricingKind) => { setKind(next); setParameters({}); setSelected({ model: "", channelId: "" }); setInputVideo(false); };
    const requestRefresh = () => { void capabilities.refetch(); void quote.refetch(); };
    return (
        <main className="h-full overflow-y-auto bg-background px-4 py-8 sm:px-8">
            <div className="mx-auto max-w-5xl space-y-6 pb-10">
                <header className="flex flex-wrap items-start justify-between gap-4">
                    <div><p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground"><Coins className="size-4" />流星 API 创作台</p><h1 className="text-3xl font-semibold tracking-tight">计价标准</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">查看当前账号的图片与视频计价，调整参数即可获取报价与预扣金额。</p></div>
                    <button type="button" onClick={requestRefresh} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs transition hover:bg-muted disabled:opacity-50" disabled={!current || capabilities.isFetching || quote.isFetching}><RefreshCw className={`size-3.5 ${capabilities.isFetching || quote.isFetching ? "animate-spin" : ""}`} />刷新价格</button>
                </header>
                <div className="inline-flex gap-1 rounded-xl border border-border p-1">{([{ value: "image", label: "图片", Icon: ImageIcon }, { value: "video", label: "视频", Icon: Video }] as const).map(({ value, label, Icon }) => <button key={value} type="button" onClick={() => changeKind(value)} aria-pressed={kind === value} style={kind === value ? { color: "var(--background)" } : undefined} className={`inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm transition ${kind === value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}><Icon className="size-4" />{label}</button>)}</div>
                {!choices.length ? <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">当前账号暂无可用的{kind === "image" ? "图片" : "视频"}模型。请在主站检查密钥与分组权限。</div> : <>
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <section className="rounded-2xl border border-border p-5 sm:p-6">
                            <h2 className="mb-5 text-base font-medium">选择模型与参数</h2>
                            <div className="space-y-5">
                                <Field label="模型 / 分组"><ModelPicker config={localConfig} value={current?.model} channelId={current?.channelId} capability={kind} onChange={(model, channelId) => { setSelected({ model, channelId: channelId || "" }); setParameters({}); }} fullWidth /></Field>
                                <div className="grid grid-cols-2 gap-4">
                                    <Field label={kind === "video" ? "清晰度" : "图片规格"}>{kind === "image" ? <input className={control} value={localConfig.quality} onChange={event => update({ quality: event.target.value })} list="meteor-image-price-sizes" placeholder="auto / 1k / 2k / 4k" /> : <select className={control} value={input.resolution} disabled={!capability?.available || !capability.resolutions.length} onChange={event => update({ vquality: event.target.value })}>{capability?.resolutions.length ? capability.resolutions.map(resolution => <option key={resolution} value={resolution.toLowerCase()}>{resolution.toUpperCase()}</option>) : <option value={input.resolution}>{input.resolution.toUpperCase() || "暂无可用规格"}</option>}</select>}<datalist id="meteor-image-price-sizes">{Object.keys(quote.data?.imagePriceBySize || {}).map(size => <option key={size} value={size.toLowerCase()} />)}</datalist></Field>
                                    <Field label="画面比例 / 尺寸"><input className={control} value={localConfig.size} onChange={event => update({ size: event.target.value })} placeholder="例如 16:9" /></Field>
                                </div>
                                {kind === "image" ? <Field label={"生成数量（最多 " + imageMaxBatch + " 张）"}><select aria-label="生成数量" className={control} value={localConfig.count} onChange={event => update({ count: event.target.value })}>{Array.from({ length: imageMaxBatch }, (_, index) => index + 1).map(count => <option key={count} value={String(count)}>{count} 张</option>)}</select></Field>
                                    : <><Field label="时长（秒）">{duration && capability?.available ? <VideoDurationControl value={localConfig.videoSeconds} bounds={duration} onChange={value => update({ videoSeconds: value })} /> : <p className="text-xs text-muted-foreground">当前模型未提供可核实的时长范围。</p>}{duration ? <span className="mt-1.5 block text-xs text-muted-foreground">{duration.values?.length ? `可选 ${duration.values.join("、")} 秒` : `支持 ${duration.min}–${duration.max} 秒整数`}</span> : null}</Field><div className="flex flex-wrap gap-x-6 gap-y-3 text-sm"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={localConfig.videoGenerateAudio === "true"} disabled={!capability?.available || !hasAudio} onChange={event => update({ videoGenerateAudio: String(event.target.checked) })} />生成音频</label><label className="inline-flex items-center gap-2"><input type="checkbox" checked={inputVideo} onChange={event => setInputVideo(event.target.checked)} />包含视频参考</label></div></>}
                            </div>
                        </section>
                        <section className="rounded-2xl border border-border bg-muted/20 p-5 sm:p-6" aria-live="polite"><div className="mb-5 flex items-baseline justify-between gap-3"><h2 className="text-base font-medium">当前参数报价</h2><span className="truncate text-xs text-muted-foreground">{current?.channelName}</span></div>{quote.isLoading ? <p className="text-sm text-muted-foreground">正在读取报价…</p> : quote.error ? <p className="text-sm text-muted-foreground">当前报价暂不可用，请检查参数或稍后刷新。</p> : quote.data ? <QuoteDetails quote={quote.data} count={input.count} duration={input.duration} resolution={kind === "image" ? input.size : input.resolution} /> : <p className="text-sm text-muted-foreground">尚未取得报价。</p>}<div className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground"><p>Token 计费按实际用量结算，生成前显示预计预扣金额。</p><p className="mt-2">预扣用于冻结本次生成额度，完成后按实际用量结算。余额变动可查看主站用量记录。</p></div></section>
                    </div>
                    <section className="overflow-hidden rounded-2xl border border-border"><div className="border-b border-border px-5 py-4"><h2 className="font-medium">模型计价规则</h2><p className="mt-1 text-xs text-muted-foreground">不同清晰度、音频和参考素材可能采用不同单价。</p></div>{capabilities.isLoading ? <p className="p-5 text-sm text-muted-foreground">正在读取规则…</p> : kind === "image" && quote.data ? <ImageRules quote={quote.data} /> : capabilities.error || !capability?.scenarios.length ? <p className="p-5 text-sm text-muted-foreground">当前没有可核实的计价规则。{capability?.notice}</p> : <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{["规格 / 场景", "本站单价", "官方单价", "相对官方"].map(label => <th className="px-5 py-3 font-normal" key={label}>{label}</th>)}</tr></thead><tbody>{capability.scenarios.map((scenario, index) => <tr className="border-t border-border/70" key={index}><td className="px-5 py-3"><span className="uppercase">{scenario.resolutions.join(" / ") || "当前规格"}</span>{kind === "video" ? <span className="mt-1 block text-xs text-muted-foreground">{scenario.audio ? "带音频" : "不带音频"} · {scenario.inputVideo ? "含视频参考" : "无视频参考"}</span> : null}</td><td className="px-5 py-3">{formatPrice(scenario.siteUnitPrice, scenario.currency)}{priceNumber(scenario.siteUnitPrice) !== null ? pricingUnit(scenario.billingMode, scenario.unit) : ""}</td><td className="px-5 py-3 text-muted-foreground">{formatPrice(scenario.officialUnitPrice, scenario.currency)}{priceNumber(scenario.officialUnitPrice) !== null ? pricingUnit(scenario.billingMode, scenario.unit) : ""}</td><td className="px-5 py-3 text-xs">{formatOfficialRate(scenario.saleRateToOfficial) || "暂无可比数据"}</td></tr>)}</tbody></table></div>}</section>
                </>}
                <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>价格随当前模型和分组规则更新。</span><a className="inline-flex items-center gap-1 underline" href="/usage">主站用量记录<ArrowUpRight className="size-3" /></a></footer>
            </div>
        </main>
    );
}

const control = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/50 disabled:opacity-50";
function ImageRules({ quote }: { quote: MeteorQuote }) {
    const tiers = Object.entries(quote.imagePriceBySize || {}).filter(([, value]) => priceNumber(value) !== null);
    const tokenRows = ([
        ["inputPerMillion", "文本输入"], ["cacheReadPerMillion", "缓存读取"], ["imageInputPerMillion", "图片输入"], ["imageOutputPerMillion", "图片输出"], ["outputPerMillion", "文本输出"],
    ] as const).filter(([key]) => priceNumber(quote.tokenPrices?.[key]) !== null);
    return <div className="p-5 text-sm">{tiers.length ? <div className="grid gap-3 sm:grid-cols-3">{tiers.map(([tier, value]) => <div key={tier} className="rounded-xl bg-muted/30 px-4 py-3"><div className="text-xs uppercase text-muted-foreground">{tier}</div><div className="mt-1 font-medium">{formatPrice(value, quote.currency)} / 张</div></div>)}</div> : tokenRows.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{tokenRows.map(([key, label]) => <div key={key} className="rounded-xl bg-muted/30 px-4 py-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{formatPrice(quote.tokenPrices?.[key], quote.currency)} / 百万 Token</div></div>)}</div> : <p className="text-muted-foreground">{quote.notice || "当前没有可核实的分档计价数据。"}</p>}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return <div><label className="mb-2 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
