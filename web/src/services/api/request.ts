import axios from "axios";

export const STUDIO_BASE_PATH = "/studio";
export const MAIN_AUTH_TOKEN_KEY = "auth_token";

export function studioApiUrl(url: string) {
    return url.startsWith("/api/") ? `${STUDIO_BASE_PATH}${url}` : url;
}

export function readMainAuthToken() {
    return typeof window === "undefined" ? "" : window.localStorage.getItem(MAIN_AUTH_TOKEN_KEY) || "";
}

// Browser media reads use the same account authorization, never forwarded to an external host.
export function studioFetch(input: string, init: RequestInit = {}) {
    const url = studioApiUrl(input);
    const parsed = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    const sameOrigin = typeof window !== "undefined" && parsed.origin === window.location.origin;
    const headers = new Headers(init.headers);
    const token = readMainAuthToken();
    if (sameOrigin && parsed.pathname.startsWith("/studio/api/") && token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
}

export class StudioApiError extends Error {
    constructor(message: string, public status: number) { super(message); this.name = "StudioApiError"; }
}

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

type ApiResponse<T> = {
    code: number;
    data: T;
    msg: string;
};

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

export async function apiGet<T>(url: string, params?: ApiParams, token?: string) {
    return apiRequest<T>({
        url,
        method: "GET",
        params: params || undefined,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

export async function apiPost<T>(url: string, body?: unknown, token?: string) {
    return apiRequest<T>({
        url,
        method: "POST",
        data: body ?? {},
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

export async function apiDelete<T>(url: string, token?: string) {
    return apiRequest<T>({
        url,
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

async function apiRequest<T>(config: { url: string; method: "GET" | "POST" | "DELETE"; params?: ApiParams; data?: unknown; headers?: Record<string, string> }) {
    const url = studioApiUrl(config.url);
    if (!url.startsWith("/studio/api/")) throw new Error("画布接口必须使用本站服务");
    let response;
    try {
        response = await axios.request<ApiResponse<T>>({
            url,
            method: config.method,
            params: config.params,
            paramsSerializer: { serialize: (params) => serializeApiParams(params as ApiParams).toString() },
            data: config.data,
            headers: { ...(readMainAuthToken() ? { Authorization: `Bearer ${readMainAuthToken()}` } : {}), ...config.headers },
            validateStatus: () => true,
        });
    } catch {
        throw new Error("接口连接失败，请确认后端服务已启动");
    }

    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new Error(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试");
    }

    const payload = result as ApiResponse<T>;
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
        throw new StudioApiError(payload.msg || "请求失败", response.status);
    }

    return payload.data;
}
