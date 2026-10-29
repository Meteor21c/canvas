import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as downloadApi from "../src/services/api/meteor-download";
import { useUserStore } from "../src/stores/use-user-store";
import { downloadVideoFile } from "../src/services/media-download";

const original = { user: useUserStore.getState(), window: globalThis.window, document: globalThis.document };
const origin = "https://api.meteor21c.fun";
const signed = "/studio/api/files/owned/content?expires=9999999999&signature=test&download=1";
function fixture() {
    useUserStore.setState({ token: "download-owner-token", user: { id: "download-owner", role: "user" } as any });
    const clicked: any[] = [];
    globalThis.window = { location: { origin } } as any;
    globalThis.document = { body: { append() {} }, createElement() { const a = { href: "", download: "", rel: "", click() { clicked.push({ href: a.href, download: a.download }); }, remove() {} }; return a; } } as any;
    return clicked;
}
afterEach(() => { mock.restore(); useUserStore.setState(original.user); globalThis.window = original.window; globalThis.document = original.document; });

test("stored video obtains only an owned signed address and uses a native download without fetching the video", async () => {
    const clicked = fixture();
    const prepare = spyOn(downloadApi, "prepareMediaDownload").mockResolvedValue({ url: signed });
    const fetch = spyOn(globalThis, "fetch");
    await downloadVideoFile("blob:" + origin + "/cached-preview", "server:owned", "video.mp4");
    expect(prepare.mock.calls).toEqual([[{ storageKey: "server:owned", filename: "video.mp4" }, "download-owner-token"]]);
    expect(clicked).toEqual([{ href: signed, download: "video.mp4" }]);
    expect(fetch).not.toHaveBeenCalled();
});

test("an expired task playback URL is renewed by owned task ID before native download", async () => {
    const clicked = fixture();
    const prepare = spyOn(downloadApi, "prepareMediaDownload").mockResolvedValue({ url: signed });
    await downloadVideoFile("/studio/api/v1/videos/owned-task/content?expires=1&signature=old", "", "canvas-video.mp4");
    expect(prepare.mock.calls[0][0]).toEqual({ videoTaskId: "owned-task", filename: "canvas-video.mp4" });
    expect(clicked).toHaveLength(1);
});

test("account switch during preparation prevents the old account download", async () => {
    const clicked = fixture();
    let release!: (value: { url: string }) => void;
    spyOn(downloadApi, "prepareMediaDownload").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = downloadVideoFile("", "server:owned", "video.mp4");
    const rejected = pending.catch(error => error);
    useUserStore.setState({ token: "another-owner-token", user: { id: "another-owner", role: "user" } as any });
    release({ url: signed });
    expect((await rejected).message).toContain("登录状态已变化");
    expect(clicked).toHaveLength(0);
});

test("local cached videos download directly; remote or executable targets are rejected", async () => {
    const clicked = fixture();
    const prepare = spyOn(downloadApi, "prepareMediaDownload").mockResolvedValue({ url: "https://upstream.invalid/private.mp4" });
    await downloadVideoFile("blob:" + origin + "/local-video", undefined, "video.mp4");
    expect(clicked).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    await expect(downloadVideoFile("https://upstream.invalid/video.mp4", undefined, "video.mp4")).rejects.toThrow("视频地址不可用");
    await expect(downloadVideoFile("javascript:alert(1)", undefined, "video.mp4")).rejects.toThrow("视频地址不可用");
    await expect(downloadVideoFile("", "server:owned", "video.mp4")).rejects.toThrow("下载地址无效");
    expect(clicked).toHaveLength(1);
});
