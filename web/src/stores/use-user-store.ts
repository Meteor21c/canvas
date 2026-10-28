"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthUser } from "@/services/api/auth";

import { readMainAuthToken } from "@/services/api/request";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    error: string;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            error: "",
            setSession: (token, user) => set({ token, user, isReady: true }),
            clearSession: () => {
                set({ token: "", user: null, isReady: true, error: "" });
                window.location.assign("/");
            },
            hydrateUser: async () => {
                const token = readMainAuthToken();
                if (!token) {
                    set({ token: "", user: null, isReady: true, error: "请先登录流星 API 主站" });
                    return;
                }
                set({ isLoading: true, error: "" });
                try {
                    const user = await fetchCurrentUser(token);
                    if (readMainAuthToken() !== token) return;
                    if (user.role === "guest") {
                        set({ token: "", user: null, isReady: true, isLoading: false });
                        return;
                    }
                    set({ token, user, isReady: true, isLoading: false, error: "" });
                } catch (error) {
                    if (readMainAuthToken() !== token) return;
                    set({ token: "", user: null, isReady: true, isLoading: false, error: error instanceof Error ? error.message : "无法验证主站登录状态" });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: () => ({}),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
