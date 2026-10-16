// 把没绑变量的矢量颜色补上。
// 场景：图表和图标里有一批 CSS 写死的颜色（不是 token），推送时按值反查不到变量，
// 于是这些描边/填充就是裸色值，换主题或改色都跟不上。
// 做法：按 color-names.json 给这些颜色建具名变量，再把画板和组件库里的对应画笔绑上去。
// 用法：bun bind-loose-colors.ts [--collection 设计变量] [--dry]
import { openFigma } from "./bridge.ts";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const CHANNEL = flag("channel", "powerplant");
const COLLECTION = flag("collection", "设计变量");
const DRY = argv.includes("--dry");

const names: Record<string, any> = await Bun.file("color-names.json").json().catch(() => null);
if (!names) {
  console.error("找不到 color-names.json");
  process.exit(1);
}
// 变量索引按集合分文件，跟 sync-tokens.ts 的产出名保持一致；用绝对路径，不依赖当前目录
const varFile = join(import.meta.dir, `figma-variables--${COLLECTION}.json`);
const tokens: Record<string, any> = await Bun.file(varFile).json().catch(() => {
  console.error(`找不到 ${varFile}，先在该项目上跑一次 sync-tokens.ts --collection ${COLLECTION}`);
  process.exit(1);
});
// 已经是 token 值的颜色交给 applyFills 在推送时自动绑，这里只管剩下的
const tokenHexes = new Set(
  Object.values(tokens)
    .map((v: any) => String(v && v.hex || "").toLowerCase())
    .filter((h) => h.startsWith("#"))
);

const hexToRgb = (hex: string) => {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
};

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "POLYGON", "STAR"]);

const figma = await openFigma(CHANNEL);
try {
  // 1. 建变量（同名已存在就复用，收集服务是幂等的）
  const wanted = Object.entries(names).filter(
    ([hex, v]) => !v.skip && v.name && !tokenHexes.has(hex.toLowerCase())
  );
  const idByHex = new Map<string, string>();
  if (wanted.length && !DRY) {
    const res: any = await figma.call("create_variable_collection", {
      collectionName: COLLECTION,
      modeNames: ["base"],
      variables: wanted.map(([hex, v]: any) => ({ name: v.name, type: "COLOR", valuesByMode: { base: hexToRgb(hex) } })),
    });
    for (const v of res.variables || []) idByHex.set(v.name, v.id);
    console.log(`建好 ${idByHex.size} 个补色变量到集合 ${COLLECTION}`);
  }
  const varIdByHex = new Map<string, string>();
  for (const [hex, v] of wanted) {
    const id = idByHex.get(v.name) || (tokens[`${COLLECTION}/${v.name}`] || {}).id || (DRY ? `dry:${v.name}` : "");
    if (id) varIdByHex.set(hex.toLowerCase(), id);
  }

  // 2. 扫画板与组件库，把裸色画笔绑上去
  const doc: any = await figma.call("get_document_info", {});
  const targets: any[] = [];
  for (const c of doc.children || []) {
    if (c.type === "SECTION") {
      const s: any = await figma.call("get_node_info", { nodeId: c.id });
      targets.push(...(s.children || []));
    } else if (c.type === "FRAME") targets.push(c);
  }

  const stats = new Map<string, number>();
  let bound = 0;
  let skippedInstance = 0;
  let translucent = 0;
  for (const board of targets) {
    const info: any = await figma.call("get_node_info", { nodeId: board.id });
    const jobs: any[] = [];
    (function walk(node: any, inInstance: boolean) {
      if (String(node.id || "").startsWith("I")) inInstance = true;
      if (VECTOR_TYPES.has(node.type)) {
        for (const kind of ["fills", "strokes"] as const) {
          const paints = node[kind] || [];
          for (let i = 0; i < paints.length; i++) {
            const p = paints[i];
            if (!p || p.type !== "SOLID" || !p.color) continue;
            if (p.boundVariables && p.boundVariables.color) continue;
            // 半透明画笔不能绑：绑上变量后 Figma 会按变量取值重算，
            // 原来挂在 paint.opacity 上的透明度会被丢掉（实测围栏填充 0.16 变成不透明）
            if (typeof p.opacity === "number" && p.opacity < 0.999) {
              translucent++;
              continue;
            }
            const hex = String(p.color).toLowerCase();
            if (tokenHexes.has(hex)) continue;
            const varId = varIdByHex.get(hex);
            if (!varId) continue;
            if (inInstance) {
              skippedInstance++;
              continue;
            }
            jobs.push({ id: node.id, kind, i, hex, varId });
          }
        }
      }
      for (const c of node.children || []) walk(c, inInstance);
    })(info, false);

    for (const j of jobs) {
      if (DRY) {
        bound++;
        stats.set(j.hex, (stats.get(j.hex) || 0) + 1);
        continue;
      }
      try {
        const tool = j.kind === "fills" ? "bind_fill_to_variable" : "bind_stroke_to_variable";
        await figma.call(tool, { nodeId: j.id, variableId: j.varId, paintIndex: j.i });
        bound++;
        stats.set(j.hex, (stats.get(j.hex) || 0) + 1);
      } catch (e) {
        console.log(`  绑 ${j.hex} 到 ${j.id} 失败：${(e as Error).message.slice(0, 70)}`);
      }
    }
  }

  console.log(`\n${DRY ? "试运行：" : ""}绑上 ${bound} 处画笔${translucent ? `，跳过半透明 ${translucent} 处` : ""}${skippedInstance ? `，跳过实例内部 ${skippedInstance} 处` : ""}`);
  for (const [hex, n] of stats) {
    console.log(`  ${hex} → ${names[hex].name}：${n} 处（${names[hex].note}）`);
  }
  const skipped = Object.entries(names).filter(([, v]) => v.skip).map(([hex]) => hex);
  if (skipped.length) console.log(`  按名单跳过：${skipped.join(" ")}`);
} finally {
  figma.close();
}
process.exit(0);
