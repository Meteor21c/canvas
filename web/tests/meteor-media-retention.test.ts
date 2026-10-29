import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import localforage from "localforage";
import { useUserStore } from "../src/stores/use-user-store";
import * as storageApi from "../src/services/api/storage";

const databases = new Map<string, Map<string, any>>();
const database = (name: string, storeName = "media") => {
    const id = `${name}:${storeName}`;
    if (!databases.has(id)) databases.set(id, new Map());
    return databases.get(id)!;
};
spyOn(localforage, "createInstance").mockImplementation(({ name, storeName }: any) => {
    const data = database(name, storeName);
    return {
        getItem: async (key: string) => data.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { data.set(key, value); return value; },
        removeItem: async (key: string) => { data.delete(key); },
        iterate: async (visit: (value: unknown, key: string) => unknown) => { for (const [key, value] of data) { const result = visit(value, key); if (result !== undefined) return result; } },
    } as any;
});
const { cleanupMeteorMedia, createMeteorMediaStore } = await import("../src/services/meteor-media-retention");
const { resolveImageUrl } = await import("../src/services/image-storage");
const { resolveMediaUrl } = await import("../src/services/file-storage");
const { safeCanvasProject } = await import("../src/app/(user)/canvas/stores/use-canvas-store");
const DAY = 24 * 60 * 60 * 1000;
const account = "meteor_user_17";
const originalUser = useUserStore.getState();
const current = database("meteor-canvas-v082");
const legacy = database("meteor-canvas-pilot");
const images = createMeteorMediaStore("image");
const blob = new Blob(["fixture image"], { type: "image/png" });
const key = "image:retained";

beforeEach(() => {
    for (const data of databases.values()) data.clear();
    useUserStore.setState({ token: "fixture-token", user: { id: account, role: "user" } as any });
});
afterEach(() => { mock.restore(); useUserStore.setState(originalUser); });

test("yesterday's 24-hour cache survives cleanup until seven days from its original write", async () => {
    const createdAt = Date.now() - 2 * DAY;
    current.set(`${account}:${key}`, { blob, expires: createdAt + DAY, kind: "image" });
    await cleanupMeteorMedia();
    expect(await images.getItem(key)).toBe(blob);
    spyOn(Date, "now").mockReturnValue(createdAt + 7 * DAY + 1);
    expect(await images.getItem(key)).toBeNull();
});

test("expired pilot images recover with their original age and the source copy is preserved", async () => {
    const createdAt = Date.now() - 2 * DAY;
    const original = { blob, expires: createdAt + DAY };
    legacy.set(`17:${key}`, original);
    expect(await images.getItem(key)).toBe(blob);
    expect(current.get(`${account}:${key}`)).toMatchObject({ createdAt, expires: createdAt + 7 * DAY });
    expect(legacy.get(`17:${key}`)).toBe(original);
    spyOn(Date, "now").mockReturnValue(createdAt + 3 * DAY);
    expect(await images.getItem(key)).toBe(blob);
    expect(current.get(`${account}:${key}`).expires).toBe(createdAt + 7 * DAY);
});

test("new media expires at seven days and is never renewed by reading", async () => {
    const createdAt = Date.now();
    const now = spyOn(Date, "now").mockReturnValue(createdAt);
    await images.setItem(key, blob);
    expect(current.get(`${account}:${key}`).expires).toBe(createdAt + 7 * DAY);
    now.mockReturnValue(createdAt + 6 * DAY);
    expect(await images.getItem(key)).toBe(blob);
    now.mockReturnValue(createdAt + 7 * DAY);
    await cleanupMeteorMedia();
    expect(current.has(`${account}:${key}`)).toBe(false);
});

test("pilot recovery cannot read another account's image", async () => {
    legacy.set(`18:${key}`, { blob, expires: Date.now() + DAY });
    expect(await images.getItem(key)).toBeNull();
    expect(legacy.size).toBe(1);
});

test("existing media still counts toward the account quota during legacy recovery", async () => {
    for (let i = 0; i < 256; i++) current.set(`${account}:image:${i}`, { blob, expires: Date.now() - DAY, kind: "image" });
    legacy.set(`17:${key}`, { blob, expires: Date.now() - DAY });
    await expect(images.getItem(key)).rejects.toThrow("256");
    expect(legacy.has(`17:${key}`)).toBe(true);
});

test("reopening resolves image and video IDs to fresh links even with an expired fallback", async () => {
    const expired = "/studio/api/files/existing/content?expires=1&signature=expired";
    const fresh = "/studio/api/files/existing/content?expires=9999999999&signature=fresh";
    const next = fresh + "2";
    const info = spyOn(storageApi, "getStorageObjectInfo").mockResolvedValue({ publicUrl: fresh } as any);
    expect(await resolveImageUrl("server:existing", expired)).toBe(fresh);
    info.mockResolvedValue({ publicUrl: next } as any);
    expect(await resolveImageUrl("server:existing", fresh)).toBe(next);
    expect(await resolveMediaUrl("server:existing", expired)).toBe(next);
    expect(info).toHaveBeenCalledTimes(3);
});

test("saved projects retain media IDs and strip temporary Studio signed links", () => {
    const original = { id: "fixture", nodes: [{ metadata: { content: "/studio/api/files/existing/content?expires=1&signature=expired", storageKey: "server:existing" } }], connections: [] } as any;
    expect(safeCanvasProject(original).nodes[0].metadata).toEqual({ content: "", storageKey: "server:existing" });
    expect(original.nodes[0].metadata.content).toContain("signature=");
});
