"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useVideoCapabilities } from "@/hooks/use-meteor-pricing";
import { Input, Switch } from "antd";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { useAutoDLWorkflow } from "@/hooks/use-autodl-workflow";
import { isAutoDLConfig, normalizeAutoDLDuration } from "@/lib/autodl";
import { boolConfig, isSeedanceFastOrMiniModel, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceDurationOptions, seedancePixelLabel, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { COGVIDEOX3_DURATIONS, isCogVideoX3Model, modelKey, normalizeCogVideoX3Duration, supportsVideoAudioGeneration } from "@/lib/video-model-capabilities";
import { grokVideoModeOptions, isAPIMartKlingV26Config, isAPIMartKlingV3Config, isKIEGrokVideoModel, isKIEKlingV3Config, klingV26DurationOptions, klingV26ModeOptions, klingV26RatioLabels, klingV26RatioOptions, klingV3DurationOptions, klingV3ModeOptions, normalizeKlingV26Duration, normalizeKlingV26Ratio, normalizeKlingV3Duration } from "@/services/api/protocols/kling-models";
import { type AiConfig } from "@/stores/use-config-store";

export { isAPIMartKlingV26Config, isAPIMartKlingV3Config, isAPIMartKlingMotionControlConfig, isKIEKlingV3Config, kieKlingOmniVariant, isKIEKlingMotionControlConfig, isKIEGrokVideoModel } from "@/services/api/protocols/kling-models";

export const videoResolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];
const resolutionButtonOptions = videoResolutionOptions.slice(0, 2);

const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
];

const secondOptions = [6, 10, 12, 16, 20];

type VideoSettingsPanelProps = {
    config: AiConfig;
    modelName?: string;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoMode" | "videoNegativePrompt" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    hideNegativePrompt?: boolean;
    visualOnly?: boolean;
};

