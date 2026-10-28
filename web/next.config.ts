import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseChangelog } from "@/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;
    const releases = parseChangelog(localChangelog);

    return {
        output: "standalone",
        basePath: "/studio",
        poweredByHeader: false,
        images: { unoptimized: true },
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
        typescript: {
            ignoreBuildErrors: false,
        },
        async headers() {
            return [{
                source: "/:path*",
                headers: [
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "Referrer-Policy", value: "same-origin" },
                    { key: "Content-Security-Policy", value: "object-src 'none'; base-uri 'self'; frame-ancestors 'self'" },
                ],
            }];
        },
        env: {
            NEXT_PUBLIC_APP_VERSION: `${localVersion}-meteor-pilot`,
            NEXT_PUBLIC_METEOR_SOURCE_REVISION: process.env.SOURCE_REVISION || "meteor/pilot-20261028",
            NEXT_PUBLIC_APP_RELEASES: JSON.stringify(releases),
        },
    };
}
