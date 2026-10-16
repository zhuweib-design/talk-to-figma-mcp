// 本地收集服务：向浏览器提供抽取脚本，并把抽取结果落盘。
// 用法：bun collect-server.ts [--port 8768] [--pages-dir pages] [--out 单页文件] [单页输出文件]
// 带 source 字段的请求（浏览器抽到的页面名）会另外写一份 pages/<source>.json，
// 这样批量抽取时一个页面的结果不会被下一个页面覆盖。
// 端口与落盘目录都能从命令行给，是因为工具集合总控台启动条目时不能设环境变量，
// 而环境变量这一路要留着：老手册里写的 COLLECT_PORT / PAGES_DIR 用法不能断。
import { join } from "path";
import { mkdir } from "fs/promises";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// 位置参数只取没被选项吃掉的那几个
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const PORT = Number(flag("port") || process.env.COLLECT_PORT || 8766);
const OUT = flag("out") || process.env.OUT_FILE || positional[0] || "page-tree.json";
// 同时跑多个项目时给每个项目一个独立目录，避免 pages/atoms.json 互相覆盖
const DIR = join(import.meta.dir, flag("pages-dir") || process.env.PAGES_DIR || "pages");
const EXTRACTOR = join(import.meta.dir, "extractor.js");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/extractor.js") {
      return new Response(Bun.file(EXTRACTOR), {
        headers: { ...CORS, "content-type": "application/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/batch-extract.js") {
      return new Response(Bun.file(join(import.meta.dir, "batch-extract.js")), {
        headers: { ...CORS, "content-type": "application/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/components.json") {
      const dict = await Bun.file(join(DIR, "components.json")).text().catch(() => "{}");
      return new Response(dict, {
        headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
      });
    }

    if (req.method === "POST") {
      const text = await req.text();
      await Bun.write(OUT, text);
      let saved = OUT;
      try {
        const parsed = JSON.parse(text);
        // 页面名来自浏览器地址，只留安全字符，避免路径穿越
        const source = String(parsed.source || "").replace(/[^0-9A-Za-z._-]/g, "");
        if (source) {
          await mkdir(DIR, { recursive: true });
          saved = join(DIR, `${source}.json`);
          await Bun.write(saved, text);
        }
        // 结构签名到组件名的字典要跨页面累积，同名不同结构才不会拿错组件
        if (parsed.sigNames && Object.keys(parsed.sigNames).length) {
          const dictFile = join(DIR, "components.json");
          const dict = JSON.parse((await Bun.file(dictFile).text().catch(() => "{}")) as string);
          Object.assign(dict, parsed.sigNames);
          await Bun.write(dictFile, JSON.stringify(dict, null, 2));
          saved += ` + 组件字典 ${Object.keys(parsed.sigNames).length} 条`;
        }
      } catch {
        /* 解析失败就只留单页文件 */
      }
      console.log(`已接收页面树 ${text.length} 字符，写入 ${saved}`);
      return new Response("ok", { headers: CORS });
    }

    return new Response("collect server 正在运行", { headers: CORS });
  },
});

console.log(
  `收集服务已启动: http://127.0.0.1:${PORT}  单页输出: ${OUT}  分页目录: ${DIR}`
);
console.log("提示：浏览器里要把 __FIGMA_ENDPOINT 设成这个地址，换项目时 --pages-dir 要和 build-page 的 --dir 对得上");
