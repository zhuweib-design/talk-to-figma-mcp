// 批量抽取器：在浏览器里跑一次，把整套原型逐页抽成 Figma 图层树。
// 用法（在 127.0.0.1:8765 的任意页面上）：
//   先注入本文件，再执行 __FIGMA_BATCH(["index","admin"], {width:1920, height:1080})
// 每页结果由收集服务落成 pages/<页面名>.json，不会被下一页覆盖。
(function () {
  // 多项目并行时给每个项目一个收集服务端口，落盘目录互不覆盖
  // 服务地址统一用 __FIGMA_ENDPOINT（与 extractor.js 同名）；__FIGMA_COLLECT 是旧名，留着不让老手册断。
  const COLLECT = window.__FIGMA_ENDPOINT || window.__FIGMA_COLLECT || "http://127.0.0.1:8766/";

  async function extractorCode() {
    const r = await fetch(`${COLLECT}extractor.js?r=${Date.now()}`);
    return r.text();
  }

  function makeFrame(width, height) {
    const f = document.createElement("iframe");
    // 抽屉尺寸就是设计尺寸：真实窗口因为屏幕缩放可能到不了 1080 高，
    // 内嵌框架是按 CSS 像素算的，可以直接给到 1920x1080。
    f.setAttribute("style", `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;border:0;`);
    return f;
  }

  async function onePage(code, name, opts) {
    const f = makeFrame(opts.width, opts.height);
    // 有的项目页面不在站点根目录（例如 pages/xxx.html），用 dir 传子目录。
    // 先把斜杠剥干净再拼：dir 给 "/" 时若多留一个斜杠就成了 //index.html，
    // 浏览器按协议相对地址解析成 http://index.html，直接跨源失败（实测撞过）。
    const sub = String(opts.dir || "").replace(/^\/+|\/+$/g, "");
    f.src = `/${sub ? sub + "/" : ""}${name}.html`;
    document.body.appendChild(f);

    const loaded = await new Promise((res) => {
      const timer = setTimeout(() => res("loadtimeout"), opts.loadTimeout || 20000);
      f.onload = () => {
        clearTimeout(timer);
        res("ok");
      };
    });
    if (loaded === "loadtimeout") {
      f.remove();
      return `${name}: 页面没加载完`;
    }

    const w = f.contentWindow;
    // 换主题：直接改 html 上的 data-theme，抽出来的就是另一套配色，
    // 变量按颜色值反查会自动绑到那套集合上
    if (opts.theme) w.document.documentElement.setAttribute("data-theme", opts.theme);
    w.__FIGMA_MAX_NODES = opts.maxNodes;
    w.__FIGMA_TARGET = { width: opts.width, height: opts.height };
    w.__FIGMA_EXPAND_SCROLL = !!opts.expandScroll;
    w.__FIGMA_BOLD_600 = !!opts.bold600;
    w.__FIGMA_BLOCK_AUTO = !!opts.blockAuto;
    w.__FIGMA_COMPONENTS = !!opts.components;
    w.__FIGMA_STROKE_MIN = opts.strokeMin || 0;
    w.__FIGMA_COMPONENT_MIN = opts.componentMin || 3;
    w.__FIGMA_COMPONENT_MAX = opts.componentMax || 12;
    if (opts.components) {
      // 每页都重新取一次字典，前一页新建的组件名这一页就能复用
      w.__FIGMA_COMPONENT_NAMES = await fetch(`${COLLECT}components.json?r=${Date.now()}`)
        .then((r) => r.json())
        .catch(() => ({}));
    }
    w.__FIGMA_ENDPOINT = COLLECT;
    // 落盘目录跟着项目单走（opts.outDir），与 opts.dir 是两回事：
    // dir 是「这个页面在站点里的子目录」，outDir 是「结果写到收集服务的哪个目录」。
    w.__FIGMA_OUT_DIR = opts.outDir || "";
    w.__FIGMA_DONE = false;
    w.__FIGMA_ERROR = null;

    try {
      w.eval(code);
    } catch (e) {
      f.remove();
      return `${name}: 抽取脚本报错 ${e && e.message}`;
    }

    const status = await new Promise((res) => {
      let tick = 0;
      const timer = setInterval(() => {
        tick++;
        if (w.__FIGMA_DONE) {
          clearInterval(timer);
          res("已抽取");
        } else if (w.__FIGMA_ERROR) {
          clearInterval(timer);
          res(`回传失败 ${w.__FIGMA_ERROR}`);
        } else if (tick > (opts.timeoutMs || 60000) / 100) {
          clearInterval(timer);
          res("超时");
        }
      }, 100);
    });

    const h = w.document.documentElement.scrollHeight;
    f.remove();
    return `${name}: ${status}${h > opts.height ? `（展开后高 ${h}）` : ""}`;
  }

  window.__FIGMA_BATCH = async function (pages, options) {
    const opts = Object.assign(
      { width: 1920, height: 1080, maxNodes: 4000, expandScroll: false, bold600: false },
      options || {}
    );
    const code = await extractorCode();
    const out = [];
    for (const name of pages) {
      out.push(await onePage(code, name, opts));
    }
    return out.join(" | ");
  };

  return "已就绪";
})();
