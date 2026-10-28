import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { apiGet, apiPost } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export async function listCanvasProjects(token: string) {
    return apiGet<CanvasProject[]>("/api/v1/canvas/projects", undefined, token);
}

export async function saveCanvasProject(
    token: string,
    project: CanvasProject,
) {
    return apiPost<CanvasProject>(
        "/api/v1/canvas/projects",
        { data: project },
        token,
    );
}

export async function syncCanvasProjects(
    token: string,
    projects: CanvasProject[],
) {
    return apiPost<CanvasProject[]>(
        "/api/v1/canvas/projects/sync",
        { projects },
        token,
    );
}

// Removing a node does not cancel/refund an already submitted upstream job.
export async function deleteCanvasTasks(_sourceId: string, _nodeIds: string[] = []) {
    return { deleted: false };
}

export async function deleteCanvasProjects(ids: string[]) {
    const token = useUserStore.getState().token;
    const projectIds = Array.from(
        new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!token || !projectIds.length) return;
    const { waitForCanvasWrites } = await import("@/app/(user)/canvas/stores/use-canvas-store");
    await waitForCanvasWrites(projectIds);
    if (useUserStore.getState().token !== token) throw new Error("登录状态已变化");
    return apiPost<{ deleted: boolean }>(
        "/api/v1/canvas/projects/delete",
        { ids: projectIds },
        token,
    );
}
