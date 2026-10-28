import Link from "next/link";
import { ArrowUpRight, AudioLines, MousePointer2, Plus } from "lucide-react";

export default function MusicPage() {
    return (
        <main className="h-full overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-12 text-stone-900 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)] dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
                <div className="flex size-16 items-center justify-center rounded-2xl border border-stone-200 bg-white text-stone-700 shadow-sm dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                    <AudioLines className="size-7" aria-hidden="true" />
                </div>
                <p className="mt-6 text-xs font-medium tracking-widest text-stone-500 dark:text-stone-400">音频创作</p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">在画布中使用音频节点</h1>
                <p className="mt-4 max-w-xl text-sm leading-7 text-stone-500 dark:text-stone-400">
                    独立音乐工作台尚未提供。你可以进入画布，添加音频节点，使用主站当前已开放的音频能力；可用模型以节点内的模型列表为准。
                </p>
                <div className="mt-8 grid w-full gap-4 rounded-2xl border border-stone-200 bg-white/90 p-6 text-left shadow-sm sm:grid-cols-2 dark:border-stone-800 dark:bg-stone-900/90">
                    <div className="flex items-start gap-3">
                        <MousePointer2 className="mt-0.5 size-5 shrink-0 text-stone-400" aria-hidden="true" />
                        <div>
                            <h2 className="text-sm font-medium">打开或新建画布</h2>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">在“我的画布”中选择已有项目，或新建一个项目。</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <Plus className="mt-0.5 size-5 shrink-0 text-stone-400" aria-hidden="true" />
                        <div>
                            <h2 className="text-sm font-medium">添加音频节点</h2>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">点击底部工具栏的“音频”，再根据可用模型配置创作。</p>
                        </div>
                    </div>
                </div>
                <Link href="/canvas" className="mt-8 inline-flex items-center gap-2 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white">
                    前往我的画布
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                </Link>
            </div>
        </main>
    );
}
