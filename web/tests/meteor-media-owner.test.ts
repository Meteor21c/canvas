import { afterEach, expect, mock, spyOn, test } from "bun:test";
import localforage from "localforage";
import * as requests from "../src/services/api/request";
import { useUserStore } from "../src/stores/use-user-store";

const originalUser = useUserStore.getState();
const databases = new Map<string, Map<string, unknown>>();
const writes: string[] = [];
spyOn(localforage, "createInstance").mockImplementation(({ name, storeName }: any) => {
    const id = `${name}:${storeName}`;
    const data = new Map<string, unknown>();
    databases.set(id, data);
    return {
        getItem: async (key: string) => data.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { writes.push(key); data.set(key, value); return value; },
        removeItem: async (key: string) => { data.delete(key); },
        iterate: async (visit: (value: unknown, key: string) => unknown) => {
            for (const [key, value] of data) { const result = visit(value, key); if (result !== undefined) return result; }
        },
    } as any;
});
const images = await import("../src/services/image-storage");
const { clearMeteorMediaSession } = await import("../src/services/meteor-media-retention");

afterEach(() => {
    clearMeteorMediaSession();
    images.clearStorageConfigCache();
    mock.restore();
    useUserStore.setState(originalUser);
});

test("switching account while storage config is pending cannot cache the old upload for the new account when cloud sync returns null", async () => {
    const owner = { token: "owner-a-token", user: { id: "owner-a", role: "user" } as any };
    useUserStore.setState(owner);
    const config = { mode: "local", autoSyncAllAssets: false, allowUserProvider: false, allowUserGlobalProvider: false };
    const request = spyOn(requests, "apiGet").mockResolvedValue(config);
    const realAutoSync = images.autoSyncToCloud;
    const autoSync = spyOn(images, "autoSyncToCloud").mockImplementation(realAutoSync);
    const { uploadMediaFile } = await import("../src/services/file-storage");
    const blob = new Blob(["fixture audio"], { type: "audio/mpeg" });
    const cache = databases.get("meteor-canvas-v082:media")!;

    // Establish that this fixture really exercises the working local fallback.
    const saved = await uploadMediaFile(blob, "asset-audio", undefined, owner.token);
    expect(cache.has(`${owner.user.id}:${saved.storageKey}`)).toBe(true);
    expect(writes).toEqual([`${owner.user.id}:${saved.storageKey}`]);
    expect(await autoSync.mock.results[0].value).toBeNull();
    cache.clear();
    writes.length = 0;
    images.clearStorageConfigCache();
    request.mockClear();
    autoSync.mockClear();

    let releaseConfig!: (value: typeof config) => void;
    const pendingConfig = new Promise<typeof config>((resolve) => { releaseConfig = resolve; });
    let configStarted!: () => void;
    const awaitingConfig = new Promise<void>((resolve) => { configStarted = resolve; });
    request.mockImplementation(async (url) => {
        expect(url).toBe("/studio/api/storage/config");
        configStarted();
        return pendingConfig;
    });

    const upload = uploadMediaFile(blob, "asset-audio", undefined, owner.token);
    const rejection = upload.then(() => null, (error: unknown) => error);
    await awaitingConfig;
    expect(writes).toHaveLength(0);
    useUserStore.setState({ token: "owner-b-token", user: { id: "owner-b", role: "user" } as any });
    releaseConfig(config);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("登录状态已变化");
    expect(request).toHaveBeenCalledTimes(1);
    expect(autoSync).toHaveBeenCalledTimes(1);
    expect(await autoSync.mock.results[0].value).toBeNull();
    expect(useUserStore.getState().user?.id).toBe("owner-b");
    expect(writes).toHaveLength(0);
    expect(cache.size).toBe(0);
});
