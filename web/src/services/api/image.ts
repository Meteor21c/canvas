"use client";
import { nanoid } from "nanoid";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import type { UploadedImage } from "@/services/image-storage";
import { readMedia } from "@/services/meteor-media-cache";
import type { ReferenceImage } from "@/types/image";
import { meteorImageAuthorization,meteorImagePlatform,meteorImageSize,meteorImageTier } from "./meteor-gateway";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ResponsesApiResponse = {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ChatImagesApiResponse = {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

export type GeneratedImage = { id: string; dataUrl: string; seed?: number } & Partial<UploadedImage>;
export type CanvasImageTask = {
    id: string;
    parent_task_id?: string;
    object?: string;
    source?: string;
    source_id?: string;
    node_id?: string;
    channelId?: string;
    userChannelId?: string;
    channelName?: string;
    model?: string;
    prompt?: string;
    status: "queued" | "processing" | "completed" | "failed" | string;
    progress?: number;
    url?: string;
    image_url?: string;
    image_urls?: string[];
    imageStorage?: Array<UploadedImage | null>;
    storageKey?: string;
    width?: number;
    height?: number;
    mimeType?: string;
    bytes?: number;
    started_at?: string;
    startedAt?: string;
    created_at?: string;
    createdAt?: string;
    completed_at?: string;
    error?: { message?: string };
    error_detail?: string;
};
export type CanvasImageTaskOptions = { nodeId?: string; source?: "canvas" | "image-workbench" | "workflow"; sourceId?: string; clientTaskId?: string };


export class ImageRequestError extends Error {
    detail?: string;
    constructor(message:string, detail?:unknown) { super(message); this.name="ImageRequestError"; this.detail=typeof detail==="string"?detail:undefined; }
}
const pending = new Map<string, Promise<CanvasImageTask>>();
let pendingSession = "";
let busy=false;
const UNKNOWN="请求结果未确认，请先到本站使用记录核对。本次不会自动重试，避免重复扣费。";
function safeError(value:unknown) { return String(value || "生成失败").replace(/https?:\/\/[^\s]+/g,"[链接]").replace(/Bearer\s+\S+/gi,"[凭据]").replace(/\b(?:sk-|yh-)[A-Za-z0-9_-]+/g,"[凭据]").slice(0,500); }

export function aiApiUrl(_config:AiConfig,path:string) {
    if(!["/images/generations","/images/edits","/models"].includes(path)) throw new Error("试用版仅开放手动图片生成");
    return `/v1${path}`;
}
export function aiHeaders(config:AiConfig,contentType?:string) { return {Authorization:meteorImageAuthorization(config),...(contentType?{"Content-Type":contentType}:{})}; }
export function refreshRemoteUser(_config:AiConfig) { void useUserStore.getState().hydrateUser(); }

async function responseJSON(response:Response):Promise<Record<string,any>> {
    if(!response.body) throw new ImageRequestError(UNKNOWN);
    const reader=response.body.getReader(); let length=0; const chunks:Uint8Array<ArrayBuffer>[]=[];
    try {
        for(;;) { const {done,value}=await reader.read(); if(done) break; length+=value.byteLength; if(length>32*1024*1024) throw new ImageRequestError("图片响应超过 32 MB。"+UNKNOWN); chunks.push(new Uint8Array(value)); }
    } finally { await reader.cancel().catch(()=>undefined); }
    try { return JSON.parse(await new Blob(chunks).text()); } catch { throw new ImageRequestError(UNKNOWN); }
}

async function requestImages(config:AiConfig,prompt:string,references:ReferenceImage[]):Promise<GeneratedImage[]> {
    if(busy) throw new ImageRequestError("已有图片正在生成，请等本次请求结束");
    if(!prompt.trim() || prompt.length>20000) throw new ImageRequestError("提示词不能为空且不能超过 20000 字");
    if(references.length>4) throw new ImageRequestError("参考图最多 4 张");
    const authorization=meteorImageAuthorization(config), platform=meteorImagePlatform(config),size=meteorImageSize(config),tier=meteorImageTier(config);
    const owner=useUserStore.getState().user?.id;
    busy=true;
    let submitted=false,completed=false;
    try {
        const refs:Blob[]=[];
        for(const reference of references) refs.push(await readMedia(await imageToDataUrl(reference)));
        if(refs.some(blob=>blob.size>10*1024*1024) || refs.reduce((n,blob)=>n+blob.size,0)>15*1024*1024) throw new ImageRequestError("单张参考图最多 10 MB，合计最多 15 MB");
        let path="/v1/images/generations",body:BodyInit,headers:Record<string,string>={Authorization:authorization};
        if(platform==="gemini") {
            path=`/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
            const parts:Array<Record<string,unknown>>=[{text:prompt}];
            for(const reference of references) { const data=await imageToDataUrl(reference); parts.push({inlineData:{mimeType:data.slice(5,data.indexOf(";")),data:data.slice(data.indexOf(",")+1)}}); }
            body=JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseModalities:["TEXT","IMAGE"],imageConfig:{imageSize:tier,aspectRatio:config.size || "1:1"}}});
            headers["Content-Type"]="application/json";
        } else if(refs.length) {
            path="/v1/images/edits";
            const form=new FormData();
            form.set("model",config.model); form.set("prompt",prompt); form.set("n","1"); form.set("response_format","b64_json"); form.set("size",size);
            refs.forEach((blob,index)=>form.append(refs.length===1?"image":"image[]",blob,`reference-${index}.`+(blob.type==="image/jpeg"?"jpg":blob.type.split("/")[1])));
            body=form;
        } else {
            headers["Content-Type"]="application/json";
            body=JSON.stringify({model:config.model,prompt,n:1,response_format:"b64_json",size});
        }
        if(useUserStore.getState().user?.id!==owner) throw new ImageRequestError("登录账号已变化");
        submitted=true;
        const response=await fetch(path,{method:"POST",headers,body,signal:AbortSignal.timeout(600000),cache:"no-store"});
        const data=await responseJSON(response);
        if(!response.ok || data.error) throw new ImageRequestError(safeError(data.error?.message || data.message || `生成接口返回 ${response.status}`));
        if(useUserStore.getState().user?.id!==owner) throw new ImageRequestError("登录账号已变化。"+UNKNOWN);
        const results:Array<string>=[];
        if(platform==="gemini") {
            for(const candidate of data.candidates || []) for(const part of candidate.content?.parts || []) {
                const inline=part.inlineData || part.inline_data;
                if(inline?.data && /^image\/(png|jpeg|webp|avif)$/.test(inline.mimeType || inline.mime_type || "")) results.push(`data:${inline.mimeType || inline.mime_type};base64,${inline.data}`);
            }
        } else for(const image of Array.isArray(data.data)?data.data:[]) {
            if(image.b64_json) results.push(image.b64_json.startsWith("data:")?image.b64_json:`data:image/png;base64,${image.b64_json}`);
            else if(image.url) results.push(image.url);
        }
        if(!results.length) throw new ImageRequestError("上游没有返回可显示的图片。"+UNKNOWN);
        completed=true;
        const stored=await uploadImage(results[0]);
        refreshRemoteUser(config);
        return [{id:nanoid(),dataUrl:stored.url,...stored}];
    } catch(error) {
        if(error instanceof ImageRequestError) throw error;
        if(completed) throw new ImageRequestError("生成已完成，但图片无法在本机缓存："+safeError(error instanceof Error?error.message:error)+"。请核对使用记录，勿直接重新生成。");
        throw new ImageRequestError(submitted?UNKNOWN:safeError(error instanceof Error?error.message:error));
    } finally { busy=false; }
}

export async function requestGeneration(config:AiConfig & {seedIndex?:number;seedCount?:number},prompt:string) { return requestImages(config,prompt,[]); }
export async function requestEdit(config:AiConfig & {seedIndex?:number;seedCount?:number},prompt:string,references:ReferenceImage[]) { return requestImages(config,prompt,references); }
export async function createCanvasImageTask(config:AiConfig & {seedIndex?:number;seedCount?:number},prompt:string,references:ReferenceImage[],options:CanvasImageTaskOptions={}):Promise<CanvasImageTask> {
    // Validate the current owner/model even on a cached attempt. Old browser
    // sessions must never receive another account's completed image.
    meteorImageAuthorization(config);
    const session=useUserStore.getState().token;
    if(session!==pendingSession) { pending.clear(); pendingSession=session; }
    const id=options.clientTaskId || nanoid();
    if(pending.has(id)) return pending.get(id)!;
    if(pending.size>=128) throw new ImageRequestError("本次画布已达到 128 次请求上限。请核对未确认的使用记录后重新打开画布。");
    const request=(async()=>{
        const [image]=await requestImages(config,prompt,references);
        const stored=image as UploadedImage;
        return {id,source:"canvas",source_id:options.sourceId,node_id:options.nodeId,model:config.model,prompt,status:"completed",progress:100,
            url:stored.url,image_url:stored.url,storageKey:stored.storageKey,width:stored.width,height:stored.height,bytes:stored.bytes,mimeType:stored.mimeType,imageStorage:[stored]} satisfies CanvasImageTask;
    })();
    pending.set(id,request);
    // Keep uncertain attempts for this session; replaying the same task never submits twice.
    return request;
}
export async function pollCanvasImageTaskStatus(_id:string):Promise<CanvasImageTask> { throw new ImageRequestError("此图片请求无法断线恢复。"+UNKNOWN); }
export async function requestImageQuestion(_config:AiConfig,_messages:ChatCompletionMessage[],_onDelta:(text:string)=>void):Promise<string> { throw new ImageRequestError("文本节点用于编辑和连接提示词，试用版暂未开放付费文本生成"); }
export async function fetchImageModels(config:AiConfig) { return config.imageModels; }
export async function listCanvasImageTasks(_config:AiConfig,_sources:Array<"image-workbench"|"workflow"|"canvas">=[]):Promise<CanvasImageTask[]> { return []; }
export async function batchCanvasImageTaskStatus(_config:AiConfig,_ids:string[]):Promise<CanvasImageTask[]> { return []; }
export async function deleteCanvasImageTask(_config:AiConfig,_task?:CanvasImageTask|null) { }
