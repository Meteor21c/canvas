import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { apiGet, apiPost, StudioApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export async function listCanvasProjects(token: string) {
    return apiGet<CanvasProject[]>("/studio/api/v1/canvas/projects", undefined, token);
}

export async function saveCanvasProject(
    token: string,
    project: CanvasProject,
) {
    return apiPost<CanvasProject>(
        "/studio/api/v1/canvas/projects",
        { data: project, revision: project.revision || 0 },
        token,
    );
}

export async function syncCanvasProjects(
    token: string,
    projects: CanvasProject[],
) {
    return apiPost<CanvasProject[]>(
        "/studio/api/v1/canvas/projects/sync",
        { projects },
        token,
    );
}

export async function stopCanvasTask(kind: "image" | "video" | "audio", id: string, workflow: boolean, source: "canvas" | "video-workbench" = "canvas") {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再停止云端任务");
    try {
        return await apiPost<{ stopped: boolean; message?: string }>("/studio/api/v1/canvas/tasks/stop", { kind, id, workflow, source }, token);
    } catch (error) {
        if (error instanceof StudioApiError && error.status === 409) return { stopped: false, message: error.message };
        throw error;
    }
}

export async function deleteCanvasProjects(ids: string[]) {
    const token = useUserStore.getState().token;
    const projectIds = Array.from(
        new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!token || !projectIds.length) return;
    return apiPost<{ deleted: boolean }>(
        "/studio/api/v1/canvas/projects/delete",
        { ids: projectIds },
        token,
    );
}
