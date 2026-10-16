// 画板分组：把顶层画板按配置归进 Section，并重新排成整齐的网格。
// 用法：bun group-artboards.ts [--channel powerplant] [--config 配置文件] [--cell 1920x1080]
// 配置文件是数组：[{ "name": "01 后台页", "match": ["报警信息","人员信息"], "perRow": 4 }]
// 不给配置文件就用电厂原型的默认分组。可反复跑：同名 Section 会复用，只重排位置。
import { openFigma } from "./bridge.ts";
import { readdirSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const CHANNEL = flag("channel", "powerplant");
const CONFIG = flag("config", "");
const CELL = (() => {
  const m = flag("cell", "1920x1080").match(/^(\d+)x(\d+)$/);
  return m ? { w: +m[1], h: +m[2] } : { w: 1920, h: 1080 };
})();
const GAP_X = 120;
const GAP_Y = 200;
const PAD = 80;
const BAND_GAP = 160;

const DEFAULT_GROUPS = [
  {
    name: "01 后台页",
    perRow: 4,
    match: ["原型索引 · 生产安全", "报警信息", "人员信息", "设备信息", "组织架构", "角色权限", "设备实时监控", "配电间实时监控", "配电间出入记录", "后台通用页"],
  },
  { name: "02 领导驾驶舱", perRow: 3, match: ["领导驾驶舱 · 生产安全", "dashboard-2", "dashboard-3"] },
  { name: "03 组件与主题规范", perRow: 3, match: ["原子组件", "浅色主题样例"] },
];

const groups: any[] = CONFIG
  ? await Bun.file(CONFIG)
      .json()
      .catch(() => {
        console.error(`读不到配置文件 ${CONFIG}`);
        process.exit(1);
      })
  : DEFAULT_GROUPS;

// 画板尺寸优先按本地抽到的页面树算，取不到就按 --cell。多项目并存时用 --dir 指到该项目的落盘目录
const PAGES_DIR = flag("dir", "pages");
const sizeByName = new Map<string, { w: number; h: number }>();
try {
  for (const f of readdirSync(join(import.meta.dir, PAGES_DIR)).filter((x) => x.endsWith(".json") && x !== "components.json")) {
    const p = await Bun.file(join(import.meta.dir, PAGES_DIR, f)).json();
    if (p.tree && p.tree.name) sizeByName.set(p.tree.name, { w: p.tree.width, h: p.tree.height });
  }
} catch {
  /* 没有该目录就全按默认格子 */
}

const figma = await openFigma(CHANNEL);
try {
  const doc0: any = await figma.call("get_document_info", {});
  const pageId = doc0.id;

  // 先把已有分组拆掉（里面的画板搬回页面层），再重新取一次顶层清单，
  // 否则原来在分组里的画板这一轮会被漏掉
  for (const s of (doc0.children || []).filter((c: any) => c.type === "SECTION")) {
    const inside: any = await figma.call("get_node_info", { nodeId: s.id });
    for (const child of inside.children || []) {
      await figma.call("set_parent", {
        nodeId: child.id,
        parentId: pageId,
        x: child.absoluteBoundingBox?.x ?? 0,
        y: child.absoluteBoundingBox?.y ?? 0,
      });
    }
    await figma.call("delete_node", { nodeId: s.id });
  }

  const doc: any = await figma.call("get_document_info", {});
  const pool: any[] = (doc.children || []).filter((c: any) => c.type === "FRAME");
  const sections: any[] = (doc.children || []).filter((c: any) => c.type === "SECTION");

  const plan = groups.map((g) => {
    const picked: any[] = [];
    for (const key of g.match || []) {
      for (const f of [...pool]) {
        if (f.name.includes(key) && !picked.includes(f)) {
          picked.push(f);
          pool.splice(pool.indexOf(f), 1);
        }
      }
    }
    return { group: g, frames: picked };
  });

  let top = 0;
  let moved = 0;
  for (const { group, frames } of plan) {
    if (!frames.length) {
      console.log(`跳过空分组 ${group.name}`);
      continue;
    }
    const perRow = Math.max(1, Number(group.perRow) || 4);
    const rows = Math.ceil(frames.length / perRow);
    const cellW = Math.max(CELL.w, ...frames.map((f) => (sizeByName.get(f.name) || CELL).w));
    const cellH = Math.max(CELL.h, ...frames.map((f) => (sizeByName.get(f.name) || CELL).h));
    const bandW = perRow * cellW + (perRow - 1) * GAP_X;
    const bandH = rows * cellH + (rows - 1) * GAP_Y;

    let section = sections.find((s) => s.name === group.name);
    if (section) {
      // 旧 Section 先拆掉：把里面的画板搬回页面层再删，重跑时尺寸才能按新排布重算
      const inside: any = await figma.call("get_node_info", { nodeId: section.id });
      for (const child of inside.children || []) {
        // REST 读回的是绝对坐标，页面层用的就是它，直接搬回去即可
        await figma.call("set_parent", {
          nodeId: child.id,
          parentId: doc.id,
          x: child.absoluteBoundingBox?.x ?? 0,
          y: child.absoluteBoundingBox?.y ?? 0,
        });
      }
      await figma.call("delete_node", { nodeId: section.id });
      section = null;
    }
    if (!section) {
      const created: any = await figma.call("create_section", {
        x: 0,
        y: top,
        width: bandW + PAD * 2,
        height: bandH + PAD * 2 + 60,
        name: group.name,
      });
      // 这条命令回的是人话不是 JSON：Created section "名字" with ID: 32:123
      const text = typeof created === "string" ? created : JSON.stringify(created);
      const id = (text.match(/ID:\s*([\d:]+)/) || [])[1];
      if (!id) throw new Error(`建不出分组容器：${text.slice(0, 120)}`);
      section = { id, x: 0, y: top };
    }
    const sx = section.x ?? 0;
    const sy = section.y ?? top;

    for (let i = 0; i < frames.length; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const px = sx + PAD + col * (cellW + GAP_X);
      const py = sy + PAD + 60 + row * (cellH + GAP_Y);
      await figma.call("set_parent", { nodeId: frames[i].id, parentId: section.id, x: px - sx, y: py - sy });
      moved++;
    }
    console.log(`${group.name}：${frames.length} 张画板，${rows} 行 × ${perRow} 列，Section ${section.id}`);
    top += bandH + PAD * 2 + 60 + BAND_GAP;
  }

  console.log(`\n共归组 ${moved} 张；未匹配留在页面层：${pool.map((p) => p.name).join(" / ") || "（无）"}`);
} finally {
  figma.close();
}
process.exit(0);
