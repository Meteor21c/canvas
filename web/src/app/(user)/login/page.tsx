"use client";

import { useEffect } from "react";

export default function MainSiteLogin() {
    useEffect(() => { window.location.replace("/login?redirect=%2Fstudio"); }, []);
    return <div className="flex h-full items-center justify-center text-sm opacity-70">正在返回流星 API 主站登录…</div>;
}
