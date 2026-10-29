import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as requests from "../src/services/api/request";
import { stopCanvasTask } from "../src/services/api/canvas-tasks";
import { useUserStore } from "../src/stores/use-user-store";

// Execute the workbench's actual pure merge functions without mounting its UI.
const source = readFileSync(new URL("../src/app/(user)/video/page.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["mergeBackendTaskIntoLog", "shouldPreferVideoLog", "mergeDuplicateVideoLog", "videoLogScore", "isLocalClientVideoTask", "hasBackendVideoTaskBinding", "isClientVideoTaskId", "videoTaskIdentityKeys", "videoLogIdentityKeys", "videoResultIdentityKeys", "normalizeVideoIdentityKey", "findMatchingPendingLogForResult", "mergePendingLogResults", "createResultFromLog", "sortVideoResults", "updateResultByLogId", "isRecoverableBackendVideoTask", "isCompletedVideoTask", "isFailedVideoTask"];
const functions = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text));
if (functions.length !== names.length) throw new Error("video regression harness is missing a production function");
const compiled = ts.transpileModule(functions.map(node => node.getText(file)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const state = new Function(compiled + `\nreturn {${names.join(",")}};`)();
const token = useUserStore.getState().token;
afterEach(() => { mock.restore(); useUserStore.setState({ token }); });

test("a rejected cancel resumes the original task without sending a second generation", async () => {
    useUserStore.setState({ token: "fixture-token" });
    const post = spyOn(requests, "apiPost").mockRejectedValue(new requests.StudioApiError("任务已提交", 409));
    expect(await stopCanvasTask("video", "original-task", false, "video-workbench")).toEqual({ stopped: false, message: "任务已提交" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(["/studio/api/v1/canvas/tasks/stop", { kind: "video", id: "original-task", workflow: false, source: "video-workbench" }, "fixture-token"]);
});

test("authorization and network errors are not treated as a confirmed cancel rejection", async () => {
    useUserStore.setState({ token: "fixture-token" });
    const post = spyOn(requests, "apiPost");
    for (const status of [401, 403, 503]) {
        post.mockRejectedValueOnce(new requests.StudioApiError("fixture-error", status));
        await expect(stopCanvasTask("video", "original-task", false)).rejects.toMatchObject({ status });
    }
    post.mockResolvedValueOnce({ stopped: true });
    expect(await stopCanvasTask("video", "cancellable-task", false)).toEqual({ stopped: true });
});

function fixture(status = "停止中", canCancel?: boolean) {
    return { id: "log-original", status, createdAt: 1000, durationMs: 2000, prompt: "customer prompt", config: {}, references: [], videoReferences: [], audioReferences: [], error: "cancel rejected", errorDetail: "old rejection", task: { id: "client_video_task_original", task_id: "provider-task-original", status: "processing", can_cancel: canCancel } };
}

test("completed server video recovers a legacy stop record and clears its rejection", () => {
    const existing = fixture();
    const task = { ...existing.task, status: "completed", progress: 100, can_cancel: false, video_url: "/studio/api/video/original/content" };
    const incoming = { ...fixture("成功", false), task, video: { id: task.id, url: task.video_url } };
    expect(state.isRecoverableBackendVideoTask(task)).toBe(true);
    const merged = state.mergeBackendTaskIntoLog(existing, incoming, task);
    expect(merged).toMatchObject({ id: existing.id, prompt: existing.prompt, status: "成功", video: incoming.video, task });
    expect(merged.error).toBeUndefined(); expect(merged.errorDetail).toBeUndefined();
    for (const stale of [existing, fixture("停止中", false)]) {
        const deduped = state.mergeDuplicateVideoLog(merged, stale);
        expect(deduped.status).toBe("成功"); expect(deduped.error).toBeUndefined();
    }
});

test("pending server video restores polling and replaces an old stopping card", () => {
    const previous = fixture();
    const task = { ...previous.task, can_cancel: false };
    const merged = state.mergeBackendTaskIntoLog(previous, fixture("生成中", false), task);
    const result = { id: previous.id, taskLogId: previous.id, status: "stopping", createdAt: 1000, error: "cancel rejected", task: previous.task };
    const cards = state.mergePendingLogResults([result], [merged]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending", task });
    expect(cards[0].error).toBeUndefined();
    expect(state.updateResultByLogId([result], previous.id, { status: "pending", task })[0].status).toBe("pending");
});

test("terminal task removes only its stale card, preserving other running tasks", () => {
    const old = fixture();
    const terminal = { ...fixture("成功", false), task: { ...old.task, can_cancel: false, status: "completed" }, video: { id: old.task.id, url: "/content" } };
    const stale = { id: old.id, status: "stopping", task: old.task };
    const other = { id: "other", status: "pending", task: { id: "other-task" }, createdAt: 3000 };
    expect(state.mergePendingLogResults([stale, other], [terminal])).toEqual([other]);
    const failed = { ...terminal, status: "失败", video: undefined };
    expect(state.isRecoverableBackendVideoTask({ ...old.task, can_cancel: false, status: "failed" })).toBe(true);
    expect(state.mergePendingLogResults([stale, other], [failed])).toEqual([other]);
});

test("a cancellable workflow keeps its real stopped state", () => {
    const stopped = fixture("已停止", true);
    expect(state.mergeBackendTaskIntoLog(stopped, fixture("生成中", true), stopped.task)).toBe(stopped);
    const result = { id: stopped.id, status: "stopped", task: stopped.task };
    expect(state.updateResultByLogId([result], stopped.id, { status: "pending" })[0]).toBe(result);
});
