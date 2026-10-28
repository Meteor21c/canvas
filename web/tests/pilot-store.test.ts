import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const disk = new Map<string, any>();
const state: any = { token: "owner-one", user: { id: "1" } };
let remote: any[] = [];
let writes: any[] = [];
let save: (project: any) => Promise<any>;
mock.module("@/stores/use-user-store", () => ({ useUserStore: { getState: () => state } }));
mock.module("@/services/api/canvas-tasks", () => ({
    listCanvasProjects: async () => remote,
    saveCanvasProject: async (_token: string, project: any) => { writes.push(structuredClone(project)); return save(project); },
}));
mock.module("localforage", () => ({ default: { createInstance: () => ({
    async getItem(key: string) { return disk.get(key) || null; },
    async setItem(key: string, value: any) { disk.set(key, structuredClone(value)); return value; },
}) } }));
const store = await import("../src/app/(user)/canvas/stores/use-canvas-store");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function project(patch: any = {}) {
    return { id: "project-a", title: "safe draft", revision: 0, nodes: [], connections: [], createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", viewport: { x: 0, y: 0, k: 1 }, chatSessions: [], activeChatId: null, agentConfig: null, autoTitlePending: false, backgroundMode: "dots", showImageInfo: false, sidePanel: { open: true, width: 250 }, agentPanel: { open: false, width: 464 }, ...patch };
}
beforeEach(() => {
    store.clearCanvasSession(); disk.clear(); remote = []; writes = [];
    state.token = "owner-one"; state.user = { id: "1" };
    save = async value => ({ ...value, revision: (value.revision || 0) + 1 });
});
afterAll(() => { store.clearCanvasSession(); mock.restore(); });

test("project export strips credentials, signed URLs, executable nodes and raw media", () => {
    const safe = store.safeCanvasProject(project({
        apiKey: "sensitive-api", password: "sensitive-password", access_token: "sensitive-token",
        agentConfig: { apiKey: "sensitive-agent" },
        nodes: [
            { id: "image-a", type: "image", metadata: { content: "blob:private", storageKey: "image:local", url: "https://img.meteor21c.fun/a.png?signature=secret" } },
            { id: "text-a", type: "text", metadata: { content: "safe text", authorization: "sensitive-auth" } },
            { id: "video-a", type: "video", metadata: { content: "https://video.example/a.mp4" } },
        ],
        connections: [{ fromNodeId: "text-a", toNodeId: "image-a" }, { fromNodeId: "video-a", toNodeId: "image-a" }],
    }) as any);
    const json = JSON.stringify(safe);
    for (const secret of ["sensitive-", "signature=", "blob:private", "video.example"]) expect(json).not.toContain(secret);
    expect(safe.nodes).toHaveLength(2); expect(safe.connections).toHaveLength(1);
    expect(safe.nodes[0].metadata?.storageKey).toBe("image:local");
    expect(safe.nodes[0].metadata?.content).toBe("");
    expect(safe.agentConfig).toBeNull();
});

test("owner switch does not hydrate previous account browser drafts", async () => {
    disk.set("1", { projects: [project()], dirtyIds: ["project-a"] });
    state.token = "owner-two"; state.user = { id: "2" };
    await store.hydrateCanvasProjects();
    expect(store.useCanvasStore.getState().projects).toEqual([]);
    expect(writes).toHaveLength(0);
});

test("conflicting local draft is retained but never silently overwrites cloud", async () => {
    disk.set("1", { projects: [project({ revision: 1, title: "unsynced local" })], dirtyIds: ["project-a"] });
    remote = [project({ revision: 2, title: "other tab saved" })];
    await store.hydrateCanvasProjects();
    expect(store.useCanvasStore.getState().projects[0].title).toBe("unsynced local");
    expect(store.useCanvasStore.getState().syncError).toContain("本地草稿");
    store.useCanvasStore.getState().retrySaves(); await pause(20);
    expect(writes).toHaveLength(0);
});

test("in-flight changes save serially with the server returned revision", async () => {
    await store.hydrateCanvasProjects();
    let resolveFirst: (value: any) => void = () => {};
    save = value => writes.length === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ ...value, revision: 2 });
    const id = store.useCanvasStore.getState().createProject("first");
    await pause(710);
    expect(writes).toHaveLength(1); expect(writes[0].revision).toBe(0);
    store.useCanvasStore.getState().renameProject(id, "changed during save");
    resolveFirst({ ...writes[0], revision: 1 }); await pause(40);
    expect(writes).toHaveLength(2); expect(writes[1].revision).toBe(1);
    expect(writes[1].title).toBe("changed during save");
    expect(store.useCanvasStore.getState().projects[0].revision).toBe(2);
});

test("cloud conflict stays visible and a manual retry does not force overwrite", async () => {
    await store.hydrateCanvasProjects();
    save = async () => { throw Object.assign(new Error("revision conflict"), { status: 409 }); };
    store.useCanvasStore.getState().createProject("conflicted");
    await pause(710);
    expect(store.useCanvasStore.getState().syncError).toContain("其他窗口");
    expect(store.useCanvasStore.getState().saving).toBe(false);
    store.useCanvasStore.getState().retrySaves(); await pause(20);
    expect(writes).toHaveLength(1);
    expect(disk.get("1").dirtyIds).toHaveLength(1);
});