export function VideoSettingsPanel({ config, modelName, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", visualOnly = false }: VideoSettingsPanelProps) {
    const model = modelName || config.model || config.videoModel;
    const { data, isLoading, error } = useVideoCapabilities(config, model);
    const resolutions = data?.available ? data.resolutions.map(value => normalizeVideoResolutionValue(value).toLowerCase()) : [];
    const resolution = normalizeVideoResolutionValue(config.vquality).toLowerCase();
    const duration = data?.duration;
    useEffect(() => {
        if (!data?.available || !duration) return;
        if (resolutions.length && !resolutions.includes(resolution)) {
            onConfigChange("vquality", resolutions[0]);
            onConfigChange("size", videoSizeForResolution(resolutions[0], config.size));
        }
        const seconds = boundVideoSeconds(config.videoSeconds, duration);
        if (String(seconds) !== config.videoSeconds) onConfigChange("videoSeconds", String(seconds));
        if (!data.supportsAudio && config.videoGenerateAudio === "true") onConfigChange("videoGenerateAudio", "false");
    }, [data, config.videoSeconds, config.videoGenerateAudio, config.size, resolution, onConfigChange]);
    return <ImageSettingsTheme theme={theme}>
        <div className={className} style={{ color: theme.node.text }} onMouseDown={event => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
            {!data?.available || !duration ? <p className="text-sm opacity-65">{isLoading ? "正在读取可用参数…" : "该模型参数暂不可用"}</p> : <>
                <SettingGroup title="清晰度" color={theme.node.muted}>
                    <div className="flex flex-wrap gap-2">{resolutions.map(value => <OptionPill key={value} selected={resolution === value} theme={theme} onClick={() => { onConfigChange("vquality", value); onConfigChange("size", videoSizeForResolution(value, config.size)); }}>{videoResolutionLabel(value).toUpperCase()}</OptionPill>)}</div>
                </SettingGroup>
                <SettingGroup title="画面比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">{["16:9", "9:16", "1:1"].map(ratio => <OptionPill key={ratio} selected={normalizeSeedanceRatio(config.size) === ratio} theme={theme} onClick={() => onConfigChange("size", seedancePixelLabel(resolution, ratio))}>{ratio}</OptionPill>)}</div>
                </SettingGroup>
                {!visualOnly ? <SettingGroup title={`时长 · ${duration.min}–${duration.max} 秒`} color={theme.node.muted}>
                    <VideoDurationControl value={config.videoSeconds} bounds={duration} onChange={value => onConfigChange("videoSeconds", value)} />
                </SettingGroup> : null}
                {!visualOnly && data.supportsAudio ? <AudioGenerationSetting checked={boolConfig(config.videoGenerateAudio, false)} theme={theme} onChange={checked => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
            </>}
        </div>
    </ImageSettingsTheme>;
}

export function boundVideoSeconds(value: string | number, bounds: { min: number; max: number; values?: number[] }) {
    const number = Math.round(Number(value));
    const clamped = Math.max(bounds.min, Math.min(bounds.max, Number.isFinite(number) ? number : bounds.min));
    return bounds.values?.length ? bounds.values.reduce((best, candidate) => Math.abs(candidate - clamped) < Math.abs(best - clamped) ? candidate : best) : clamped;
}

export function VideoDurationControl({ value, bounds, onChange }: { value: string; bounds: { min: number; max: number; values?: number[] }; onChange: (value: string) => void }) {
    const seconds = boundVideoSeconds(value, bounds);
    const [draft, setDraft] = useState(String(seconds));
    useEffect(() => setDraft(String(seconds)), [seconds]);
    const commit = () => { const next = String(boundVideoSeconds(draft, bounds)); setDraft(next); onChange(next); };
    return <div className="flex min-w-0 items-center gap-3">
        <input aria-label="视频时长" type="range" min={bounds.min} max={bounds.max} step={1} value={seconds} className="min-w-0 flex-1 accent-stone-900 dark:accent-stone-100" onChange={event => { const next = String(boundVideoSeconds(event.target.value, bounds)); setDraft(next); onChange(next); }} />
        <label className="flex h-9 w-24 shrink-0 items-center gap-1 rounded-lg border border-stone-300/60 px-2 text-xs dark:border-stone-700"><input aria-label="自定义视频时长" type="number" inputMode="numeric" min={bounds.min} max={bounds.max} step={1} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} className="w-full min-w-0 bg-transparent text-sm outline-none" /><span>秒</span></label>
    </div>;
}

export function videoResolutionLabel(value: string) {
    const resolution = normalizeVideoResolutionValue(value);
    return resolution.toLowerCase().endsWith("k") ? resolution : `${resolution}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    if (ratio === value) return seedanceRatioOptions.find((item) => item.value === ratio)?.label || ratio;
    const presetRatio = seedanceRatioOptions.find((item) =>
        item.value !== "adaptive" && videoResolutionOptions.some((resolution) => seedancePixelLabel(resolution.value, item.value) === value),
    );
    if (presetRatio) return presetRatio.label;
    const size = normalizeVideoSizeValue(value);
    return sizeOptions.find((item) => item.value === size)?.label || size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return "智能";
    return `${value || "6"}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

export function videoSizeForResolution(resolution: string, size: string) {
    const ratio = normalizeSeedanceRatio(size);
    if (ratio === "adaptive") return "auto";
    const normalizedResolution = normalizeVideoResolutionValue(resolution);
    if (!videoResolutionOptions.some((item) => item.value === normalizedResolution.toLowerCase())) return normalizeVideoSizeValue(size);
    return seedancePixelLabel(normalizedResolution, ratio);
}

export function videoSizeOptions(resolution: string) {
    const normalizedResolution = normalizeVideoResolutionValue(resolution);
    return seedanceRatioOptions.map((item) => {
        const value = item.value === "adaptive" ? "auto" : seedancePixelLabel(normalizedResolution, item.value);
        return { value, label: value };
    });
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="text" className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            {/^\d{3,}$/.test(value.trim()) ? (
                <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                    p
                </span>
            ) : null}
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange, onBlur }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void; onBlur?: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => onBlur?.(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function AudioGenerationSetting({ checked, hint, theme, onChange }: { checked: boolean; hint?: string; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <SettingGroup title="音频生成" color={theme.node.muted}>
            <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                <SwitchRow label="是否生成与视频同步的AI音频" checked={checked} theme={theme} onChange={onChange} />
                {hint ? <div className="text-[11px] leading-4 opacity-55">{hint}</div> : null}
            </div>
        </SettingGroup>
    );
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}

