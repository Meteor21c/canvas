"use client";

import { create } from "zustand";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { listCanvasProjects, saveCanvasProject } from "@/services/api/canvas-tasks";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasAgentConfig, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasPendingAgentRequest, type ViewportTransform } from "../types";

export type CanvasSidePanelState = { open: boolean; width: number };
export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 250 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 464 };
export type CanvasProject = {
    id: string; title: string; createdAt: string; updatedAt: string; revision?: number;
    nodes: CanvasNodeData[]; connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[]; activeChatId: string | null; agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean; pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode; showImageInfo: boolean; viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState; agentPanel: CanvasSidePanelState;
};
type CanvasStore = {
    hydrated: boolean; projects: CanvasProject[]; saving: boolean; syncError: string; lastSavedAt: string;
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<CanvasProject>) => void;
    syncWithRemote: (token: string, enabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
    retrySaves: () => void;
};
const local = localforage.createInstance({ name: "meteor-canvas", storeName: "projects" });
const initialViewport = { x: 0, y: 0, k: 1 };
let activeOwner = "";
let epoch = 0;
let localTimer: ReturnType<typeof setTimeout> | undefined;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const revisions = new Map<string, number>();
const running = new Set<string>();
const queued = new Set<string>();
const blocked = new Set<string>();
const MAX_PROJECTS = 20;
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_OWNER_BYTES = 10 * MAX_PROJECT_BYTES;

