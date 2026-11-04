import axios from "axios";
import { nanoid } from "nanoid";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoResponse } from "./video";

export const VIDEO_ENHANCE_MODEL = "tencent-mps-superres";
export type EnhanceTask = VideoResponse & { expiresAt?: string; expires_at?: string; completed_at?: string; resolution?: string };
type Envelope<T> = { code: number; data: T; msg?: string };

function headers(channelId: string, personal = false) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    return { Authorization: `Bearer ${token}`, ...(channelId ? { [personal ? "X-User-Model-Channel-ID" : "X-Model-Channel-ID"]: channelId } : {}) };
}
function unwrap<T>(body: Envelope<T>): T {
    if (body.code !== 0) throw Object.assign(new Error(body.msg || "视频增强暂不可用，请稍后重试"), { code: body.code });
    return body.data;
}
export async function createVideoEnhancement(input: { channelId: string; personal: boolean; url: string; resolution: string; frameRate: number; sourceDurationSeconds?: number; source?: "canvas" | "video-workbench"; clientTaskId?: string }) {
    const { channelId, personal, source, clientTaskId, ...body } = input;
    const response = await axios.post<Envelope<EnhanceTask>>("/studio/api/v1/videos", { ...body, model: VIDEO_ENHANCE_MODEL }, {
        headers: { ...headers(channelId, personal), "X-Client-Video-Task-ID": clientTaskId || `client_video_task_enhance_${nanoid()}`, "X-Video-Task-Source": source || "video-workbench" },
    });
    void useUserStore.getState().hydrateUser();
    return unwrap(response.data);
}
export async function getVideoEnhancement(id: string, channelId: string, personal: boolean, signal?: AbortSignal) {
    const response = await axios.get<Envelope<EnhanceTask>>(`/studio/api/v1/videos/${encodeURIComponent(id)}`, { headers: headers(channelId, personal), params: { model: VIDEO_ENHANCE_MODEL }, signal });
    return unwrap(response.data);
}
export async function listVideoEnhancements(signal?: AbortSignal) {
    const response = await axios.get<Envelope<EnhanceTask[]>>("/studio/api/v1/video-tasks", { headers: headers(""), signal });
    return unwrap(response.data).filter(task => task.model === VIDEO_ENHANCE_MODEL);
}
