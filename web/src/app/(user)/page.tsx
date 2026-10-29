import Link from "next/link";
import { ArrowDownToLine, ArrowUpRight, Clock3, FileText, ImagePlus, Images, Maximize2, Play, Sparkles, Video } from "lucide-react";

const entries = [
    { href: "/canvas", title: "我的画布", description: "连接文字、画面与分镜，展开完整创意。", icon: Maximize2, color: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300", hint: "在画布上自由创作" },
    { href: "/image", title: "生图工作台", description: "从一句描述或一张参考图，探索新画面。", icon: ImagePlus, color: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300", hint: "把想法变成图像" },
    { href: "/video", title: "视频创作台", description: "让静止的灵感，成为流动的故事。", icon: Video, color: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300", hint: "开始你的下一幕" },
    { href: "/prompts", title: "提示词库", description: "发现创作灵感，收藏值得复用的表达。", icon: FileText, color: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300", hint: "发现更多好点子" },
    { href: "/assets", title: "我的素材", description: "收好常用素材，让每次创作从容开始。", icon: Images, color: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300", hint: "整理你的创作收藏" },
] as const;

export default function IndexPage() {
    return (
        <main className="h-full overflow-x-hidden overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto w-full max-w-7xl px-5 pb-8 pt-8 sm:px-8 sm:pt-10 lg:px-10">
                <section className="grid items-center gap-8 pb-9 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-7 lg:pb-10 xl:gap-12">
                    <div className="min-w-0 max-w-xl py-2">
                        <p className="mb-5 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-stone-400 dark:text-stone-500">
                            <span className="h-px w-7 bg-stone-300 dark:bg-stone-700" />
                            METEOR STUDIO
                        </p>
                        <h1 className="text-[2.5rem] font-medium leading-[1.25] tracking-tight sm:text-5xl xl:text-[3.25rem]">
                            让灵感，
                            <br />
                            自由生长。
                        </h1>
                        <p className="mt-5 max-w-sm text-sm leading-7 text-stone-500 dark:text-stone-400">
                            从第一张参考图，到下一段精彩故事。
                            <br />
                            让创意在画布上连接，让作品在这里发生。
                        </p>
                        <Link
                            href="/canvas"
                            className="mt-6 inline-flex items-center gap-3 rounded-full bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                        >
                            打开我的画布
                            <ArrowUpRight className="size-4" aria-hidden="true" />
                        </Link>
                    </div>
                    <CanvasPreview />
                </section>
                <section aria-labelledby="studio-entry-title" className="border-t border-stone-200/80 pt-6 dark:border-stone-800">
                    <div className="mb-5 flex items-end justify-between gap-4">
                        <div>
                            <h2 id="studio-entry-title" className="text-base font-medium tracking-tight">
                                从这里开始创作
                            </h2>
                            <p className="mt-1.5 text-xs text-stone-400 dark:text-stone-500">一个空间，更多可能。</p>
                        </div>
                        <Link href="/pricing" className="flex shrink-0 items-center gap-1 text-xs text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white">
                            查看计价标准
                            <ArrowUpRight className="size-3.5" aria-hidden="true" />
                        </Link>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                        {entries.map(({ href, title, description, icon: Icon, color, hint }) => (
                            <Link
                                key={href}
                                href={href}
                                className="group flex min-h-48 min-w-0 flex-col rounded-2xl border border-stone-200/90 bg-white p-5 transition duration-200 hover:-translate-y-1 hover:border-stone-300 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.18)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-stone-500 dark:border-stone-800 dark:bg-stone-900/60 dark:hover:border-stone-600"
                            >
                                <div className="mb-5 flex items-center justify-between">
                                    <span className={`flex size-10 items-center justify-center rounded-xl ${color}`}>
                                        <Icon className="size-5" strokeWidth={1.6} aria-hidden="true" />
                                    </span>
                                    <ArrowUpRight
                                        className="size-4 -translate-x-1 translate-y-1 text-stone-300 transition group-hover:translate-x-0 group-hover:translate-y-0 group-hover:text-stone-700 dark:text-stone-700 dark:group-hover:text-stone-200"
                                        aria-hidden="true"
                                    />
                                </div>
                                <h3 className="text-sm font-medium">{title}</h3>
                                <p className="mt-2 text-xs leading-6 text-stone-500 dark:text-stone-400">{description}</p>
                                <span className="mt-auto pt-5 text-[10px] text-stone-400 dark:text-stone-500">{hint}</span>
                            </Link>
                        ))}
                    </div>
                </section>
                <aside className="mt-5 flex flex-col gap-3 rounded-xl bg-stone-100/75 px-4 py-3 text-xs leading-5 text-stone-500 sm:flex-row sm:items-center sm:justify-between dark:bg-stone-900/70 dark:text-stone-400">
                    <p className="flex items-start gap-2">
                        <Clock3 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span>画布自最近编辑起保留 7 天，图片与视频保留 7 天。</span>
                    </p>
                    <p className="flex items-start gap-2">
                        <ArrowDownToLine className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span>请经常导出，并将重要作品备份到本地。</span>
                    </p>
                </aside>
            </div>
        </main>
    );
}

function CanvasPreview() {
    return (
        <div
            aria-label="创作画布预览：文字连接参考画面与视频分镜"
            className="relative isolate aspect-[1.8] min-h-64 w-full min-w-0 overflow-hidden rounded-[1.4rem] border border-stone-200/80 bg-[#f3f3ef] bg-[radial-gradient(#b4b8b9_0.65px,transparent_0.65px)] [background-size:16px_16px] dark:border-stone-800 dark:bg-[#1b1e1e] dark:bg-[radial-gradient(#3b4141_0.65px,transparent_0.65px)]"
        >
            <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/80 bg-white/80 px-2.5 py-1 text-[9px] tracking-wide text-stone-400 backdrop-blur dark:border-stone-700 dark:bg-stone-900/80 dark:text-stone-500">
                <span className="size-1.5 rounded-full bg-emerald-500/70" />
                画布预览
            </div>
            <svg viewBox="0 0 600 334" className="absolute inset-0 size-full" fill="none" aria-hidden="true">
                <path d="M192 181C235 181 220 111 265 111M420 111C467 111 416 242 466 242" className="stroke-stone-300 dark:stroke-stone-600" strokeWidth="1.5" />
                <circle cx="192" cy="181" r="3" className="fill-stone-400 dark:fill-stone-500" />
                <circle cx="265" cy="111" r="3" className="fill-stone-400 dark:fill-stone-500" />
                <circle cx="420" cy="111" r="3" className="fill-stone-400 dark:fill-stone-500" />
                <circle cx="466" cy="242" r="3" className="fill-stone-400 dark:fill-stone-500" />
            </svg>
            <div className="absolute left-[5%] top-[38%] w-[28%] -rotate-3 rounded-xl border border-stone-200 bg-white p-3 shadow-[0_8px_24px_-15px_rgba(0,0,0,0.4)] dark:border-stone-700 dark:bg-stone-900">
                <div className="flex items-center gap-1.5 text-[8px] text-stone-400">
                    <FileText className="size-2.5" aria-hidden="true" />
                    灵感笔记
                </div>
                <p className="mt-2 text-[11px] font-medium leading-5 sm:text-xs">
                    在日落的海岸，
                    <br />
                    收集温柔的光。
                </p>
                <div className="mt-3 h-px w-4/5 bg-stone-100 dark:bg-stone-800" />
                <div className="mt-1.5 h-px w-3/5 bg-stone-100 dark:bg-stone-800" />
            </div>
            <div className="absolute left-[44%] top-[15%] w-[27%] rotate-3 rounded-xl border border-white/80 bg-white p-1.5 shadow-[0_12px_25px_-15px_rgba(0,0,0,0.4)] dark:border-stone-700 dark:bg-stone-900">
                <CoastScene className="aspect-[1.35] w-full rounded-lg" />
                <div className="flex items-center justify-between px-1 pb-1 pt-2 text-[8px] text-stone-400">
                    <span>01 / 日落海岸</span>
                    <ImagePlus className="size-2.5" aria-hidden="true" />
                </div>
            </div>
            <div className="absolute bottom-[10%] right-[5%] w-[31%] -rotate-2 rounded-xl border border-white/80 bg-white p-1.5 shadow-[0_10px_24px_-15px_rgba(0,0,0,0.35)] dark:border-stone-700 dark:bg-stone-900">
                <div className="relative">
                    <CoastScene className="aspect-[1.8] w-full rounded-lg" dusk />
                    <span className="absolute inset-0 flex items-center justify-center">
                        <span className="flex size-7 items-center justify-center rounded-full bg-white/80 text-stone-700 backdrop-blur">
                            <Play className="ml-0.5 size-2.5 fill-current" aria-hidden="true" />
                        </span>
                    </span>
                </div>
                <div className="flex items-center justify-between px-1 pb-1 pt-2 text-[8px] text-stone-400">
                    <span>02 / 海风与光</span>
                    <span className="flex gap-0.5">
                        {[1, 2, 3, 4, 5].map((value) => (
                            <span key={value} className="h-1 w-3 rounded-sm bg-stone-200 dark:bg-stone-700" />
                        ))}
                    </span>
                </div>
            </div>
            <Sparkles className="absolute bottom-[14%] left-[39%] size-4 text-stone-300 dark:text-stone-600" strokeWidth={1} aria-hidden="true" />
        </div>
    );
}

function CoastScene({ className, dusk = false }: { className: string; dusk?: boolean }) {
    return (
        <svg viewBox="0 0 240 160" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden="true">
            <rect width="240" height="160" fill={dusk ? "#bdbdc1" : "#e7cdb5"} />
            <circle cx="161" cy="58" r="24" fill={dusk ? "#ebc6a0" : "#fff0d1"} />
            <path d="M0 98Q55 89 108 99T240 97V160H0Z" fill={dusk ? "#7e969b" : "#a6bbba"} />
            <path d="M0 126Q61 104 132 128T240 120V160H0Z" fill={dusk ? "#57767b" : "#718f91"} />
            <path d="M0 115Q37 124 82 148L111 160H0Z" fill={dusk ? "#9d9b8d" : "#d6bd9b"} />
            <path d="M130 113h27m9 7h31m-98 15h33m44-30h22" stroke="#f7edda" strokeOpacity=".5" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}
