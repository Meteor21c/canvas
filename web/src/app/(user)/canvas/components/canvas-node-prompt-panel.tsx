"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, LoaderCircle, Maximize2, Square } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { PriceSummary } from "@/components/pricing/price-summary";
import { useVideoSelection } from "@/hooks/use-video-selection";
import { useAutoDLWorkflow } from "@/hooks/use-autodl-workflow";
import { getAutoDLCapabilities, isAutoDLConfig } from "@/lib/autodl";
import { REFERENCE_UPLOAD_NOTICE } from "@/lib/meteor-video-input";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasVideoSettingsPopover, type CanvasVideoFrameOption, type CanvasVideoResourceOption } from "./canvas-video-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type ViewportTransform } from "../types";
import { PANORAMA_IMAGE_SIZE, isCanvasImageNodeType, isPanoramaNodeType } from "../utils/canvas-panorama";
import type { CanvasResourceKind, CanvasResourceReference } from "../utils/canvas-resource-references";

export type { CanvasVideoFrameOption };

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    viewport: ViewportTransform;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string, allowedKinds?: CanvasResourceKind[]) => void;
    videoFrameOptions?: CanvasVideoFrameOption[];
    videoResourceOptions?: CanvasVideoResourceOption[];
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, viewport, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], connectedNodes = [], videoFrameOptions = [], videoResourceOptions = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const videoSelection = useVideoSelection(config, (key, value) => onConfigChange(node.id, videoConfigPatch(key, value)), mode === "video");
    const siteVideo = mode === "video" && (config.videoChannelId || config.activeChannelId).startsWith("meteor-key-");
    const videoInput = siteVideo ? videoSelection.data?.videoInput : undefined;
    const referenceKinds: CanvasResourceKind[] | undefined = siteVideo ? ["text", ...(videoInput?.modes.includes("reference") ? videoInput.referenceTypes.filter((kind): kind is "image" | "video" | "audio" => kind === "image" || kind === "video" || kind === "audio") : []), ...(videoInput?.modes.includes("frames") && (videoInput.firstFrame || videoInput.lastFrame) ? ["image" as const] : [])] : undefined;
    const selectableMentions = referenceKinds ? mentionReferences.filter((reference) => referenceKinds.includes(reference.kind)) : mentionReferences;
    const selectableFrames = siteVideo && !videoInput?.modes.includes("frames") ? [] : videoFrameOptions;
    const selectableResources = siteVideo ? videoResourceOptions.filter((resource) => resource.kind === "text" || Boolean(videoInput?.modes.includes("reference") && videoInput.referenceTypes.includes(resource.kind))) : videoResourceOptions;
    const startReferenceSelection = (nodeId: string) => onStartReferenceSelection?.(nodeId, referenceKinds);
    const incompatibleFrames = Boolean(siteVideo && videoInput && ((node.metadata?.firstFrameNodeId && (!videoInput.modes.includes("frames") || !videoInput.firstFrame)) || (node.metadata?.lastFrameNodeId && (!videoInput.modes.includes("frames") || !videoInput.lastFrame || (videoInput.lastFrameRequiresFirst && !node.metadata.firstFrameNodeId)))));
    const { data: autodlWorkflow } = useAutoDLWorkflow(config, mode === "video" ? config.model : "");
    const isPanorama = isPanoramaNodeType(node.type);
    const textOverwrite = node.type === CanvasNodeType.Text && globalConfig.nodeRegenerateBehavior === "overwrite" && Boolean(node.metadata?.clientTaskId);
    const mediaLoading = (isCanvasImageNodeType(node.type) || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || textOverwrite) && node.metadata?.status === "loading";
    const isStopping = node.metadata?.status === "stopping";
    const stopFailed = isStopping && Boolean(node.metadata?.errorDetails);
    const canStop = Boolean(node.metadata?.clientTaskId) && !node.metadata?.isBatchRoot && (mediaLoading || stopFailed);
    const generating = (isRunning && node.metadata?.status !== "stopped") || mediaLoading;
    const showStop = canStop || isStopping;
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = isCanvasImageNodeType(node.type) && Boolean(node.metadata?.content);
    const sourcePrompt = isPanorama ? node.metadata?.panoramaSourcePrompt || "" : node.metadata?.prompt || "";
    const [prompt, setPrompt] = useState(sourcePrompt);
    const [expanded, setExpanded] = useState(false);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelLayout, setPanelLayout] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
    const workflowRef = node.metadata?.workflowRef;
    const billingModel = workflowRef
        ? `workflow:${workflowRef.scope}:${workflowRef.channelId}:${workflowRef.kind}:${workflowRef.workflowId}`
        : config.model;
    const credits = requestCreditCost({ channelMode: config.channelMode, modelCosts, model: billingModel, count: mode === "image" ? config.count : 1, seconds: mode === "video" ? config.videoSeconds : undefined });

    useEffect(() => {
        setPrompt(sourcePrompt);
    }, [node.id, sourcePrompt]);

    useEffect(() => setPortalTarget(document.body), []);

    // Keep screen UI outside the canvas transform and within the usable viewport.
    useLayoutEffect(() => {
        if (!portalTarget || !panelRef.current) return;
        const update = () => {
            const visualViewport = window.visualViewport;
            const viewportWidth = visualViewport?.width || window.innerWidth;
            const viewportHeight = visualViewport?.height || window.innerHeight;
            const offsetLeft = visualViewport?.offsetLeft || 0;
            const safeTop = (visualViewport?.offsetTop || 0) + 72;
            const safeBottom = (visualViewport?.offsetTop || 0) + viewportHeight - 88;
            const width = Math.min(560, viewportWidth - 24);
            const maxHeight = Math.max(80, safeBottom - safeTop);
            const height = Math.min(panelRef.current?.offsetHeight || maxHeight, maxHeight);
            const anchor = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`)?.getBoundingClientRect();
            const left = Math.max(offsetLeft + 12, Math.min((anchor ? anchor.left + anchor.width / 2 : offsetLeft + viewportWidth / 2) - width / 2, offsetLeft + viewportWidth - width - 12));
            const preferredTop = viewportWidth < 640 ? safeBottom - height : (anchor?.bottom ?? safeTop) + 12;
            const top = Math.max(safeTop, Math.min(preferredTop, safeBottom - height));
            setPanelLayout((current) => current && current.left === left && current.top === top && current.width === width && current.maxHeight === maxHeight ? current : { left, top, width, maxHeight });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(panelRef.current);
        window.addEventListener("resize", update);
        window.visualViewport?.addEventListener("resize", update);
        window.visualViewport?.addEventListener("scroll", update);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
            window.visualViewport?.removeEventListener("resize", update);
            window.visualViewport?.removeEventListener("scroll", update);
        };
    }, [portalTarget, node.id, node.position.x, node.position.y, node.width, node.height, viewport.x, viewport.y, viewport.k]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        onPromptChange(node.id, value);
    };

    const canSubmit = node.metadata?.status === "stopped" || Boolean(prompt.trim()) || (mode !== "text" && Boolean(node.metadata?.workflowRef)) || (mode === "video" && isAutoDLConfig(config) && getAutoDLCapabilities(autodlWorkflow)?.promptRequired === false) || (isPanorama && (hasImageContent || mentionReferences.length > 0));

    const submit = () => {
        const text = prompt.trim();
        if (!canSubmit || generating || isStopping || (mode === "video" && !videoSelection.valid)) return;
        onGenerate(node.id, mode, text);
    };

    const panel = (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            data-canvas-prompt-panel
            aria-label="节点生成参数与费用"
            className="thin-scrollbar fixed z-[80] overflow-y-auto overscroll-contain rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ ...panelLayout, visibility: panelLayout ? "visible" : "hidden", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={startReferenceSelection} />
            {siteVideo ? <p className="mb-2 text-[10px] leading-4 opacity-60">{REFERENCE_UPLOAD_NOTICE} · 素材保留7天</p> : null}
            {incompatibleFrames ? <p className="mb-2 text-xs leading-4 text-amber-600 dark:text-amber-400">已保留原首尾帧选择；当前模型不支持该组合，请在视频设置中调整或明确移除后再生成。</p> : null}
            <CanvasPromptChipInput
                value={prompt}
                references={selectableMentions}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-24 max-h-[18dvh] min-h-16 w-full resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={isPanorama ? "描述想生成的全景，或上传/连接图片作为参考" : promptPlaceholder(mode, hasImageContent, hasTextContent)}
            />

            <div className="mt-3 min-w-0 space-y-2" data-canvas-prompt-controls>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_148px] items-center gap-2 [&>*:only-child]:col-span-2">
                    {mode === "image" ? (
                        <>
                            <ModelPicker className="!h-10 !w-full !min-w-0 !max-w-none" config={config} value={config.model} channelId={config.imageChannelId} workflowRef={node.metadata?.workflowRef} onWorkflowChange={(workflowRef) => onConfigChange(node.id, { workflowRef })} onChange={(model, channelId) => onConfigChange(node.id, { model, channelId })} capability="image" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasImageSettingsPopover
                                config={node.metadata?.workflowRef ? { ...config, model: "" } : config}
                                placement="topLeft"
                                buttonClassName="!h-10 !w-[148px] !shrink-0 !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                                showSize={!isPanorama}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker className="!h-10 !w-full !min-w-0 !max-w-none" config={config} value={config.model} channelId={config.videoChannelId} workflowRef={node.metadata?.workflowRef} onWorkflowChange={(workflowRef) => onConfigChange(node.id, { workflowRef })} onChange={(model, channelId) => onConfigChange(node.id, { model, channelId })} capability="video" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !w-[148px] !shrink-0 !justify-start !rounded-full !px-3" frameOptions={selectableFrames} resourceOptions={selectableResources} metadata={node.metadata} firstFrameNodeId={node.metadata?.firstFrameNodeId} lastFrameNodeId={node.metadata?.lastFrameNodeId} onFrameChange={(patch) => onConfigChange(node.id, patch)} onMetadataChange={(patch) => onConfigChange(node.id, patch)} onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker className="!h-10 !w-full !min-w-0 !max-w-none" config={config} value={config.model} channelId={config.audioChannelId || config.activeChannelId} workflowRef={node.metadata?.workflowRef} onWorkflowChange={(workflowRef) => onConfigChange(node.id, { workflowRef })} onChange={(model, channelId) => onConfigChange(node.id, { model, channelId })} capability="audio" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasAudioSettingsPopover config={config} resourceOptions={videoResourceOptions} metadata={node.metadata} onMetadataChange={(patch) => onConfigChange(node.id, patch)} buttonClassName="!h-10 !w-[148px] !shrink-0 !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <ModelPicker className="!h-10 !w-full !min-w-0 !max-w-none" config={config} value={config.model} channelId={config.textChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, channelId })} capability="text" onMissingConfig={() => openConfigDialog(true)} />
                    )}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Tooltip title="放大编辑">
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={() => setExpanded(true)} aria-label="放大编辑" />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "video" || (mode === "image" && !isPanorama) ? (
                        <CanvasCameraControl value={node.metadata?.cameraControl} onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })} buttonClassName="!h-10 !min-w-[92px] !justify-start !rounded-full !px-3" />
                    ) : null}
                <Button
                    type="primary"
                    danger={showStop}
                    className="!ml-auto !h-10 !min-w-20 shrink-0 !rounded-full !px-4"
                    disabled={(isStopping && !stopFailed) || (!canStop && (generating || !canSubmit || (mode === "video" && !videoSelection.valid)))}
                    onClick={canStop ? () => onStop(node.id) : submit}
                    aria-label={canStop ? stopFailed ? "重试停止" : "停止" : isStopping ? "停止中" : "生成"}
                >
                    <span className="relative inline-flex">
                        <span className={`flex items-center gap-1.5${showStop ? " invisible" : ""}`}>
                            <span className="text-sm font-medium">生成</span>
                            {generating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                        </span>
                        {showStop ? <span className="absolute inset-0 flex items-center justify-center">
                            {isStopping && !stopFailed ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3.5" fill="currentColor" />}
                        </span> : null}
                    </span>
                </Button>
                </div>
            </div>
            {mode === "image" || mode === "video" ? <div className="mt-3 border-t border-stone-200/70 pt-3 dark:border-stone-700/70"><PriceSummary config={config} capability={mode} model={config.model} inputVideo={connectedNodes.some(item => item.type === CanvasNodeType.Video)} compact /></div> : null}
            <Modal title="编辑提示词" open={expanded} centered width={760} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); startReferenceSelection(nodeId); }} />
                    <CanvasPromptChipInput
                        value={prompt}
                        references={selectableMentions}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] max-h-[calc(100dvh-220px)] min-h-32 w-full cursor-text overflow-y-auto rounded-2xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={isPanorama ? "描述想生成的全景，或上传/连接图片作为参考" : promptPlaceholder(mode, hasImageContent, hasTextContent)}
                    />
                </div>
            </Modal>
        </div>
    );
    return portalTarget ? createPortal(panel, portalTarget) : null;
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    const channelId = node.metadata?.channelId || "";
    const imageChannelId = mode === "image" ? channelId || globalConfig.imageChannelId : globalConfig.imageChannelId;
    const videoChannelId = mode === "video" ? channelId || globalConfig.videoChannelId : globalConfig.videoChannelId;
    const textChannelId = mode === "text" ? channelId || globalConfig.textChannelId : globalConfig.textChannelId;
    const audioChannelId = mode === "audio" ? channelId || globalConfig.audioChannelId : globalConfig.audioChannelId;
    const activeChannelId = mode === "image" ? imageChannelId : mode === "video" ? videoChannelId : mode === "text" ? textChannelId : mode === "audio" ? audioChannelId || globalConfig.activeChannelId : globalConfig.activeChannelId;
    return {
        ...globalConfig,
        model: mode === "text" ? resolveModelForCapability(globalConfig, node.metadata?.model, "text") : node.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : globalConfig.model || defaultConfig.model),
        activeChannelId,
        imageChannelId,
        videoChannelId,
        textChannelId,
        audioChannelId,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        imageResolution: node.metadata?.imageResolution || globalConfig.imageResolution || defaultConfig.imageResolution,
        size: isPanoramaNodeType(node.type) ? PANORAMA_IMAGE_SIZE : node.metadata?.size || (mode === "video" ? globalConfig.videoSize || defaultConfig.videoSize : globalConfig.size || defaultConfig.size),
        videoSeconds: isAutoDLConfig({ ...globalConfig, activeChannelId, videoChannelId }, node.metadata?.model || defaultModel) ? node.metadata?.seconds ?? globalConfig.videoSeconds : node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoMode: node.metadata?.mode || globalConfig.videoMode || defaultConfig.videoMode,
        videoNegativePrompt: node.metadata?.negativePrompt || globalConfig.videoNegativePrompt || defaultConfig.videoNegativePrompt,
        videoMultiShot: node.metadata?.multiShot || globalConfig.videoMultiShot || defaultConfig.videoMultiShot,
        videoShotType: node.metadata?.shotType || globalConfig.videoShotType || defaultConfig.videoShotType,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoCharacterOrientation: node.metadata?.characterOrientation || globalConfig.videoCharacterOrientation || defaultConfig.videoCharacterOrientation,
        videoWatermark: "false",
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        grokTtsVoice: node.metadata?.grokTtsVoice || globalConfig.grokTtsVoice || defaultConfig.grokTtsVoice,
        grokTtsLanguage: node.metadata?.grokTtsLanguage || globalConfig.grokTtsLanguage || defaultConfig.grokTtsLanguage,
        grokTtsFormat: node.metadata?.grokTtsFormat || globalConfig.grokTtsFormat || defaultConfig.grokTtsFormat,
        grokTtsSpeed: node.metadata?.grokTtsSpeed || globalConfig.grokTtsSpeed || defaultConfig.grokTtsSpeed,
        glmTtsVoice: node.metadata?.glmTtsVoice || globalConfig.glmTtsVoice || defaultConfig.glmTtsVoice,
        glmTtsFormat: node.metadata?.glmTtsFormat || globalConfig.glmTtsFormat || defaultConfig.glmTtsFormat,
        glmTtsSpeed: node.metadata?.glmTtsSpeed || globalConfig.glmTtsSpeed || defaultConfig.glmTtsSpeed,
        mimoTtsVoice: node.metadata?.mimoTtsVoice || globalConfig.mimoTtsVoice || defaultConfig.mimoTtsVoice,
        mimoTtsFormat: node.metadata?.mimoTtsFormat || globalConfig.mimoTtsFormat || defaultConfig.mimoTtsFormat,
        mimoVoiceDesignPrompt: node.metadata?.mimoVoiceDesignPrompt || globalConfig.mimoVoiceDesignPrompt || defaultConfig.mimoVoiceDesignPrompt,
        geminiTtsVoice: node.metadata?.geminiTtsVoice || globalConfig.geminiTtsVoice || defaultConfig.geminiTtsVoice,
        count: String(Math.max(1, Math.min(4, Number(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : 1)) || 1))),
        apiMode: "images",
    };
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoMode") return { mode: value };
    if (key === "videoNegativePrompt") return { negativePrompt: value };
    if (key === "videoMultiShot") return { multiShot: value };
    if (key === "videoShotType") return { shotType: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoCharacterOrientation") return { characterOrientation: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string): Partial<CanvasNodeMetadata> {
    return { [key]: value } as Partial<CanvasNodeMetadata>;
}
