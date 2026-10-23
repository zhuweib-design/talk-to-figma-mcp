// 控制台「记录」标签页的数据源：把总控台的项目单转成页面能直接渲染的清单。
//
// 为什么单独开这一个文件：中继 socket.ts 与公开仓库那份是刻意保持同步的，
// 离线体检要求它除了注释与 BUN 路径以外不得有真差异。这个功能是只存在于内部
// 仓库的本机能力（原型站、总控台端口这些公开那份根本没有），塞进 socket.ts
// 就得逐行登记豁免，反而把那份同步约束稀释掉了。放成独立文件，公开那份没有这个
// 文件，体检按"两边都有才比对"的规则自然跳过；socket.ts 里只剩引入与挂路由两行，
// 登记两条豁免即可，其余 480 行照样受体检管。
//
// 原型站页面本身不由这里发出：页面还是总控台按 /proto/<项目id>/<页>.html 直出，
// 这里只回答"有哪些项目、每个项目有哪些页"。控制台只认中继这一个上游，
// 所以由中继转一次，不给总控台开跨源。

const HUB_URL = process.env.HUB_URL || "http://127.0.0.1:8790";

export type ProtoSites = {
  ok: boolean;
  hubPort?: number;
  sites?: {
    id: string;
    name: string;
    pages: string[];
    pageCount: number;
    updatedAt: string;
    broken: boolean;
  }[];
  error?: string;
};

function hubPortFromEnv(): number {
  // HUB_URL 被人改成别的端口时清单里的链接要跟着走，不能让页面写死 8790
  const tail = Number(String(HUB_URL).split(":").pop());
  return Number.isFinite(tail) && tail > 0 ? tail : 8790;
}

export async function protoSitesPayload(): Promise<ProtoSites> {
  try {
    const res = await fetch(`${HUB_URL}/api/flow`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `总控台回了 HTTP ${res.status}`, sites: [] };
    const data: any = await res.json();
    return {
      ok: true,
      hubPort: Number(data.hubPort) || hubPortFromEnv(),
      sites: (data.projects || []).map((p: any) => ({
        id: String(p.id || ""),
        name: String(p.name || p.id || ""),
        pages: Array.isArray(p.pages) ? p.pages.map(String) : [],
        pageCount: Number(p.pageCount || 0),
        updatedAt: String(p.updatedAt || ""),
        broken: !!p.broken,
      })),
    };
  } catch (e) {
    return { ok: false, error: `总控台 ${HUB_URL} 没应答：${e}`, sites: [] };
  }
}
