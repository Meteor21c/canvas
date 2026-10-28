export type PricingKind = "image" | "video";
export type PriceValue = string | null;
export type PricingUnit = "million_output_tokens" | "second" | "image" | "request" | "unknown";
export type TokenPrices = { inputPerMillion: PriceValue; cacheReadPerMillion: PriceValue; imageInputPerMillion: PriceValue; imageOutputPerMillion: PriceValue; outputPerMillion: PriceValue };

export type PricingScenario = {
    resolutions: string[];
    audio: boolean;
    inputVideo: boolean;
    billingMode: string;
    unit?: PricingUnit;
    tokenPrices?: TokenPrices;
    currency: string;
    siteUnitPrice: PriceValue;
    officialUnitPrice: PriceValue;
    saleRateToOfficial: PriceValue;
};

export type MeteorCapabilities = {
    kind: PricingKind;
    model: string;
    channelId: string;
    available: boolean;
    maxBatch: number;
    maxReferences: number;
    forcedProtocol: "images" | "sub2api";
    watermark: boolean;
    resolutions: string[];
    duration?: { min: number; max: number; values?: number[] };
    supportsAudio?: boolean;
    aspectRatios?: string[];
    scenarios: PricingScenario[];
    retentionDays: number;
    notice: string;
    videoInput?: MeteorVideoInputPolicy;
    uploads?: MeteorUploadPolicy;
};

export type MeteorUploadPolicy = {
    imageMaxBytes: number; videoMaxBytes: number; audioMaxBytes: number;
    totalReferenceMaxBytes: number; policySource: "site"; metadataRequired: boolean;
};

export type MeteorVideoInputPolicy = {
    modes: string[]; referenceTypes: string[]; firstFrame: boolean; lastFrame: boolean;
    lastFrameRequiresFirst: boolean; framesWithReferences: boolean;
    audioOnlyReferences: boolean; referenceVideoWithGeneratedAudio: boolean;
    referenceDuration?: { min: number; max: number };
    referenceLimits: { images: number; videos: number; audios: number; total: number };
    validationNotice: string;
};

export type MeteorQuoteInput = {
    kind: PricingKind;
    channelId: string;
    model: string;
    count: number;
    resolution: string;
    quality: string;
    size: string;
    duration?: number;
    audio: boolean;
    inputVideo: boolean;
};

export type MeteorQuote = {
    available: boolean;
    kind: PricingKind;
    model: string;
    channelId: string;
    billingMode: string;
    unit?: PricingUnit;
    tokenPrices?: TokenPrices;
    currency: string;
    siteUnitPrice: PriceValue;
    officialUnitPrice: PriceValue;
    saleRateToOfficial: PriceValue;
    estimatedAmount: PriceValue;
    prechargeAmount: PriceValue;
    exact: boolean;
    notice: string;
    imagePriceBySize?: Record<string, PriceValue>;
};
