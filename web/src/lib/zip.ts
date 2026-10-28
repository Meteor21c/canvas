import { unzipSync, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob) {
    if (file.size > 128 * 1024 * 1024) throw new Error("画布压缩包不能超过 128 MiB");
    let total = 0, count = 0;
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => {
        total += entry.originalSize; count++;
        if (count > 150 || total > 140 * 1024 * 1024 || entry.originalSize > 20 * 1024 * 1024) throw new Error("画布压缩包内容超出上限");
        if (entry.name.includes("..") || entry.name.startsWith("/") || entry.name.includes("\\")) throw new Error("压缩包路径无效");
        return true;
    } });
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}
