"use client";

import { apiGet } from "./request";
import { fetchCurrentUser } from "./auth";
import { defaultConfig, channelIdForActiveModel, modelMatchesCapability, useConfigStore, type AiConfig, type LocalModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { clearMediaSession, cleanupExpiredMedia } from "@/services/meteor-media-cache";

type Key = { id:number; user_id:number; group_id:number; name:string; key:string; status:string; expires_at?:string; quota:number; quota_used:number };
type Group = { id:number; name:string; platform:string; status:string; allow_image_generation:boolean; rate_multiplier:number; image_price_1k?:number|null; image_price_2k?:number|null; image_price_4k?:number|null };
type Channel = { key:Key; group:Group; models:string[]; rate:number };
let channels = new Map<string,Channel>();
let owner = "";
let initialization = 0;

export function clearMeteorCanvasSession() {
    initialization++;
    channels.clear(); owner = "";
    clearMediaSession();
    useConfigStore.setState({config:{...defaultConfig,baseUrl:"",apiKey:"",models:[],imageModels:[],localChannels:[],model:"",imageModel:""}});
    useUserStore.getState().clearSession();
}

export async function initializeMeteorCanvas() {
    const epoch = ++initialization;
    const token = window.localStorage.getItem("auth_token") || "";
    if (!token) { clearMeteorCanvasSession(); throw new Error("请先在流星 API 主站登录，再打开画布"); }
    const [user,access] = await Promise.all([
        fetchCurrentUser(token),
        apiGet<{allowed:boolean}>("/api/v1/canvas/access",undefined,token),
    ]);
    if (!access.allowed || user.role !== "admin") { clearMeteorCanvasSession(); throw new Error("创作画布当前仅限站主试用"); }
    const checkSession = () => {
        if (epoch !== initialization || window.localStorage.getItem("auth_token") !== token) throw new Error("登录状态已变化，请重新打开画布");
    };
    checkSession();
    const [groups,rates] = await Promise.all([
        apiGet<Group[]>("/api/v1/groups/available",undefined,token),
        apiGet<Record<string,number>>("/api/v1/groups/rates",undefined,token),
    ]);
    const keys:Key[] = [];
    for (let page=1;page<=10;page++) {
        const result=await apiGet<{items:Key[];total:number}>("/api/v1/keys",{page,page_size:100,status:"active"},token);
        keys.push(...result.items);
        if (!result.items.length || keys.length>=result.total) break;
        if (page===10) throw new Error("密钥数量过多，请先在主站管理密钥");
    }
    checkSession();
    const available = keys.filter(key => String(key.user_id)===user.id && key.status==="active" && Boolean(key.key) &&
        (!key.expires_at || Date.parse(key.expires_at)>Date.now()) && (!key.quota || key.quota_used<key.quota) &&
        groups.some(group=>group.id===key.group_id && group.status!=="inactive" && group.allow_image_generation===true)).slice(0,20);
    const loaded = new Map<string,Channel>();
    // Catalog probes are read-only; keep concurrency low on the shared gateway.
    for(let offset=0;offset<available.length;offset+=2) {
        await Promise.all(available.slice(offset,offset+2).map(async key=>{
            const group=groups.find(group=>group.id===key.group_id)!;
            try {
                const response=await fetch("/v1/models",{headers:{Authorization:`Bearer ${key.key}`},cache:"no-store",signal:AbortSignal.timeout(15000)});
                if(!response.ok) return;
                const body=await response.json() as {data?:Array<{id:string}>};
                const protocol=group.platform==="gemini"?"gemini":"openai";
                const models=(body.data||[]).map(model=>model.id).filter(model=>typeof model==="string" && modelMatchesCapability(model,"image",protocol));
                const rawRate=rates[String(group.id)] ?? group.rate_multiplier;
                if(models.length) loaded.set(String(key.id),{key,group,models,rate:Number.isFinite(Number(rawRate))?Number(rawRate):1});
            } catch { /* A broken key is not offered as a working image channel. */ }
        }));
        checkSession();
    }
    if(owner && owner!==user.id) clearMediaSession();
    owner=user.id; channels=loaded;
    const safeChannels:LocalModelChannel[]=[...loaded].map(([id,row])=>({id,name:`${row.key.name || `密钥 ${id}`} · ${row.group.name}`,protocol:row.group.platform==="gemini"?"gemini":"openai",baseUrl:window.location.origin,apiKey:"",models:row.models}));
    const model=safeChannels[0]?.models[0] || "";
    const id=safeChannels[0]?.id || "";
    const models=[...new Set(safeChannels.flatMap(channel=>channel.models))];
    useUserStore.getState().setSession(token,user);
    useConfigStore.setState({config:{...defaultConfig,baseUrl:window.location.origin,channelMode:"local",apiKey:"",model,imageModel:model,models,imageModels:models,
        textModel:"",textModels:[],videoModels:[],audioModels:[],localChannels:safeChannels,imageChannelId:id,activeChannelId:id,
        count:"1",canvasImageCount:"1",quality:"low",size:"1:1",publicChannels:[]}});
    await cleanupExpiredMedia();
    checkSession();
}

function activeChannel(config:AiConfig) {
    if(!owner || useUserStore.getState().user?.id!==owner || useUserStore.getState().token!==window.localStorage.getItem("auth_token")) throw new Error("登录状态已变化，请刷新画布");
    const row=channels.get(channelIdForActiveModel(config));
    if(!row || !row.models.includes(config.model)) throw new Error("请选择当前密钥可用的图片模型");
    if(row.key.expires_at && Date.parse(row.key.expires_at)<=Date.now()) throw new Error("密钥已过期，请刷新画布");
    return row;
}

export function meteorImageAuthorization(config:AiConfig) { return `Bearer ${activeChannel(config).key.key}`; }
export function meteorImagePlatform(config:AiConfig) { return activeChannel(config).group.platform; }
export function meteorImageTier(config:AiConfig):"1K"|"2K"|"4K" {
    const value=(config.quality || "low").toLowerCase();
    return value==="high" || value==="4k"?"4K":value==="medium" || value==="2k"?"2K":"1K";
}
export function getMeteorImageQuote(config:AiConfig):string {
    try {
        const row=activeChannel({...config,model:config.model || config.imageModel});
        const tier=meteorImageTier(config);
        const price=tier==="4K"?row.group.image_price_4k:tier==="2K"?row.group.image_price_2k:row.group.image_price_1k;
        return price===null || price===undefined?`${tier} · 单价以本站用量账单为准`:`${tier} · $${Number((Number(price)*row.rate).toFixed(8))}/张（实际以账单为准）`;
    } catch { return "请选择可用的绘图密钥与模型"; }
}

export function meteorImageSize(config:AiConfig) {
    const row=activeChannel(config), tier=meteorImageTier(config);
    const configured=[row.group.image_price_1k,row.group.image_price_2k,row.group.image_price_4k].some(value=>value!==null && value!==undefined);
    const price=tier==="4K"?row.group.image_price_4k:tier==="2K"?row.group.image_price_2k:row.group.image_price_1k;
    if(configured && (price===null || price===undefined) || (!configured && tier==="4K")) throw new Error("当前分组未配置这个图片档位");
    const ratio=config.size || "1:1";
    const dimensions:Record<string,Record<string,string>>={"1K":{"1:1":"1024x1024","16:9":"1024x576","9:16":"576x1024"},"2K":{"1:1":"2048x2048","16:9":"2048x1152","9:16":"1152x2048"},"4K":{"16:9":"3840x2160","9:16":"2160x3840"}};
    const size=dimensions[tier][ratio];
    if(!size) throw new Error("这个档位不支持当前比例，请选择横屏或竖屏");
    return size;
}
