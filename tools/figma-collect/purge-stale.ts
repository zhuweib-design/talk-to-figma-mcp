// 清理重推后留下的旧画板。
// 背景：插件的"同名替换"只扫父节点的直接子节点，画板被 Section 收进去之后就扫不到了，
// 于是重推会在页面层新建一份，旧的那份还留在分组里，画布出现两套。
// 组件定义原本长在旧画板里，直接删旧画板会让新画板里的实例断链，
// 所以先把组件搬进一个独立的"组件库"画框，再删旧画板和空分组。
// 用法：bun purge-stale.ts [--channel powerplant] [--keep 要保留的画板名关键字 ...]
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const idx = argv.indexOf("--channel");
const CHANNEL = idx >= 0 ? argv[idx + 1] : "powerplant";
const keepAt = argv.indexOf("--keep");
const KEEPS = keepAt >= 0 ? argv.slice(keepAt + 1).filter((a) => !a.startsWith("--")) : [];

const figma = await openFigma(CHANNEL);
try {
  const doc: any = await figma.call("get_document_info", {});
  const pageId = doc.id;
  const topFrames: any[] = (doc.children || []).filter((c: any) => c.type === "FRAME");
  const sections: any[] = (doc.children || []).filter((c: any) => c.type === "SECTION");

  // 页面层新推的这批名字，就是"当前版本"
  const fresh = new Set(topFrames.map((f) => f.name));
  const stale: any[] = [];
  for (const s of sections) {
    const info: any = await figma.call("get_node_info", { nodeId: s.id });
    for (const child of info.children || []) {
      if (fresh.has(child.name) && !KEEPS.some((k) => (child.name || "").includes(k))) stale.push(child);
    }
  }
  console.log(`页面层 ${topFrames.length} 张，分组内 ${stale.length} 张是旧版`);

  // 1. 把组件搬进独立库画框，避免跟着旧画板一起被删
  const comps: any = await figma.call("get_local_components", {});
  const list = Array.isArray(comps) ? comps : comps.components || [];
  if (list.length) {
    const lib: any = await figma.call("create_layer_tree", {
      tree: { type: "frame", name: "组件库 · 电厂原型", x: 0, y: 0, width: 40, height: 40, fills: [{ color: { r: 0.04, g: 0.06, b: 0.1, a: 1 } }] },
      autoPlace: false,
    });
    const libId = typeof lib === "string" ? (lib.match(/ID:\s*([\d:]+)/) || [])[1] : lib.id;
    const col = 6;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      await figma.call("set_parent", {
        nodeId: c.id || c.nodeId,
        parentId: libId,
        x: 40 + (i % col) * 420,
        y: 40 + Math.floor(i / col) * 260,
      });
    }
    console.log(`已把 ${list.length} 个组件搬进库画框 ${libId}`);
  }

  // 2. 删旧画板
  const ids = stale.map((s) => s.id).filter(Boolean);
  if (ids.length) {
    const r = await figma.call("delete_multiple_nodes", { nodeIds: ids });
    console.log(`删除旧画板 ${ids.length} 张：${typeof r === "string" ? r.slice(0, 80) : JSON.stringify(r).slice(0, 80)}`);
  }

  // 3. 删空分组，稍后由 group-artboards.ts 重建
  for (const s of sections) {
    const info: any = await figma.call("get_node_info", { nodeId: s.id });
    if (!(info.children || []).length) {
      await figma.call("delete_node", { nodeId: s.id });
      console.log(`删掉空分组 ${s.name}`);
    } else {
      console.log(`分组 ${s.name} 里还剩 ${info.children.length} 个，先不删`);
    }
  }
} finally {
  figma.close();
}
process.exit(0);
