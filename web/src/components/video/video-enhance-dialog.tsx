"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { App, Modal } from "antd";
import { Download, FolderOpen, LoaderCircle, Sparkles, Upload } from "lucide-react";
import { AssetPickerModal } from "@/app/(user)/canvas/components/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { QuoteDetails } from "@/components/pricing/price-summary";
import { useMeteorCapabilities, useMeteorQuote } from "@/hooks/use-meteor-pricing";
import { assertReferenceFileSize } from "@/lib/meteor-video-input";
import { createVideoEnhancement, getVideoEnhancement, listVideoEnhancements, VIDEO_ENHANCE_MODEL, type EnhanceTask } from "@/services/api/video-enhance";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { downloadVideoFile } from "@/services/media-download";
import { normalizeLocalChannels, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type EnhanceResult = { taskId: string; videoUrl: string; prompt: string; expiresAt?: number; resolution?: string; frameRate?: number };
type Props = { sourceVideoUrl?: string; onCompleted?: (result: EnhanceResult) => void };
const complete = (task: EnhanceTask) => ["completed", "succeeded", "success", "done"].includes(task.status || "");
const failed = (task: EnhanceTask) => ["failed", "cancelled", "expired", "result_expired"].includes(task.status || "");
const taskExpiry = (task: EnhanceTask) => Date.parse(task.expiresAt || task.expires_at || "") || (task.completed_at ? Date.parse(task.completed_at) + 86400000 : 0);
const errorText = (error: unknown, fallback: string) => (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg || (error instanceof Error && !(error as { isAxiosError?: boolean }).isAxiosError ? error.message : fallback);
const control = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground";

export function VideoEnhanceDialog({ open, onClose, ...props }: Props & { open: boolean; onClose: () => void }) {
    return <Modal title="增强画质" open={open} onCancel={onClose} footer={null} width={780} destroyOnHidden><VideoEnhancePanel {...props} /></Modal>;
}

export function VideoEnhancePanel({ sourceVideoUrl = "", onCompleted }: Props) {
    const config = useEffectiveConfig();
    const token = useUserStore(state => state.token);
    const { message } = App.useApp();
    const owner = useRef(token); owner.current = token;
    const busyRef = useRef(false);
    const session = useRef(0);
    const activeTaskId = useRef("");
    const lastRenewal = useRef(new Map<string, number>());
    const pendingRequest = useRef("");
    const submittedTask = useRef("");
    const input = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState(sourceVideoUrl);
    const [duration, setDuration] = useState(0);
    const [resolution, setResolution] = useState("1080p");
    const [frameRate, setFrameRate] = useState(30);
    const [selectedChannel, setSelectedChannel] = useState("");
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [picker, setPicker] = useState(false);
    const [task, setTask] = useState<EnhanceTask | null>(null);
    const [history, setHistory] = useState<EnhanceTask[]>([]);
    const [clock, setClock] = useState(Date.now());
    const [statusError, setStatusError] = useState("");
    const [refreshingTask, setRefreshingTask] = useState(false);
    const notified = useRef(new Set<string>());
    const onCompletedRef = useRef(onCompleted); onCompletedRef.current = onCompleted;
    const choices = useMemo(() => (config.channelMode === "remote" ? config.publicChannels : normalizeLocalChannels(config)).filter(channel => channel.models?.includes(VIDEO_ENHANCE_MODEL)), [config]);
    const channelId = choices.find(channel => channel.id === selectedChannel)?.id || choices[0]?.id || "";
    const personal = config.channelMode !== "remote";
    const pickerConfig = useMemo(() => ({ ...config, model: VIDEO_ENHANCE_MODEL, videoModel: VIDEO_ENHANCE_MODEL, videoChannelId: channelId, activeChannelId: channelId, publicChannels: config.publicChannels.map(channel => ({ ...channel, models: channel.models?.filter(model => model === VIDEO_ENHANCE_MODEL) })), localChannels: normalizeLocalChannels(config).map(channel => ({ ...channel, models: channel.models.filter(model => model === VIDEO_ENHANCE_MODEL) })) }), [config, channelId]);
    const caps = useMeteorCapabilities({ kind: "video", model: VIDEO_ENHANCE_MODEL, channelId }, Boolean(channelId));
    const quote = useMeteorQuote({ kind: "video", model: VIDEO_ENHANCE_MODEL, channelId, count: 1, resolution, frameRate, sourceDurationSeconds: duration || undefined, quality: "auto", size: "", audio: false, inputVideo: true }, Boolean(channelId));
    const running = Boolean(task && !complete(task) && !failed(task));
    const awaitingConfirmation = Boolean(pendingRequest.current);
    const statusNotice = statusError || (task?.status === "submission_unknown" ? "提交状态待确认，请稍后刷新" : "");
    const url = task?.video_url || task?.url || "";
    const expiresAt = task ? taskExpiry(task) : 0;
    const expired = expiresAt > 0 && clock >= expiresAt;

    useEffect(() => {
        const currentSession = ++session.current;
        setTask(null); setHistory([]); setSource(sourceVideoUrl); setDuration(0); setUploading(false); setSubmitting(false); setPicker(false); setStatusError(""); setRefreshingTask(false); setClock(Date.now());
        busyRef.current = false; activeTaskId.current = ""; pendingRequest.current = ""; submittedTask.current = ""; notified.current.clear(); lastRenewal.current.clear();
        return () => { if (session.current === currentSession) session.current++; };
    }, [token, sourceVideoUrl]);
    const refreshHistory = useCallback(async (signal?: AbortSignal) => {
        const currentOwner = token, currentSession = session.current;
        const items = await listVideoEnhancements(signal);
        if (!signal?.aborted && owner.current === currentOwner && session.current === currentSession) setHistory(items);
    }, [token]);
    const refreshTask = useCallback(async (id: string, signal?: AbortSignal) => {
        const currentOwner = token, currentSession = session.current;
        try {
            const next = await getVideoEnhancement(id, "", false, signal);
            if (signal?.aborted || owner.current !== currentOwner || session.current !== currentSession || activeTaskId.current !== id) return;
            setTask(next); setStatusError(""); setClock(Date.now());
            if (pendingRequest.current === id) { submittedTask.current = next.id; pendingRequest.current = ""; }
            if (complete(next) || failed(next)) { void useUserStore.getState().hydrateUser(); void refreshHistory().catch(() => {}); }
            return next;
        } catch {
            if (!signal?.aborted && owner.current === currentOwner && session.current === currentSession && activeTaskId.current === id) setStatusError("状态更新暂不可用，请刷新重试");
        }
    }, [token, refreshHistory]);
    const refreshCurrentTask = async () => {
        const id = task?.id || pendingRequest.current;
        if (!id || refreshingTask) return;
        const currentOwner = token, currentSession = session.current;
        activeTaskId.current = id; setRefreshingTask(true);
        try { await refreshTask(id); }
        finally { if (owner.current === currentOwner && session.current === currentSession) setRefreshingTask(false); }
    };
    const renewResult = (id: string) => {
        if (Date.now() - (lastRenewal.current.get(id) || 0) < 10000) return;
        lastRenewal.current.set(id, Date.now());
        void refreshTask(id);
    };
    const downloadResult = async (item: EnhanceTask) => {
        const currentOwner = token, currentSession = session.current;
        const fresh = await refreshTask(item.id);
        if (!fresh) return;
        if (failed(fresh) || (taskExpiry(fresh) && Date.now() >= taskExpiry(fresh))) return message.info("下载已到期，请使用已保存的本地文件");
        const freshUrl = fresh.video_url || fresh.url;
        if (!freshUrl) return message.error("视频暂不可用，请刷新重试");
        try { await downloadVideoFile(freshUrl, undefined, `增强视频-${fresh.id}.mp4`); }
        catch { if (owner.current === currentOwner && session.current === currentSession) message.error("下载失败，请重试"); }
    };
    useEffect(() => {
        if (!token) return;
        const abort = new AbortController();
        void refreshHistory(abort.signal).catch(() => {});
        const timer = setInterval(() => setClock(Date.now()), 30000);
        return () => { abort.abort(); clearInterval(timer); };
    }, [token, sourceVideoUrl, refreshHistory]);
    useEffect(() => {
        if (!running || !task) return;
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            const next = await refreshTask(task.id, abort.signal);
            if (abort.signal.aborted || (next && (complete(next) || failed(next)))) return;
            timer = setTimeout(poll, next ? 5000 : 15000);
        };
        timer = setTimeout(poll, 3000);
        return () => { abort.abort(); clearTimeout(timer); };
    }, [running, task?.id, token, refreshTask]);
    useEffect(() => {
        if (!task || task.id !== submittedTask.current || !complete(task) || !url || expired || notified.current.has(task.id)) return;
        notified.current.add(task.id);
        onCompletedRef.current?.({ taskId: task.id, videoUrl: url, prompt: "视频增强", expiresAt: expiresAt || undefined, resolution: task.resolution || resolution, frameRate });
    }, [task, url, expired, expiresAt, resolution, frameRate]);

    const upload = async (file?: File) => {
        if (!file || uploading || submitting || running || pendingRequest.current) return;
        const currentOwner = token, currentSession = session.current;
        try {
            if (!file.type.startsWith("video/")) throw new Error("请选择 MP4、MOV 或 WebM 视频");
            assertReferenceFileSize(file);
            setUploading(true);
            const media = await uploadMediaFile(file, "enhance-source", undefined, token || "");
            if (owner.current !== currentOwner || session.current !== currentSession) return;
            if (!media.storageKey.startsWith("server:")) throw new Error("上传未完成，请重试");
            const mediaUrl = await resolveMediaUrl(media.storageKey);
            if (owner.current !== currentOwner || session.current !== currentSession) return;
            if (!mediaUrl) throw new Error("视频读取失败，请重新上传");
            setSource(mediaUrl); setDuration((media.durationMs || 0) / 1000); setTask(null); setStatusError(""); activeTaskId.current = "";
        } catch (error) { if (owner.current === currentOwner && session.current === currentSession) message.error(error instanceof Error ? error.message : "上传失败，请重试"); }
        finally { if (owner.current === currentOwner && session.current === currentSession) setUploading(false); }
    };
    const start = async () => {
        if (busyRef.current || !token || !source || !channelId || !quote.data?.available || !caps.data?.available) return;
        const currentOwner = token, currentSession = session.current;
        pendingRequest.current ||= `client_video_task_enhance_${nanoid()}`;
        busyRef.current = true; activeTaskId.current = pendingRequest.current; setSubmitting(true); setStatusError("");
        try {
            const created = await createVideoEnhancement({ channelId, personal, url: source, resolution, frameRate, sourceDurationSeconds: duration || undefined, source: onCompleted ? "canvas" : "video-workbench", clientTaskId: pendingRequest.current });
            if (owner.current === currentOwner && session.current === currentSession) { activeTaskId.current = created.id; submittedTask.current = created.id; pendingRequest.current = ""; setTask(created); }
        } catch (error) {
            if (owner.current === currentOwner && session.current === currentSession) {
                const status = (error as { response?: { status?: number }; code?: number })?.response?.status || Number((error as { code?: number })?.code);
                if ([400, 401, 403, 413, 415, 422].includes(status || 0)) {
                    pendingRequest.current = ""; activeTaskId.current = ""; setStatusError("");
                    message.error(errorText(error, "提交失败，请检查视频与所选参数"));
                } else {
                    setStatusError("提交状态待确认，请先刷新状态");
                    message.error(errorText(error, "提交状态待确认，请先刷新状态"));
                }
            }
        }
        finally { if (owner.current === currentOwner && session.current === currentSession) { busyRef.current = false; setSubmitting(false); } }
    };

    return <div className="mx-auto w-full max-w-4xl space-y-5 p-2 sm:p-4">
        <div className="rounded-xl border border-amber-400/50 bg-amber-400/10 px-4 py-3 text-sm font-medium">增强结果可下载 24 小时，请及时保存到本地。</div>
        <div className="grid gap-5 md:grid-cols-2"><section className="min-w-0 space-y-3">
            {source ? <video className="aspect-video w-full rounded-xl bg-black" src={source} controls preload="metadata" onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }} /> : <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">选择需要增强的视频</div>}
            <div className="flex flex-wrap gap-2"><button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={uploading || submitting || running || awaitingConfirmation} onClick={() => input.current?.click()}><Upload className="size-4" />{uploading ? "上传中…" : "上传视频"}</button><button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={uploading || submitting || running || awaitingConfirmation} onClick={() => setPicker(true)}><FolderOpen className="size-4" />我的素材</button></div>
            <p className="text-xs text-muted-foreground">视频最大 50 MB、最长 5 分钟{duration > 0 ? ` · ${duration.toFixed(1)} 秒` : ""}</p>
        </section><section className="min-w-0 space-y-4">
            <fieldset disabled={running || submitting || awaitingConfirmation} className="min-w-0 space-y-4 disabled:opacity-60"><label className="block space-y-2 text-sm"><span>模型 / 分组</span><ModelPicker config={pickerConfig} capability="video" value={VIDEO_ENHANCE_MODEL} channelId={channelId} onChange={(_, id) => setSelectedChannel(id || "")} fullWidth /></label>
            <div className="grid grid-cols-2 gap-3"><label className="block space-y-2 text-sm"><span>目标清晰度</span><select className={control} value={resolution} onChange={event => setResolution(event.target.value)}>{(caps.data?.resolutions.length ? caps.data.resolutions : ["720p", "1080p", "2k", "4k"]).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label><label className="block space-y-2 text-sm"><span>帧率档位</span><select className={control} value={frameRate} onChange={event => setFrameRate(Number(event.target.value))}>{(caps.data?.frameRates?.length ? caps.data.frameRates : [30, 60, 120]).map(value => <option key={value} value={value}>{value} FPS</option>)}</select></label></div></fieldset>
            <div className="rounded-xl border border-border p-3">{quote.data ? <QuoteDetails quote={quote.data} resolution={resolution} compact /> : <p className="text-xs text-muted-foreground">{!choices.length ? "当前分组未开放视频增强" : quote.isLoading ? "正在读取价格…" : "报价暂不可用，请稍后重试"}</p>}</div>
            <a href={`/studio/pricing?kind=video&model=${VIDEO_ENHANCE_MODEL}&channelId=${encodeURIComponent(channelId)}`} className="inline-block text-xs underline underline-offset-2">计价标准</a>
            <button style={{ color: "var(--background)" }} className="flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 text-sm font-medium text-background disabled:opacity-40" disabled={!source || !token || uploading || submitting || running || !caps.data?.available || !quote.data?.available} onClick={() => void start()}>{submitting || running ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{submitting ? "正在提交…" : running ? `增强中${task?.progress ? ` ${task.progress}%` : "…"}` : awaitingConfirmation ? "重试提交" : "开始增强"}</button>
            {statusNotice ? <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-400/10 p-3 text-xs text-amber-700 dark:text-amber-300"><span>{statusNotice}</span><button type="button" disabled={refreshingTask || submitting} className="shrink-0 underline underline-offset-2 disabled:opacity-50" onClick={() => void refreshCurrentTask()}>{refreshingTask ? "刷新中…" : "刷新状态"}</button></div> : null}
        </section></div>
        {task && failed(task) ? <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{task.error?.message || "增强未完成，请查看用量记录"}</p> : null}
        {task && complete(task) ? <section className="space-y-3 rounded-xl border border-border p-4"><h3 className="text-sm font-medium">增强结果</h3>{expired ? <p className="text-sm text-muted-foreground">下载已到期</p> : <><video controls src={url} className="max-h-80 w-full rounded-lg bg-black" preload="metadata" onError={() => renewResult(task.id)} /><button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" onClick={() => void downloadResult(task)}><Download className="size-4" />保存到本地</button>{expiresAt ? <p className="text-xs text-muted-foreground">下载截止：{new Date(expiresAt).toLocaleString("zh-CN")}</p> : null}</>}</section> : null}
        {history.length ? <section className="space-y-2 border-t border-border pt-4"><h3 className="text-sm font-medium">最近增强</h3><div className="flex flex-wrap gap-2">{history.slice(0, 12).map(item => <button key={item.id} disabled={uploading || submitting || awaitingConfirmation} className="max-w-full truncate rounded-lg border px-3 py-2 text-xs disabled:opacity-50" onClick={() => { activeTaskId.current = item.id; setTask(item); setStatusError(""); void refreshTask(item.id); }}>{complete(item) ? "已完成" : failed(item) ? "未完成" : "处理中"} · {String(item.created_at || item.createdAt || item.id).slice(0, 22)}</button>)}</div></section> : null}
        <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        <AssetPickerModal open={picker} allowedKinds={["video"]} onClose={() => setPicker(false)} onInsert={asset => { if (asset.kind !== "video" || uploading || submitting || running || pendingRequest.current) return; setSource(asset.url || ""); setDuration(0); setTask(null); setStatusError(""); activeTaskId.current = ""; setPicker(false); }} />
    </div>;
}
