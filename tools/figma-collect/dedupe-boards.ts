// 去重：同名画板只保留最新的那一份，其余删掉。
// 场景：插件的"同名替换"只扫父节点直接子级，画板进了 Section 就替换不到，
// 重推会在页面层新建一份，跑一次分组又会把新旧两份一起收进组里，画布出现两套。
// 用法：bun dedupe-boards.ts [--channel powerplant] [--dry]
// 判定"最新"用节点 ID 的数字部分，Figma 的 ID 在同一会话里是递增的。
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const idx = argv.indexOf("--channel");
const CHANNEL = idx >= 0 ? argv[idx + 1] : "powerplant";
const DRY = argv.includes("--dry");

const numId = (id: string) => {
  const m = String(id).match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) : 0;
};

const figma = await openFigma(CHANNEL);
try {
  const doc: any = await figma.call("get_document_info", {});
  const boards: any[] = [];
  for (const child of doc.children || []) {
    if (child.type === "FRAME") boards.push(child);
    else if (child.type === "SECTION") {
      const s: any = await figma.call("get_node_info", { nodeId: child.id });
      for (const c of s.children || []) if (c.type === "FRAME") boards.push({ id: c.id, name: c.name });
    }
  }

  const byName = new Map<string, any[]>();
  for (const b of boards) {
    if (/^组件库/.test(b.name)) continue;
    byName.set(b.name, (byName.get(b.name) || []).concat(b));
  }

  const doomed: any[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => numId(b.id) - numId(a.id));
    console.log(`${name.replace(" · 生产安全监控综合管理平台", "")}：${list.length} 份，留 ${sorted[0].id}，删 ${sorted.slice(1).map((x) => x.id).join(" ")}`);
    doomed.push(...sorted.slice(1));
  }
  if (!doomed.length) {
    console.log("没有重名画板，不用清理");
  } else if (DRY) {
    console.log(`\n试运行：应删 ${doomed.length} 张`);
  } else {
    const r = await figma.call("delete_multiple_nodes", { nodeIds: doomed.map((d) => d.id) });
    console.log(`\n已删 ${doomed.length} 张：${typeof r === "string" ? r.slice(0, 80) : JSON.stringify(r).slice(0, 80)}`);
  }
} finally {
  figma.close();
}
process.exit(0);
