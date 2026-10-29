import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { localForageStorage } from "../src/lib/localforage-storage";
import * as userConfig from "../src/services/api/user-config";
import { useUserStore } from "../src/stores/use-user-store";
import type { Asset } from "../src/stores/use-asset-store";

const originalUser = useUserStore.getState();
afterEach(() => { useUserStore.setState(originalUser); mock.restore(); });

test("a slow asset response from account A cannot replace or synchronize account B's assets", async () => {
    const ownerA = { token: "asset-owner-a-token", user: { id: "asset-owner-a", role: "user" } as any, isReady: true };
    const ownerB = { token: "asset-owner-b-token", user: { id: "asset-owner-b", role: "user" } as any, isReady: true };
    const asset = (id: string): Asset => ({ id, kind: "text", title: id, coverUrl: "", tags: [], createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", data: { content: id } });
    const localWrites: { key: string; value: string }[] = [];
    spyOn(localForageStorage, "getItem").mockResolvedValue(null);
    spyOn(localForageStorage, "setItem").mockImplementation(async (key, value) => { localWrites.push({ key, value }); });
    const sync = spyOn(userConfig, "syncUserAssetData").mockResolvedValue({});
    let releaseA!: (value: { assets: Asset[] }) => void;
    const pendingA = new Promise<{ assets: Asset[] }>((resolve) => { releaseA = resolve; });
    let startedA!: () => void;
    const awaitingA = new Promise<void>((resolve) => { startedA = resolve; });
    const fetchAssets = spyOn(userConfig, "fetchUserAssetData").mockImplementation(async (token) => {
        if (token === ownerA.token) { startedA(); return pendingA; }
        expect(token).toBe(ownerB.token);
        return { assets: [asset("b-kept")] };
    });

    useUserStore.setState(ownerA);
    const { useAssetStore } = await import("../src/stores/use-asset-store");
    await useAssetStore.persist.rehydrate();
    const loadingA = useAssetStore.getState().hydrateAccountAssets(ownerA.token, true);
    await awaitingA;
    useUserStore.setState(ownerB);
    await useAssetStore.getState().hydrateAccountAssets(ownerB.token, true);
    expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["b-kept"]);

    releaseA({ assets: [asset("a-private")] });
    await loadingA;
    expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["b-kept"]);
    expect(localWrites.filter((entry) => entry.key.endsWith(`:${ownerB.user.id}`)).every((entry) => !entry.value.includes("a-private"))).toBe(true);

    // A stale configuration callback must not reactivate A after B has loaded.
    await useAssetStore.getState().hydrateAccountAssets(ownerA.token, true);
    expect(fetchAssets).toHaveBeenCalledTimes(2);
    await useAssetStore.getState().syncAccountAssets(ownerA.token);
    expect(sync).not.toHaveBeenCalled();
    await useAssetStore.getState().syncAccountAssets(ownerB.token);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]).toEqual([ownerB.token, { assets: [asset("b-kept")] }]);
});
