import { apiGet, apiPost } from "./request";
import type { MeteorCapabilities, MeteorQuote, MeteorQuoteInput, PricingKind } from "@/types/meteor-pricing";

export function fetchMeteorCapabilities(input: { kind: PricingKind; channelId: string; model: string }, token: string) {
    return apiGet<MeteorCapabilities>("/api/v1/meteor/capabilities", input, token);
}

export function fetchMeteorQuote(input: MeteorQuoteInput, token: string) {
    return apiPost<MeteorQuote>("/api/v1/meteor/quote", input, token);
}
