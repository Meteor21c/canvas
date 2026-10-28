"use client";
import { useEffect } from "react";
import { useVideoCapabilities } from "@/hooks/use-meteor-pricing";
import { boundVideoSeconds, normalizeVideoResolutionValue, videoSizeForResolution } from "@/components/video-settings-panel";
import type { AiConfig } from "@/stores/use-config-store";

type VideoChange = (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio", value: string) => void;
export function useVideoSelection(config: AiConfig, onChange: VideoChange, enabled = true) {
    const query = useVideoCapabilities(config, config.model || config.videoModel, undefined, enabled);
    const data = query.data;
    const resolutions = data?.resolutions.map(value => normalizeVideoResolutionValue(value).toLowerCase()) || [];
    const resolution = normalizeVideoResolutionValue(config.vquality).toLowerCase();
    const bounds = data?.duration;
    const seconds = Number(config.videoSeconds);
    const valid = Boolean(data?.available && bounds && Number.isInteger(seconds) && seconds >= bounds.min && seconds <= bounds.max && (!bounds.values?.length || bounds.values.includes(seconds)) && resolutions.includes(resolution));
    useEffect(() => {
        if (!enabled || !data?.available || !bounds) return;
        if (resolutions.length && !resolutions.includes(resolution)) {
            onChange("vquality", resolutions[0]);
            onChange("size", videoSizeForResolution(resolutions[0], config.size));
        }
        const next = String(boundVideoSeconds(config.videoSeconds, bounds));
        if (next !== config.videoSeconds) onChange("videoSeconds", next);
        if (!data.supportsAudio && config.videoGenerateAudio === "true") onChange("videoGenerateAudio", "false");
    }, [data, enabled, config.videoSeconds, config.videoGenerateAudio, config.size, resolution, onChange]);
    return { ...query, valid };
}
