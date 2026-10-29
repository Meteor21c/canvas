"use client";

import { CheckCircle2, CircleAlert, LoaderCircle, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, Progress, Typography, type ButtonProps } from "antd";

import { formatBytes } from "@/lib/image-utils";
import { assertReferenceFileSize } from "@/lib/meteor-video-input";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

type UploadItem = {
    id: number;
    file: File;
    status: "queued" | "uploading" | "success" | "error";
    error?: string;
    retryable?: boolean;
};

export function AssetBatchUpload({ size, onUploaded }: { size?: ButtonProps["size"]; onUploaded?: (count: number) => void }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const userId = useUserStore((state) => state.user?.id);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const runIdRef = useRef(0);
    const runningRef = useRef(false);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [items, setItems] = useState<UploadItem[]>([]);

    useEffect(() => {
        runIdRef.current += 1;
        runningRef.current = false;
        setOpen(false);
        setBusy(false);
        setItems([]);
        return () => { runIdRef.current += 1; };
    }, [token, userId]);

    const selectFiles = (files: FileList | null) => {
        if (!files?.length || runningRef.current) return;
        if (files.length > 20) {
            message.warning("每批最多上传 20 张图片，请重新选择。");
            return;
        }
        setItems(Array.from(files, (file, id): UploadItem => {
            try {
                if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
                assertReferenceFileSize(file);
                return { id, file, status: "queued" };
            } catch (error) {
                return { id, file, status: "error", error: error instanceof Error ? error.message : "图片不符合上传要求", retryable: false };
            }
        }));
    };

    const uploadItems = async (retry = false) => {
        if (runningRef.current) return;
        const pending = items.filter((item) => retry ? item.status === "error" && item.retryable : item.status === "queued");
        if (!pending.length) return;
        const owner = useUserStore.getState();
        const runId = ++runIdRef.current;
        const isCurrent = () => runIdRef.current === runId && useUserStore.getState().token === owner.token && useUserStore.getState().user?.id === owner.user?.id;
        const update = (id: number, patch: Partial<UploadItem>) => {
            if (isCurrent()) setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
        };
        runningRef.current = true;
        setBusy(true);
        let next = 0;
        let succeeded = 0;
        let failed = 0;
        const invalid = items.filter((item) => item.status === "error" && !item.retryable).length;
        const worker = async () => {
            while (next < pending.length && isCurrent()) {
                const item = pending[next++];
                update(item.id, { status: "uploading", error: undefined });
                try {
                    const image = await uploadImage(item.file, { token: owner.token });
                    if (!isCurrent()) return;
                    useAssetStore.getState().addAsset({
                        kind: "image", title: item.file.name, coverUrl: image.url, tags: [], source: "本地上传",
                        data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                    });
                    succeeded += 1;
                    update(item.id, { status: "success", retryable: false });
                } catch (error) {
                    failed += 1;
                    update(item.id, { status: "error", error: error instanceof Error ? error.message : "上传失败，请重试", retryable: true });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
        if (!isCurrent()) return;
        runningRef.current = false;
        setBusy(false);
        if (succeeded) onUploaded?.(succeeded);
        if (failed) message.warning(`已上传 ${succeeded} 张，${failed} 张上传失败，可重试失败项。${invalid ? `另有 ${invalid} 张不符合上传要求。` : ""}`);
        else if (invalid) message.warning(`已上传 ${succeeded} 张，${invalid} 张不符合上传要求，请查看文件列表。`);
        else message.success(`已上传 ${succeeded} 张图片`);
    };

    const completed = items.filter((item) => item.status === "success" || item.status === "error").length;
    const succeeded = items.filter((item) => item.status === "success").length;
    const hasQueued = items.some((item) => item.status === "queued");
    const hasRetryable = items.some((item) => item.status === "error" && item.retryable);
    const close = () => { if (!runningRef.current) { setOpen(false); setItems([]); } };

    return (
        <>
            <Button size={size} disabled={busy} icon={<Upload className="size-3.5" />} onClick={() => { if (!runningRef.current) { setItems([]); setOpen(true); } }}>批量上传图片</Button>
            <Modal
                title="批量上传图片" open={open} width={600} closable={!busy} maskClosable={!busy} keyboard={!busy}
                onCancel={close}
                footer={<div className="flex flex-wrap justify-end gap-2">
                    <Button disabled={busy} onClick={close}>关闭</Button>
                    {hasRetryable ? <Button disabled={busy} onClick={() => void uploadItems(true)}>重试失败项</Button> : null}
                    {hasQueued ? <Button type="primary" loading={busy} onClick={() => void uploadItems()}>开始上传</Button> : null}
                </div>}
            >
                <div className="space-y-4 py-2">
                    <Typography.Paragraph type="secondary" className="!mb-0">支持一次选择最多 20 张图片，单张不超过 20 MiB。素材保留 7 天，请及时导出并备份到本地。</Typography.Paragraph>
                    <Button icon={<Upload className="size-4" />} disabled={busy} onClick={() => fileInputRef.current?.click()}>{items.length ? "重新选择图片" : "选择图片（支持多选）"}</Button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { selectFiles(event.target.files); event.target.value = ""; }} />
                    {items.length ? <>
                        <div>
                            <div className="mb-1 text-sm">已上传 {succeeded} / {items.length} 张{busy ? " · 上传中" : ""}</div>
                            <Progress percent={Math.round(completed / items.length * 100)} status={items.some((item) => item.status === "error") ? "exception" : busy ? "active" : undefined} showInfo={false} />
                        </div>
                        <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                            {items.map((item) => <div key={item.id} className="flex items-start gap-3">
                                <span className="mt-1 shrink-0">{item.status === "success" ? <CheckCircle2 className="size-4 text-green-600" /> : item.status === "error" ? <CircleAlert className="size-4 text-red-500" /> : item.status === "uploading" ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4 opacity-50" />}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm" title={item.file.name}>{item.file.name}</div>
                                    <Typography.Text type={item.status === "error" ? "danger" : "secondary"} className="!text-xs">{item.error || `${formatBytes(item.file.size)} · ${item.status === "success" ? "已保存到我的素材" : item.status === "uploading" ? "正在上传" : "等待上传"}`}</Typography.Text>
                                </div>
                            </div>)}
                        </div>
                    </> : null}
                </div>
            </Modal>
        </>
    );
}
