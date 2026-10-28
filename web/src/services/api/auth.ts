import { apiGet, apiPost } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
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

export async function login(_payload: AuthPayload): Promise<AuthSession> { throw new Error("请通过流星 API 主站登录"); }
export async function register(_payload: AuthPayload): Promise<AuthSession> { throw new Error("请通过流星 API 主站注册"); }
export async function fetchCurrentUser(token?: string): Promise<AuthUser> {
    const me = await apiGet<{id:number;email:string;username?:string;role:UserRole;balance:number;created_at:string}>("/api/v1/auth/me", undefined, token);
    return { id:String(me.id),username:me.username || me.email, displayName:me.username || me.email,avatarUrl:"",role:me.role,credits:me.balance,createdAt:me.created_at,updatedAt:me.created_at };
}
