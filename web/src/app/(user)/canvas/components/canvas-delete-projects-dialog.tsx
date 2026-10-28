"use client";

import { useState } from "react";
import { App, Button, Modal } from "antd";

import { deleteCanvasProjects } from "@/services/api/canvas-tasks";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore, waitForCanvasWrites, finishCanvasDeletion } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const { message } = App.useApp();
    const [deleting, setDeleting] = useState(false);
    const confirm = async () => {
        if (deleting) return;
        const targets = [...ids];
        let succeeded = false;
        setDeleting(true);
        try {
            await waitForCanvasWrites(targets);
            await deleteCanvasProjects(targets);
            deleteProjects(targets);
            cleanupImages();
            removeSelectedIds(targets);
            setDeleteIds([]);
            succeeded = true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败，画布已保留");
        } finally { finishCanvasDeletion(targets, succeeded); setDeleting(false); }
    };

    return (
        <Modal
            title="删除画布？"
            open={ids.length > 0}
            centered
            onCancel={() => !deleting && setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>取消</Button>
                    <Button danger type="primary" loading={deleting} onClick={() => void confirm()}>
                        删除
                    </Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">将删除 {ids.length} 个画布，里面的节点和连线也会一起移除。</p>
        </Modal>
    );
}