// Projects contain metadata only. Media blobs have their own bounded, expiring store.
export function safeCanvasProject(project: CanvasProject): CanvasProject {
    if (!project || !Array.isArray(project.nodes) || !Array.isArray(project.connections)) throw new Error("画布格式无效");
    if (project.nodes.length > 300 || project.connections.length > 600) throw new Error("试用画布最多 300 个节点和 600 条连线");
    const safe = JSON.parse(JSON.stringify(project, (key, value) => {
        if (/(?:api.?key|password|secret|authorization|access.?token|refresh.?token|agent.?token|agent.?url)/i.test(key)) return undefined;
        if (typeof value === "string" && /^(?:data:|blob:)/i.test(value)) return "";
        if (typeof value === "string" && /^https?:\/\//i.test(value)) {
            try { const url = new URL(value); if (url.search || url.hash || url.username || url.password) return ""; } catch { return ""; }
        }
        return value;
    })) as CanvasProject;
    safe.nodes = safe.nodes.filter(node => [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Group].includes(node.type)).map(node => ({
        ...node,
        metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Image ? { content: "" } : {}), count: 1 },
    }));
    const ids = new Set(safe.nodes.map(node => node.id));
    safe.connections = safe.connections.filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId));
    safe.chatSessions = []; safe.activeChatId = null; safe.agentConfig = null; safe.autoTitlePending = false;
    delete safe.pendingAgentRequest;
    safe.agentPanel = { ...DEFAULT_CANVAS_AGENT_PANEL };
    if (new Blob([JSON.stringify(safe)]).size > MAX_PROJECT_BYTES) throw new Error("单个画布元数据不能超过 1 MiB，请减少节点或文字");
    return safe;
}
function scope() { return String(useUserStore.getState().user?.id || ""); }
function current(owner: string, generation: number) { return owner === activeOwner && owner === scope() && generation === epoch; }
function persistLocal() {
    if (localTimer) clearTimeout(localTimer);
    const owner = activeOwner, generation = epoch;
    if (!owner) return;
    localTimer = setTimeout(() => {
        if (!current(owner, generation)) return;
        try {
            const projects = useCanvasStore.getState().projects.map(safeCanvasProject);
            void local.setItem(owner, { projects, dirtyIds: [...queued, ...running] }).catch(() => { if (current(owner, generation)) useCanvasStore.setState({ syncError: "浏览器本地保存失败，请立即导出备份" }); });
        } catch (error) { useCanvasStore.setState({ syncError: error instanceof Error ? error.message : "本地保存失败" }); }
    }, 300);
}
function changed(project: CanvasProject) {
    useCanvasStore.setState({ saving: true });
    persistLocal();
    queued.add(project.id);
    const timer = timers.get(project.id);
    if (timer) clearTimeout(timer);
    timers.set(project.id, setTimeout(() => { timers.delete(project.id); void flushProject(project.id); }, 650));
}
async function flushProject(id: string) {
    if (running.has(id) || blocked.has(id) || !queued.has(id) || !activeOwner) return;
    const owner = activeOwner, generation = epoch;
    const token = useUserStore.getState().token;
    const project = useCanvasStore.getState().openProject(id);
    if (!token || !project || !current(owner, generation)) return;
    let succeeded = false;
    running.add(id); queued.delete(id);
    useCanvasStore.setState({ saving: true });
    try {
        const safe = safeCanvasProject({ ...project, revision: revisions.get(id) || 0 });
        const saved = await saveCanvasProject(token, safe);
        if (!current(owner, generation)) return;
        succeeded = true;
        revisions.set(id, saved.revision || 0);
        useCanvasStore.setState(state => ({ projects: state.projects.map(item => item.id === id ? { ...item, revision: saved.revision } : item), syncError: "", lastSavedAt: new Date().toISOString() }));
        persistLocal();
    } catch (error) {
        if (!current(owner, generation)) return;
        const message = error instanceof Error ? error.message : "云端保存失败";
        if ((error as { status?: number }).status === 409 || /冲突|版本|conflict/i.test(message)) blocked.add(id);
        queued.add(id);
        useCanvasStore.setState({ syncError: blocked.has(id) ? "此画布已在其他窗口修改。当前草稿已保留本地；请先导出备份，再刷新读取云端版本。" : `云端保存失败，草稿保留在当前浏览器：${message}` });
    } finally {
        if (current(owner, generation)) {
            running.delete(id);
            useCanvasStore.setState({ saving: running.size > 0 || (succeeded && queued.size > 0) });
            if (succeeded && queued.has(id)) void flushProject(id);
        }
    }
}
function checkQuota(projects: CanvasProject[]) {
    if (projects.length > MAX_PROJECTS) throw new Error("试用最多保存 20 个画布，请先导出并删除不需要的画布");
    const bytes = new Blob([JSON.stringify(projects.map(safeCanvasProject))]).size;
    if (bytes > MAX_OWNER_BYTES) throw new Error("画布元数据总量超过 10 MiB，请先导出备份");
}
export async function waitForCanvasWrites(ids: string[]) {
    for (const id of ids) { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); queued.delete(id); }
    const deadline = Date.now() + 20000;
    while (ids.some(id => running.has(id))) {
        if (Date.now() > deadline) throw new Error("画布仍在保存，请稍后再删除");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
export function clearCanvasSession() {
    if (activeOwner && useCanvasStore.getState().hydrated) {
        try { void local.setItem(activeOwner, { projects: useCanvasStore.getState().projects.map(safeCanvasProject), dirtyIds: [...queued, ...running] }); } catch { /* Avoid carrying a previous account's state into the next session. */ }
    }
    epoch++; activeOwner = "";
    timers.forEach(timer => clearTimeout(timer)); timers.clear();
    if (localTimer) clearTimeout(localTimer);
    queued.clear(); blocked.clear(); revisions.clear(); running.clear();
    useCanvasStore.setState({ hydrated: false, projects: [], saving: false, syncError: "", lastSavedAt: "" });
}
export async function hydrateCanvasProjects() {
    const owner = scope(), token = useUserStore.getState().token;
    if (!owner || !token) throw new Error("请先登录流星 API");
    clearCanvasSession(); activeOwner = owner;
    const generation = epoch;
    const cached = await local.getItem<{ projects: CanvasProject[]; dirtyIds: string[] }>(owner).catch(() => null);
    try {
        const remote = await listCanvasProjects(token);
        if (!current(owner, generation)) return;
        const projects = remote.map(safeCanvasProject);
        const dirtyIds = new Set(cached?.dirtyIds || []);
        for (const draft of cached?.projects || []) {
            if (!dirtyIds.has(draft.id)) continue;
            const index = projects.findIndex(project => project.id === draft.id);
            const remoteVersion = index >= 0 ? projects[index].revision || 0 : 0;
            if (remoteVersion !== (draft.revision || 0)) blocked.add(draft.id);
            if (index >= 0) projects[index] = safeCanvasProject(draft);
            else { projects.unshift(safeCanvasProject(draft)); if ((draft.revision || 0) > 0) blocked.add(draft.id); }
            queued.add(draft.id);
        }
        projects.forEach(project => revisions.set(project.id, project.revision || 0));
        useCanvasStore.setState({ projects, hydrated: true, syncError: queued.size ? "发现未同步的本地草稿，请先导出备份。若其他窗口已修改或删除此画布，请导入为新画布保留草稿；否则可重试保存。" : "" });
        persistLocal();
    } catch (error) {
        if (!current(owner, generation)) return;
        const projects = (cached?.projects || []).map(safeCanvasProject);
        for (const id of cached?.dirtyIds || []) queued.add(id);
        projects.forEach(project => revisions.set(project.id, project.revision || 0));
        useCanvasStore.setState({ projects, hydrated: true, syncError: "无法读取云端画布，已显示当前账号的本地草稿。恢复连接后再刷新，避免覆盖其他窗口。" });
    }
}
export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false, projects: [], saving: false, syncError: "", lastSavedAt: "",
    createProject: (title = "未命名画布") => {
        const now = new Date().toISOString();
        const project: CanvasProject = { id: nanoid(), title, revision: 0, createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, agentConfig: null, autoTitlePending: false, backgroundMode: "dots", showImageInfo: false, viewport: initialViewport, sidePanel: DEFAULT_CANVAS_SIDE_PANEL, agentPanel: DEFAULT_CANVAS_AGENT_PANEL };
        checkQuota([project, ...get().projects]); set(state => ({ projects: [project, ...state.projects] })); changed(project); return project.id;
    },
    importProject: source => {
        const now = new Date().toISOString();
        const project = safeCanvasProject({ ...source, id: nanoid(), revision: 0, title: source.title || "导入画布", createdAt: source.createdAt || now, updatedAt: now, nodes: source.nodes || [], connections: source.connections || [], chatSessions: [], activeChatId: null, agentConfig: null, autoTitlePending: false, backgroundMode: source.backgroundMode || "dots", showImageInfo: source.showImageInfo || false, viewport: source.viewport || initialViewport, sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL, agentPanel: DEFAULT_CANVAS_AGENT_PANEL });
        checkQuota([project, ...get().projects]); set(state => ({ projects: [project, ...state.projects] })); changed(project); return project.id;
    },
    openProject: id => get().projects.find(project => project.id === id) || null,
    renameProject: (id, title) => get().updateProject(id, { title: title.trim().slice(0, 100) || "未命名画布" }),
    deleteProjects: ids => { ids.forEach(id => { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); queued.delete(id); revisions.delete(id); blocked.delete(id); }); set(state => ({ projects: state.projects.filter(project => !ids.includes(project.id)) })); persistLocal(); },
    updateProject: (id, patch) => {
        const old = get().openProject(id); if (!old) return;
        const project = { ...old, ...patch, id, revision: old.revision, agentConfig: null, chatSessions: [], activeChatId: null, autoTitlePending: false, updatedAt: new Date().toISOString() };
        const projects = get().projects.map(item => item.id === id ? project : item);
        try { checkQuota(projects); } catch (error) { set({ syncError: error instanceof Error ? error.message : "画布超出配额" }); return; }
        set({ projects }); changed(project);
    },
    syncWithRemote: async (_token, enabled) => { if (enabled) await hydrateCanvasProjects(); },
    setSyncEnabled: () => {},
    retrySaves: () => { for (const id of queued) void flushProject(id); },
}));
