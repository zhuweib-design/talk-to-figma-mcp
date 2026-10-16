// 在 Figma 里按名字查节点的实际属性，结果只打印命中的那几个，避免把整棵子树读进上下文。
// 用法：bun find-node.ts <画板ID> <名字正则> [字段，如 effects|fills|strokes|all]
import { openFigma } from "./bridge.ts";

const [rootId, pattern, field = "all"] = process.argv.slice(2);
if (!rootId || !pattern) {
  console.error("用法：bun find-node.ts <画板ID> <名字正则> [effects|fills|strokes|all]");
  process.exit(1);
}

const re = new RegExp(pattern);
const figma = await openFigma("powerplant");
try {
  const info: any = await figma.call("get_node_info", { nodeId: rootId });
  const hits: any[] = [];
  (function walk(node: any, chain: string[]) {
    if (node && re.test(String(node.name || ""))) {
      const picked: any = { name: node.name, type: node.type, id: node.id };
      if (field === "all" || field === "effects") picked.effects = node.effects;
      if (field === "all" || field === "fills") picked.fills = node.fills;
      if (field === "all" || field === "strokes") picked.strokes = node.strokes;
      if (field === "all") picked.box = node.absoluteBoundingBox;
      hits.push(picked);
    }
    for (const c of node?.children || []) walk(c, chain.concat(node.name));
  })(info, []);

  console.log(`命中 ${hits.length} 个节点`);
  for (const h of hits.slice(0, Number(process.env.LIMIT || 3))) {
    console.log(JSON.stringify(h, null, 1));
  }
  if (!hits.length) console.log("没找到，检查画板 ID 或名字正则");
} finally {
  figma.close();
}
process.exit(0);
