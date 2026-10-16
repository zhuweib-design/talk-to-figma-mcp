// 一次性登记脚本：把"Figma 抽取收集服务"加进工具集合总控台的注册表。
// 先备份，再插入到 figma-bridge 条目后面，最后原子改名写回。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "fs";
import { dirname, join } from "path";

const HUB = "G:/AI-data/harness/工具入口/tools.json";
const BAK_DIR = "C:/Users/<你的用户名>/DesignTools/mcp-install-backups/2026-10-15";
const BAK = join(BAK_DIR, "tools.json.bak");

const raw = readFileSync(HUB, "utf8");
const j = JSON.parse(raw);
if (!Array.isArray(j.tools)) throw new Error("注册表里没有 tools 数组，形状不对，不动它");

if (j.tools.some((t) => t.id === "figma-collect")) {
  console.log("已存在 figma-collect 条目，不重复插入");
  process.exit(0);
}

mkdirSync(BAK_DIR, { recursive: true });
copyFileSync(HUB, BAK);
console.log("已备份到", BAK, "原文件", raw.length, "字符");

const entry = {
  id: "figma-collect",
  name: "Figma 抽取收集服务",
  description:
    "HTML 原型转 Figma 画板的中间一环：给浏览器提供 extractor.js 与 batch-extract.js，并把抽到的页面树按页面名落成 pages-gas/<页面名>.json。推图之前先起它，再起原型静态站。",
  kind: "web",
  dir: "C:\\Users\\<你的用户名>\\DesignTools\\figma-mcp",
  launch: [
    "C:\\Users\\<你的用户名>\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
    "collect-server.ts",
    "--port",
    "{port}",
    "--pages-dir",
    "pages-gas",
  ],
  url: "http://127.0.0.1:{port}/",
  port: 8768,
  tags: ["Figma", "原型转稿", "抽取"],
  category: "pipeline",
};

const at = j.tools.findIndex((t) => t.id === "figma-bridge");
if (at >= 0) j.tools.splice(at + 1, 0, entry);
else j.tools.push(entry);

const text = JSON.stringify(j, null, 2) + "\n";
const tmp = HUB + ".tmp";
writeFileSync(tmp, text);
renameSync(tmp, HUB);
console.log("已插入 figma-collect，位置", at >= 0 ? at + 1 : "末尾", "| 条目总数", j.tools.length, "| 新文件", text.length, "字符");
