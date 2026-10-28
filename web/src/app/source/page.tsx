export default function SourceNotice() {
    const revision = process.env.NEXT_PUBLIC_METEOR_SOURCE_REVISION || "meteor/v0.8.2-integration-20261028";
    return <main className="mx-auto max-w-3xl space-y-5 px-6 py-12 text-foreground">
        <h1 className="text-2xl font-medium">流星创作台 · 无限画布开源说明</h1>
        <p>本服务基于 tigerowo/infinite-canvas 正式版本 v0.8.2 改造，并参考 leezeqi/canvas 的 Sub2API 适配。保留无限画布及原作者标识，贡献者包括 basketikun、HuFakai、tigerowo 和 leezeqi。许可证为 GNU AGPL 第 3 版。</p>
        <p>本次改造接入流星 API 的账号、模型权限和统一钱包；保留原版工作台、画布、素材、提示词、图像、视频和 Agent 界面。独立注册、管理员账户、匿名存储与外部桥接被停用。</p>
        <p><a className="underline" href={`https://github.com/Meteor21c/canvas/tree/${revision}`} target="_blank" rel="noreferrer">获取当前部署提交的完整对应源码与安装说明</a> · <a className="underline" href="/studio/LICENSE.txt">完整 AGPL-3.0 许可证</a></p>
        <p><a className="underline" href="https://github.com/tigerowo/infinite-canvas/tree/v0.8.2" target="_blank" rel="noreferrer">原版 v0.8.2</a> · <a className="underline" href="https://github.com/leezeqi/canvas" target="_blank" rel="noreferrer">Sub2API 适配参考</a> · <a className="underline" href="/studio">返回创作台</a></p>
        <p className="break-all text-sm opacity-60">版本引用：{revision}</p>
    </main>;
}
