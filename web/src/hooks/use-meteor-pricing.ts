"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { pricingInputFromConfig, type PricingSelection } from "@/lib/meteor-pricing";
import { fetchMeteorCapabilities, fetchMeteorQuote } from "@/services/api/meteor-pricing";
import { useUserStore } from "@/stores/use-user-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { MeteorQuoteInput, PricingKind } from "@/types/meteor-pricing";

export function useMeteorCapabilities(input: { kind: PricingKind; model: string; channelId: string }, enabled = true) {
    const userId = useUserStore(state => state.user?.id);
    const token = useUserStore(state => state.token);
    return useQuery({
        queryKey: ["meteor-pricing", userId || "signed-out", "capabilities", input],
        queryFn: () => fetchMeteorCapabilities(input, token || ""),
        enabled: enabled && Boolean(userId && token && input.model && input.channelId),
        staleTime: 30_000, gcTime: 60_000, retry: false,
    });
}

export function useMeteorQuote(input: MeteorQuoteInput, enabled = true) {
    const userId = useUserStore(state => state.user?.id);
    const token = useUserStore(state => state.token);
    const inputKey = JSON.stringify(input);
    const [settled, setSettled] = useState(input);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(input), 250);
        return () => clearTimeout(timer);
    }, [inputKey]); // The stable serialization prevents unrelated store renders from delaying a quote.
    const pending = JSON.stringify(settled) !== inputKey;
    const ready = enabled && Boolean(userId && token && input.model && input.channelId);
    const query = useQuery({
        queryKey: ["meteor-pricing", userId || "signed-out", "quote", settled],
        queryFn: () => fetchMeteorQuote(settled, token || ""),
        enabled: ready && !pending,
        staleTime: 15_000, gcTime: 60_000, retry: false,
    });
    return { ...query, data: pending ? undefined : query.data, isLoading: ready && (pending || query.isLoading) };
}

export function useMeteorPricing(config: AiConfig, kind: PricingKind, options: PricingSelection & { enabled?: boolean } = {}) {
    const input = pricingInputFromConfig(config, kind, options);
    const capabilities = useMeteorCapabilities({ kind, model: input.model, channelId: input.channelId }, options.enabled !== false);
    const quote = useMeteorQuote(input, options.enabled !== false);
    return { input, capabilities, quote };
}

export function useVideoCapabilities(config: AiConfig, model?: string, channelId?: string, enabled = true) {
    const input = pricingInputFromConfig(config, "video", { model, channelId });
    const query = useMeteorCapabilities({ kind: "video", model: input.model, channelId: input.channelId }, enabled);
    return {
        ...query,
        data: query.data ? { ...query.data, supportsAudio: query.data.supportsAudio ?? query.data.scenarios.some(scenario => scenario.audio) } : undefined,
    };
}
