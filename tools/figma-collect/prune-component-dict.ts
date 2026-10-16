// 按项目组件库清理跨页签名字典：只保留指定 libraryName 下实际存在的组件名。
// 用法：bun prune-component-dict.ts [--dir pages] [--library "组件库"] [--channel powerplant]
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const DIR = flag("dir", "pages");
const LIBRARY = flag("library", "组件库");
const CHANNEL = flag("channel", "powerplant");
const file = join(DIR, "components.json");
if (!existsSync(file)) throw new Error(`找不到组件字典：${file}`);

const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
const figma = await openFigma(CHANNEL);
try {
  const usage: any = await figma.call("component_usage", { allPages: true, onlyZero: false });
  const names = new Set((usage.rows || []).filter((r: any) => r.parent === LIBRARY).map((r: any) => String(r.name || "")));
  let removed = 0;
  for (const [sig, name] of Object.entries(dict)) {
    if (!names.has(name)) {
      delete dict[sig];
      removed++;
    }
  }
  writeFileSync(file, JSON.stringify(dict, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ library: LIBRARY, liveComponents: names.size, after: Object.keys(dict).length, removed }, null, 2));
} finally {
  figma.close();
}
