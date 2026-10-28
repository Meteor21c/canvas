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
    if (file.size > 256 * 1024 * 1024) throw new Error("画布压缩包不能超过 256 MiB");
    let total = 0, count = 0;
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
        total += entry.originalSize;
        count++;
        if (entry.name.startsWith("/") || entry.name.split("/").includes("..") || entry.originalSize > 64 * 1024 * 1024 || total > 256 * 1024 * 1024 || count > 300) throw new Error("压缩包路径无效或解压后超出媒体容量限制");
        return true;
    } });
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}
