"use client";

import { useState } from "react";
import { App, Button, Modal } from "antd";
import { deleteCanvasProjects } from "@/services/api/canvas-tasks";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const ids = useCanvasUiStore(state => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore(state => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore(state => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore(state => state.deleteProjects);
    const confirm = async () => {
        if (busy) return; setBusy(true);
        try { await deleteCanvasProjects(ids); deleteProjects(ids); removeSelectedIds(ids); setDeleteIds([]); }
        catch (error) { message.error(error instanceof Error ? error.message : "删除失败，画布已保留"); }
        finally { setBusy(false); }
    };
    return <Modal title="删除画布？" open={ids.length > 0} centered onCancel={() => { if (!busy) setDeleteIds([]); }} footer={<><Button disabled={busy} onClick={() => setDeleteIds([])}>取消</Button><Button loading={busy} danger type="primary" onClick={() => void confirm()}>删除</Button></>}><p className="text-sm text-foreground/60">将删除 {ids.length} 个画布的节点和连线。已提交的生成请求继续处理，不会因此取消或退款。请先导出需要保留的内容。</p></Modal>;
}
