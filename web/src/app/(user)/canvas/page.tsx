"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";

import { nanoid } from "nanoid";
import { readZip } from "@/lib/zip";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "./components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "./components/canvas-project-card";
import type { CanvasExportFile } from "./export-types";
import { safeCanvasProject, useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasUiStore } from "./stores/use-canvas-ui-store";
import { exportCanvasProjects } from "./utils/canvas-export";

export default function CanvasPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => {
        router.push(`/canvas/${id}`);
    };
    const createAndEnter = () => { try { enterProject(createProject(`无限画布 ${projects.length + 1}`)); } catch (error) { message.error(error instanceof Error ? error.message : "无法新建画布"); } };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (data.app !== "infinite-canvas" || !Array.isArray(data.projects) || data.projects.length + projects.length > 20) throw new Error("无效画布或导入后超过 20 个工程");
            const prepared = data.projects.map(item => {
                if (!item || !Array.isArray(item.files) || item.files.length > 128) throw new Error("画布文件列表无效");
                safeCanvasProject(item.project);
                return item;
            });
            const remap = new Map<string, string>();
            for (const item of prepared) for (const asset of item.files) {
                if (typeof asset.storageKey !== "string" || !asset.storageKey.startsWith("image:") || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(asset.mimeType)) throw new Error("试用版只能导入图片素材");
                const blob = zip.get(asset.path);
                if (!blob) continue;
                const key = `image:${nanoid()}`;
                remap.set(asset.storageKey, key);
                await setImageBlob(key, blob.slice(0, blob.size, asset.mimeType));
            }
            for (const item of prepared) {
                const project = JSON.parse(JSON.stringify(item.project, (_key, value) => typeof value === "string" ? remap.get(value) || value : value));
                importProject(project);
            }
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-foreground">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
                    <div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-foreground/45">ARCHIVE // CANVAS DIRECTORY</p>
                        <h1 className="mt-2 text-2xl sm:text-3xl font-medium tracking-tight">流星创作画布</h1>
                        <p className="mt-3 max-w-xl text-sm leading-6 text-foreground/60">拖入图片、双击添加便笺，将节点连线后手动生成。工程云端保存；图片仅缓存在当前浏览器 24 小时，导出 ZIP 才能长期保留和转移图片。</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `无限画布-${selectedIds.length}个项目`)}>
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-border text-sm text-foreground/50 ">正在加载画布...</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-border text-center ">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-foreground/50">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
