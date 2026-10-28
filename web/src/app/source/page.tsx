export default function SourceNotice() {
    const revision = process.env.NEXT_PUBLIC_METEOR_SOURCE_REVISION || "meteor/pilot-20261028";
    const source = `https://github.com/Meteor21c/canvas/tree/${revision}`;
    return (
        <main className="mx-auto max-w-3xl space-y-5 px-6 py-12 text-foreground">
            <h1 className="text-2xl font-medium">流星创作画布 · 开源说明</h1>
            <p>本试用版基于无限画布（Hajimi 内部修改版）改造。原作者与贡献者包括 basketikun、HuFakai、tigerowo 和 leezeqi。保留原项目标识及 GNU AGPL 第 3 版许可证。</p>
            <p>本次改造将身份、模型权限、图片生成与项目保存接入流星 API，停用原项目独立注册、渠道代理及算力点体系。</p>
            <p>正在提供服务的改造版本源码（包括构建与安装说明）：<a className="underline" href={source} target="_blank" rel="noreferrer">获取对应源码</a>。</p>
            <p><a className="underline" href="/studio/LICENSE.txt">查看完整 GNU AGPL-3.0 许可证</a> · <a className="underline" href="https://github.com/leezeqi/canvas" target="_blank" rel="noreferrer">原项目</a> · <a className="underline" href="/studio/canvas">返回画布</a></p>
            <p className="break-all text-sm opacity-60">版本引用：{revision}</p>
        </main>
    );
}
