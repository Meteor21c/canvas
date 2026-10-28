"use client";

import { useEffect, useState } from "react";
import { App, Button } from "antd";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { getMeteorImageQuote } from "@/services/api/meteor-gateway";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import type { CanvasVideoFrameOption, CanvasVideoResourceOption } from "./canvas-video-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

export type { CanvasVideoFrameOption };
export type CanvasNodeGenerationMode = CanvasGenerationMode;
type Props = { node: CanvasNodeData; isRunning: boolean; onPromptChange: (id: string, prompt: string) => void; onConfigChange: (id: string, patch: Partial<CanvasNodeData["metadata"]>) => void; onGenerate: (id: string, mode: CanvasGenerationMode, prompt: string) => void; mentionReferences?: CanvasResourceReference[]; connectedNodes?: CanvasNodeData[]; onDisconnectReference?: (from: string, to: string) => void; onStartReferenceSelection?: (id: string) => void; videoFrameOptions?: CanvasVideoFrameOption[]; videoResourceOptions?: CanvasVideoResourceOption[]; onImageSettingsOpenChange?: (open: boolean) => void };
export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, mentionReferences = [], connectedNodes = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange }: Props) {
    const global = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message } = App.useApp();
    const [prompt, setPrompt] = useState(node.metadata?.prompt || "");
    useEffect(() => { setPrompt(node.metadata?.prompt || ""); }, [node.id, node.metadata?.prompt]);
    const channel = node.metadata?.channelId || global.imageChannelId || global.activeChannelId;
    const config = { ...global, model: node.metadata?.model || global.imageModel || global.model, imageChannelId: channel, activeChannelId: channel, quality: node.metadata?.quality || global.quality || "low", size: node.metadata?.size || global.size || "1:1", count: "1", canvasImageCount: "1" };
    if (node.type === CanvasNodeType.Text) return <div className="rounded-xl border p-3 text-xs leading-5" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.muted }}>双击文本便笺可编辑。将它连到图片节点，文字会作为生成提示词；点击上方“生图”也可创建已连接的图片节点。</div>;
    const updatePrompt = (value: string) => { setPrompt(value); onPromptChange(node.id, value); };
    const submit = () => {
        if (isRunning) return;
        if (!prompt.trim() && !connectedNodes.some(item => item.type === CanvasNodeType.Text && item.metadata?.content?.trim())) { message.info("请填写提示词，或连接文本便笺"); return; }
        onGenerate(node.id, "image", prompt.trim());
    };
    return <div data-canvas-no-zoom className="w-[460px] max-w-[calc(100vw-32px)] rounded-2xl border p-3 shadow-xl backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        <CanvasNodeReferenceBar nodeId={node.id} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
        <CanvasPromptChipInput value={prompt} references={mentionReferences} onChange={updatePrompt} onSubmit={submit} className="thin-scrollbar h-28 w-full resize-none rounded-xl px-2 py-2 text-sm outline-none" style={{ background: "transparent", color: theme.node.text }} placeholder={node.metadata?.content ? "描述如何修改当前图片；连线可添加其他参考图" : "描述要生成的图片，也可连接文本便笺和参考图"} />
        <div className="flex flex-wrap items-center gap-2"><ModelPicker className="!min-w-0 !flex-1" config={config} value={config.model} channelId={channel} capability="image" onChange={(model, channelId) => onConfigChange(node.id, { model, channelId })} onMissingConfig={() => message.info("请先在主站创建具有生图权限的 API 密钥，然后刷新画布。")} /><CanvasImageSettingsPopover config={config} onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: 1 } : { [key]: value })} onOpenChange={onImageSettingsOpenChange} showCount={false} /><Button type="primary" disabled={isRunning} onClick={submit} icon={isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}>{isRunning ? "生成中" : "生成 1 张"}</Button></div>
        <p className="mt-2 text-[11px] leading-5" style={{ color: theme.node.muted }}>{getMeteorImageQuote(config)}</p>
        <p className="text-[11px] leading-5" style={{ color: theme.node.muted }}>图片保存在当前浏览器，24 小时后清理。保存工程只保存元数据，请导出 ZIP 保留图片。</p>
    </div>;
}
