// 精简 MCP 工具清单：从 server.ts 里删掉指定工具的 server.tool(...) 注册块。
// 只删注册块，不动插件实现——删实现没有收益，AI 侧反而少不了能力。
// 用法：bun prune-tools.ts remove 名字1 名字2 ...
//       bun prune-tools.ts list                 （列出当前注册的工具与行号）
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

const FILE = fileURLToPath(new URL("../cursor-talk-to-figma-mcp/src/talk_to_figma_mcp/server.ts", import.meta.url));
const argv = process.argv.slice(2);
const action = argv[0] || "list";

const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");

// 找到每个 server.tool( 块的起止：括号配平回到 0 且紧跟分号的那一行
function blocks() {
  const out: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^server\.tool\(/.test(lines[i])) continue;
    let depth = 0;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth === 0 && j > i) {
        end = j;
        break;
      }
    }
    // 工具名在紧随其后的第一个引号里
    let name = "";
    for (let k = i; k <= Math.min(end + 2, lines.length - 1); k++) {
      const m = lines[k].match(/"([a-z_]+)"/);
      if (m) {
        name = m[1];
        break;
      }
    }
    out.push({ name, start: i, end });
  }
  return out;
}

const found = blocks();

if (action === "list") {
  for (const b of found) console.log(`${String(b.start + 1).padStart(5)}-${String(b.end + 1).padEnd(5)} ${b.name}`);
  console.log(`\n共 ${found.length} 个工具，文件 ${lines.length} 行`);
  process.exit(0);
}

const remove = new Set(argv.slice(1).filter((a) => !a.startsWith("--")));
if (!remove.size) {
  console.error("用法：bun prune-tools.ts remove 工具名 ...");
  process.exit(1);
}

const known = new Set(found.map((b) => b.name));
const missing = [...remove].filter((r) => !known.has(r));
if (missing.length) {
  console.error(`这些名字不在注册清单里，先别动：${missing.join(", ")}`);
  process.exit(1);
}

// 从后往前删，避免行号错位
const doomed = found.filter((b) => remove.has(b.name)).sort((a, b) => b.start - a.start);
for (const b of doomed) {
  let end = b.end;
  // 连块后面的空行一起收掉，别留一堆空行
  while (end + 1 < lines.length && lines[end + 1].trim() === "") end++;
  lines.splice(b.start, end - b.start + 1);
  console.log(`已删 ${b.name}（原 ${b.start + 1}-${end + 1} 行）`);
}

writeFileSync(FILE, lines.join("\n"));
console.log(`\n剩 ${found.length - doomed.length} 个工具注册，文件 ${lines.length} 行。`);
console.log("注意：server.ts 改动不需要重跑 Figma 插件，但 Qoder 要重启才会刷新工具清单。");
