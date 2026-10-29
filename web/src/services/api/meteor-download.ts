import { apiPost } from "./request";

export function prepareMediaDownload(input: { storageKey?: string; videoTaskId?: string; filename: string }, token: string) {
    return apiPost<{ url: string }>("/api/v1/meteor/download", input, token);
}
