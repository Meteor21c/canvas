import { apiGet } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "meteor-canvas:session-state-v082";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    balance?: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export async function login(payload: AuthPayload): Promise<AuthSession> {
    void payload;
    throw new Error("请通过流星 API 主站登录");
}

export async function register(payload: AuthPayload): Promise<AuthSession> {
    void payload;
    throw new Error("请通过流星 API 主站注册");
}

export async function fetchCurrentUser(token?: string) {
    return apiGet<AuthUser>("/studio/api/auth/me", undefined, token);
}
