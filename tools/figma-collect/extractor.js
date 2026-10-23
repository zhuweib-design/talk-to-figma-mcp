// 页面抽取器：在浏览器里运行，把渲染后的 DOM 转成 Figma 图层树。
// 由 collect-server 注入并接收结果，不经过 AI 上下文。
(function () {
  const ENDPOINT = window.__FIGMA_ENDPOINT || "http://127.0.0.1:8766/";
  const MAX_NODES = Number(window.__FIGMA_MAX_NODES || 1500);

  const warnings = [];
  let counted = 0;
  const skipped = { hidden: 0, empty: 0, budget: 0, svg: 0 };
  let icons = 0;
  let pseudos = 0;
  let blockAutoCount = 0;

  const round = (n) => Math.round(n * 100) / 100;
  // 颜色必须留四位小数，两位会把 47/255 压成 0.18，乘回去偏成 45，还会导致变量绑不上
  const round4 = (n) => Math.round(n * 10000) / 10000;

  function toColor(value) {
    if (!value) return null;
    const v = String(value).trim();
    const hex = v.match(/^#([0-9a-fA-F]{3,8})$/);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      return {
        r: round4(parseInt(h.slice(0, 2), 16) / 255),
        g: round4(parseInt(h.slice(2, 4), 16) / 255),
        b: round4(parseInt(h.slice(4, 6), 16) / 255),
        a: h.length >= 8 ? round4(parseInt(h.slice(6, 8), 16) / 255) : 1,
      };
    }
    const rgb = v.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
      const p = rgb[1].split(/[,/\s]+/).filter(Boolean);
      return {
        r: round4(parseFloat(p[0]) / 255),
        g: round4(parseFloat(p[1] || 0) / 255),
        b: round4(parseFloat(p[2] || 0) / 255),
        a: p.length > 3 ? round4(parseFloat(p[3])) : 1,
      };
    }
    return null;
  }

  function withOpacity(color, opacity) {
    if (!color) return null;
    const a = color.a === undefined ? 1 : color.a;
    return { ...color, a: round4(a * (opacity === undefined ? 1 : opacity)) };
  }

  function parsePx(v) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }

  // filter: blur(6px) 在 Figma 里对应"图层模糊"，半径按同数值给，视觉上够用；
  // 亮度、灰度这类滤镜 Figma 没有等价物，只能忽略。
  function blurEffectOf(filterValue) {
    if (!filterValue || filterValue === "none") return [];
    const m = filterValue.match(/blur\(\s*(-?[\d.]+)px/);
    if (!m) return [];
    const r = parseFloat(m[1]);
    if (!r || Number.isNaN(r)) return [];
    return [{ type: "LAYER_BLUR", radius: round(r), visible: true }];
  }

  function toEffects(value) {
    if (!value || value === "none") return [];
    const parts = [];
    let buf = "";
    let paren = 0;
    for (const ch of value) {
      if (ch === "(") paren++;
      if (ch === ")") paren--;
      if (ch === "," && paren === 0) { parts.push(buf); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);

    const out = [];
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      const inset = /(^|\s)inset(\s|$)/.test(t);
      const body = t.replace(/\binset\b/g, "").trim();
      const colorMatch = body.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8})/);
      const color = (colorMatch && toColor(colorMatch[1])) || { r: 0, g: 0, b: 0, a: 0.25 };
      const nums = body
        .replace(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8})/g, "")
        .trim()
        .split(/\s+/)
        .map(parseFloat)
        .filter((n) => !Number.isNaN(n));
      if (!nums.length) continue;
      out.push({
        type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
        color,
        offset: { x: nums[0] || 0, y: nums[1] || 0 },
        radius: nums[2] || 0,
        spread: nums[3] || 0,
        visible: true,
        blendMode: "NORMAL",
      });
    }
    return out;
  }

  // 设了 __FIGMA_BOLD_600 时，所有 600 字重都走 Bold；默认只让 b 和 strong 变 Bold
  const BOLD_600 = !!window.__FIGMA_BOLD_600;

  function styleNameOf(weight, tag) {
    if (tag === "B" || tag === "STRONG") return "Bold";
    const w = parseFloat(weight) || 400;
    if (w >= 700) return "Bold";
    if (w >= 600) return BOLD_600 ? "Bold" : "Medium";
    if (w >= 500) return "Medium";
    if (w <= 300) return "Light";
    return "Regular";
  }

  function familyOf(fontFamily) {
    const first = String(fontFamily || "").split(",")[0];
    return first.replace(/["']/g, "").trim() || "PingFang SC";
  }

  // 图标走 CSS mask，SVG 源码以 data URI 形式挂在 mask-image 上，可以直接还原成真矢量
  function iconSvgOf(cs) {
    const mask = cs.webkitMaskImage || cs.maskImage || "";
    if (mask.indexOf("data:image/svg+xml") < 0) return null;
    const m = mask.match(/url\("?(data:image\/svg\+xml,[^")]+)"?\)/);
    if (!m) return null;
    let raw = m[1].slice("data:image/svg+xml,".length);
    try { raw = decodeURIComponent(raw); } catch (e) { /* 已解码则原样使用 */ }
    return raw.indexOf("<svg") === 0 ? raw : null;
  }

  function rangeRect(textNode, start, end) {
    const r = document.createRange();
    // 默认整段选；去掉首尾空白时可以给一个区间
    if (start === undefined && end === undefined) r.selectNodeContents(textNode);
    else r.setStart(textNode, start || 0), r.setEnd(textNode, end === undefined ? textNode.length : end);
    return r.getBoundingClientRect();
  }

  // 一个文本节点折行时，Range 的整体盒是跨行的并集：按它画，第二段会把后面几行的内容压住
  // （封面那段描述整段重叠就是这个）。这里逐字量、按行的 top 分组，把一段拆成"每行一片"。
  function rangePieces(textNode, start, end) {
    const full = textNode.textContent;
    const probe = document.createRange();
    const pieces = [];
    let cur = null;
    for (let i = start; i < end; i++) {
      probe.setStart(textNode, i);
      probe.setEnd(textNode, i + 1);
      const b = probe.getBoundingClientRect();
      if (!b.width && !b.height) continue; // 折行处被折叠掉的空白，本来就不占位
      if (cur && Math.abs(b.top - cur.rect.top) <= 2) {
        const p = cur.rect;
        const left = Math.min(p.left, b.left);
        const right = Math.max(p.right, b.right);
        const top = Math.min(p.top, b.top);
        const bottom = Math.max(p.bottom, b.bottom);
        cur.rect = { left, top, right, bottom, width: right - left, height: bottom - top };
        cur.text += full[i];
      } else {
        if (cur) pieces.push(cur);
        cur = {
          text: full[i],
          rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
        };
      }
    }
    if (cur) pieces.push(cur);
    return pieces;
  }

  function textSpec(cs, rect, characters, opacity, tag) {
    return {
      characters,
      fontSize: parsePx(cs.fontSize) || 14,
      fontFamily: familyOf(cs.fontFamily),
      fontStyle: styleNameOf(cs.fontWeight, tag),
      lineHeight: cs.lineHeight && cs.lineHeight !== "normal"
        ? { value: round(parsePx(cs.lineHeight)), unit: "PIXELS" }
        : undefined,
      letterSpacing: cs.letterSpacing && cs.letterSpacing !== "normal" && parsePx(cs.letterSpacing) !== 0
        ? { value: round(parsePx(cs.letterSpacing)), unit: "PIXELS" }
        : undefined,
      textAlignHorizontal:
        cs.textAlign === "center" ? "CENTER" : cs.textAlign === "right" ? "RIGHT" : "LEFT",
      textAutoResize: "WIDTH_AND_HEIGHT",
      width: round(Math.max(1, rect.width)),
      color: withOpacity(toColor(cs.color), opacity),
    };
  }

  // ::before 和 ::after 承载了色条、图标、装饰线，必须一起抽出来
  // CSS 的绝对定位以父元素的内边距盒为基准，所以要从父元素的边框宽度起算，
  // 并且 right / bottom 是"元素右边到容器右边的距离"，写成负值表示往外面探出去。
  function pseudoOffset(el, cs, parentRect, w, h) {
    const p = getComputedStyle(el);
    const bl = parsePx(p.borderLeftWidth), bt = parsePx(p.borderTopWidth);
    const br = parsePx(p.borderRightWidth), bb = parsePx(p.borderBottomWidth);
    const boxW = parentRect.width - bl - br;
    const boxH = parentRect.height - bt - bb;
    const isAuto = (v) => !v || v === "auto";

    let x = bl + parsePx(p.paddingLeft);
    if (!isAuto(cs.left)) x = bl + parsePx(cs.left);
    else if (!isAuto(cs.right)) x = bl + boxW - parsePx(cs.right) - w;

    let y = bt + parsePx(p.paddingTop);
    if (!isAuto(cs.top)) y = bt + parsePx(cs.top);
    else if (!isAuto(cs.bottom)) y = bt + boxH - parsePx(cs.bottom) - h;

    return { x: round(x), y: round(y), positioned: cs.position === "absolute" || cs.position === "fixed" };
  }

  // 只画两条相邻边框、再转 45 度的伪元素，就是下拉箭头与勾选点这类折角符号。
  // 画成矩形会变成四条边的方框，所以按折线出一张矢量。
  function chevronOf(cs, w, h) {
    const r = parsePx(cs.borderRightWidth), l = parsePx(cs.borderLeftWidth);
    const t = parsePx(cs.borderTopWidth), b = parsePx(cs.borderBottomWidth);
    const cases = [
      { on: r > 0 && b > 0 && t === 0 && l === 0, color: cs.borderRightColor, thick: Math.max(r, b), path: `M ${w} 0 L ${w} ${h} L 0 ${h}` },
      { on: l > 0 && b > 0 && t === 0 && r === 0, color: cs.borderLeftColor, thick: Math.max(l, b), path: `M 0 0 L 0 ${h} L ${w} ${h}` },
      { on: t > 0 && r > 0 && b === 0 && l === 0, color: cs.borderTopColor, thick: Math.max(t, r), path: `M 0 ${h} L 0 0 L ${w} 0` },
      { on: t > 0 && l > 0 && b === 0 && r === 0, color: cs.borderTopColor, thick: Math.max(t, l), path: `M 0 0 L ${w} 0 L ${w} ${h}` },
    ];
    return cases.find((c) => c.on) || null;
  }

  function rotateDegOf(transform) {
    const m = /matrix\(([^)]+)\)/.exec(String(transform || ""));
    if (!m) return 0;
    const parts = m[1].split(",").map((s) => Number(s.trim()));
    if (parts.some(Number.isNaN)) return 0;
    return Math.round((Math.atan2(parts[1], parts[0]) * 180) / Math.PI);
  }

  const CHEVRON_PAD = 3;

  function chevronSvg(cw, w, h, deg, opacity) {
    // 转完之后折角会探出原来的 6x6 盒子，四周各留 3px 画布，节点位置同步往回挪
    const W = round(w + CHEVRON_PAD * 2), H = round(h + CHEVRON_PAD * 2);
    const col = toColor(cw.color) || { r: 0, g: 0, b: 0, a: 1 };
    const hex = "#" + [col.r, col.g, col.b]
      .map((v) => ("0" + Math.round(v * 255).toString(16)).slice(-2)).join("");
    const rot = deg ? ` transform="rotate(${deg} ${round(w / 2)} ${round(h / 2)})"` : "";
    const alpha = round4((col.a === undefined ? 1 : col.a) * (opacity === undefined ? 1 : opacity));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<g transform="translate(${CHEVRON_PAD} ${CHEVRON_PAD})"><path d="${cw.path}" fill="none" ` +
      `stroke="${hex}" stroke-opacity="${alpha}" stroke-width="${round(cw.thick)}"${rot}/></g></svg>`;
  }

  function pseudoNode(el, pseudo, parentRect, opacity) {
    const cs = getComputedStyle(el, pseudo);
    const content = cs.content;
    if (!content || content === "none" || content === "normal") return null;

    const w = parsePx(cs.width);
    const h = parsePx(cs.height);
    const quoted = content.match(/^"(.*)"$/);
    const text = quoted ? quoted[1].trim() : null;

    if (text) {
      const rect = { width: w || text.length * parsePx(cs.fontSize), height: h || parsePx(cs.fontSize) * 1.5 };
      pseudos++;
      return {
        type: "text",
        name: text.slice(0, 24) || pseudo,
        x: 0, y: 0,
        width: round(rect.width), height: round(rect.height),
        fills: [{ color: withOpacity(toColor(cs.color), opacity) }],
        text: textSpec(cs, rect, text, opacity),
      };
    }

    const bg = toColor(cs.backgroundColor);
    const grad = gradientPaintOf(cs.backgroundImage, el, { width: w, height: h });
    if (!w || !h) return null;
    const cw = chevronOf(cs, w, h);
    if (cw) {
      const at = pseudoOffset(el, cs, parentRect, w, h);
      pseudos++;
      return {
        type: "svg",
        name: describe(el) + pseudo,
        x: round(at.x - CHEVRON_PAD), y: round(at.y - CHEVRON_PAD),
        width: round(w + CHEVRON_PAD * 2), height: round(h + CHEVRON_PAD * 2),
        svg: chevronSvg(cw, w, h, rotateDegOf(cs.transform), opacity),
        positionAbsolute: at.positioned,
      };
    }
    if ((!bg || bg.a === 0) && !grad) return null;

    const at = pseudoOffset(el, cs, parentRect, w, h);
    // 装饰圆片普遍写成 border-radius: 9999px，Figma 的圆角上限是短边一半
    const radius = Math.min(parsePx(cs.borderTopLeftRadius) || 0, Math.round(Math.min(w, h) / 2));
    pseudos++;
    return {
      type: "rectangle",
      name: describe(el) + pseudo,
      x: at.x, y: at.y,
      width: round(w), height: round(h),
      fills: grad
        ? [{ ...grad, grad: { ...grad.grad, stops: grad.grad.stops.map((s) => ({ ...s, color: withOpacity(s.color, opacity) })) } }]
        : bg && bg.a > 0 ? [{ color: withOpacity(bg, opacity) }] : [],
      cornerRadius: radius || undefined,
      effects: blurEffectOf(cs.filter),
      positionAbsolute: at.positioned,
    };
  }

  function layoutOf(cs, el) {
    const display = cs.display;
    const pad = {
      top: parsePx(cs.paddingTop),
      right: parsePx(cs.paddingRight),
      bottom: parsePx(cs.paddingBottom),
      left: parsePx(cs.paddingLeft),
    };
    const primaryMap = {
      "flex-start": "MIN", start: "MIN", left: "MIN",
      "flex-end": "MAX", end: "MAX", right: "MAX",
      center: "CENTER",
      "space-between": "SPACE_BETWEEN", "space-around": "SPACE_BETWEEN", "space-evenly": "SPACE_BETWEEN",
    };
    const counterMap = {
      "flex-start": "MIN", start: "MIN",
      "flex-end": "MAX", end: "MAX",
      center: "CENTER", baseline: "BASELINE", stretch: "MIN",
    };
    // grid 的居中常写成 place-items，它改的是 justify-items 而不是 justify-content
    const pick = (a, b) => (a && a !== "normal" && a !== "stretch" ? a : b);

    // Chrome 会把 grid 轨道算成实际像素列表，"none" 表示没显式定义轨道
    const trackCount = (v) => {
      const t = String(v || "").trim();
      if (!t || t === "none") return 1;
      return t.split(/\s+/).filter(Boolean).length;
    };

    if (display === "flex" || display === "inline-flex") {
      const vertical = /^column/.test(cs.flexDirection);
      return {
        mode: vertical ? "VERTICAL" : "HORIZONTAL",
        // flex-wrap 不抄过去，换行的标签组会被挤成一行顶出容器
        layoutWrap: /^wrap/.test(cs.flexWrap) ? "WRAP" : "NO_WRAP",
        padding: pad,
        itemSpacing: parsePx(cs.rowGap) || parsePx(cs.columnGap) || 0,
        counterAxisSpacing: vertical ? parsePx(cs.columnGap) : parsePx(cs.rowGap),
        primaryAxisAlignItems: primaryMap[cs.justifyContent] || "MIN",
        counterAxisAlignItems: counterMap[cs.alignItems] || "MIN",
        // 主轴按实测尺寸固定，否则 Figma 会收成 hug，space-between 失效
        fixPrimary: true,
      };
    }
    if (display === "grid" || display === "inline-grid") {
      const cols = trackCount(cs.gridTemplateColumns);
      const rowGap = parsePx(cs.rowGap) || parsePx(cs.gap) || 0;
      const colGap = parsePx(cs.columnGap) || parsePx(cs.gap) || 0;
      // 单列网格（包括没写 grid-template-columns 的默认情形）子项是竖着堆的，
      // 轴向和 flex column 相同，连对齐属性也要跟着换一条边
      const vertical = cols <= 1;
      const main = vertical ? pick(cs.alignContent, cs.alignItems) : pick(cs.justifyContent, cs.justifyItems);
      const cross = vertical ? pick(cs.justifyContent, cs.justifyItems) : pick(cs.alignContent, cs.alignItems);
      // 换行只在子项真的多于列数时才给：两列两项的骨架（左导航 + 右工作区）
      // 一旦 WRAP，宽度稍有舍入就会被挤到第二行
      const items = el && el.children ? Array.prototype.filter.call(el.children, (k) => getComputedStyle(k).display !== "none").length : 0;
      return {
        mode: vertical ? "VERTICAL" : "HORIZONTAL",
        layoutWrap: !vertical && cols > 1 && items > cols ? "WRAP" : "NO_WRAP",
        padding: pad,
        itemSpacing: vertical ? rowGap : colGap,
        counterAxisSpacing: vertical ? colGap : rowGap,
        primaryAxisAlignItems: primaryMap[main] || "MIN",
        counterAxisAlignItems: counterMap[cross] || "MIN",
        fixPrimary: true,
      };
    }
    return null;
  }

  // Chrome 会把 margin-left:auto 解析成实际用掉的像素值，所以这里能直接读出偏移
  function marginsOf(cs) {
    return {
      top: parsePx(cs.marginTop),
      right: parsePx(cs.marginRight),
      bottom: parsePx(cs.marginBottom),
      left: parsePx(cs.marginLeft),
    };
  }

  function hasMargin(m) {
    return m.top > 0 || m.right > 0 || m.bottom > 0 || m.left > 0;
  }

  function radiusOf(cs) {
    const one = parsePx(cs.borderTopLeftRadius);
    if (!one) return undefined;
    const same =
      one === parsePx(cs.borderTopRightRadius) &&
      one === parsePx(cs.borderBottomRightRadius) &&
      one === parsePx(cs.borderBottomLeftRadius);
    return same ? one : undefined;
  }

  // CSS 允许只有某一条边有边框，Figma 一圈一个颜色但四条边宽度可以分别给
  function strokeOf(cs, opacity) {
    const sides = {
      top: { w: parsePx(cs.borderTopWidth), c: toColor(cs.borderTopColor) },
      right: { w: parsePx(cs.borderRightWidth), c: toColor(cs.borderRightColor) },
      bottom: { w: parsePx(cs.borderBottomWidth), c: toColor(cs.borderBottomColor) },
      left: { w: parsePx(cs.borderLeftWidth), c: toColor(cs.borderLeftColor) },
    };
    const live = Object.values(sides).filter((s) => s.w > 0 && s.c && s.c.a > 0);
    if (!live.length) return null;
    const dominant = live.slice().sort((a, b) => b.w - a.w)[0];
    return {
      color: withOpacity(dominant.c, opacity),
      weight: dominant.w,
      weights: {
        top: sides.top.w,
        right: sides.right.w,
        bottom: sides.bottom.w,
        left: sides.left.w,
      },
    };
  }

  // 括号感知的逗号切分，避免把 rgba(0, 0, 0, .5) 里的逗号当成参数分隔
  function splitTopLevel(input) {
    const out = [];
    let buf = "";
    let depth = 0;
    for (const ch of input) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(buf.trim()); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // 色标能写成「颜色 位置」，也能写成「颜色 起点 终点」——后者的颜色在这段距离内
  // 保持不变（单选圆点就靠这个写法画出实心白心 + 外圈淡出）。位置除了百分比还能是
  // 像素，而 Figma 只吃 0~1 的比例，所以要把末尾这些数值先剥出来单独换算。
  function splitStopArg(arg) {
    const positions = [];
    let text = String(arg).trim();
    while (positions.length < 2) {
      const m = text.match(/\s(-?[\d.]+)(%|px|em|rem)$/);
      if (!m) break;
      positions.unshift({ value: parseFloat(m[1]), unit: m[2] });
      text = text.slice(0, m.index);
    }
    return { colorText: text.trim(), positions };
  }

  // 换算不动就当作没写位置，交给后面均匀铺开。宁可位置不准，也不能因为单位不认识
  // 把整个色标丢掉——丢掉后色标不足两个，整条渐变就没法还原了。
  function stopFraction(pos, extent) {
    const v = pos.unit === "%" ? pos.value / 100 : extent > 0 ? pos.value / extent : null;
    if (v === null || Number.isNaN(v)) return null;
    return round4(Math.min(1, Math.max(0, v)));
  }

  function parseStops(args, extent) {
    const stops = [];
    for (const arg of args) {
      const part = splitStopArg(arg);
      const color = toColor(part.colorText);
      if (!color) continue;
      const at = part.positions.map((p) => stopFraction(p, extent)).filter((v) => v !== null);
      if (!at.length) { stops.push({ color, position: undefined }); continue; }
      stops.push({ color, position: at[0] });
      if (at.length > 1 && at[1] !== at[0]) stops.push({ color, position: at[1] });
    }
    if (stops.length < 2) return null;
    stops.forEach((s, i) => {
      if (s.position === undefined) s.position = round4(i / (stops.length - 1));
    });
    return stops;
  }

  function cssAngleOf(token) {
    if (!token) return null;
    const deg = token.match(/^(-?[\d.]+)deg$/);
    if (deg) return parseFloat(deg[1]);
    const dir = { top: 0, right: 90, bottom: 180, left: 270 };
    const m = token.match(/^to\s+(top right|bottom right|bottom left|top left|top|right|bottom|left)$/);
    if (!m) return null;
    const words = m[1].split(" ");
    if (words.length === 1) return dir[words[0]];
    const vertical = dir[words[0]] === 0 ? 0 : 180;
    const horizontal = dir[words[1]] === 90 ? 90 : 270;
    return (vertical + horizontal) / 2;
  }

  // 只描述渐变，矩阵交给插件端用 Figma 自己的 SVG 导入器换算，避免手推符号出错
  // box 只为换算像素色标而传：轴长公式必须和插件端 code.js 里那条渐变线算法一致，
  // 两边算出同一个长度，像素位置换算成的比例才对得上。
  function linearGradientPaint(body, box) {
    const args = splitTopLevel(body);
    const angle = cssAngleOf(args[0]);
    const deg = angle === null ? 180 : angle;
    const rad = (deg * Math.PI) / 180;
    const extent = box ? Math.abs(box.width * Math.sin(rad)) + Math.abs(box.height * Math.cos(rad)) : 0;
    const stops = parseStops(angle === null ? args : args.slice(1), extent);
    if (!stops) return null;
    return { grad: { kind: "linear", angle: deg, stops } };
  }

  // 色标判断沿用 parseStops 的口径：Chrome 会把渐变里的颜色算成 rgb()/rgba()，
  // 所以剥掉位置后能转成颜色的参数就是色标，转不动的就是渐变头部（circle / 半径 / at 位置）。
  function looksLikeStop(arg) {
    return !!toColor(splitStopArg(arg).colorText);
  }

  function radialGradientPaint(body, box) {
    const args = splitTopLevel(body);
    let cut = args.findIndex(looksLikeStop);
    if (cut < 0) cut = args.length;
    const head = args.slice(0, cut).join(" ");
    const shape = /\bcircle\b/.test(head) ? "circle" : "ellipse";

    let cx = 0.5, cy = 0.5, rx, ry;
    const at = head.match(/at\s+(-?[\d.]+%)\s+(-?[\d.]+%)/);
    if (at) {
      cx = round4(parseFloat(at[1]) / 100);
      cy = round4(parseFloat(at[2]) / 100);
    }
    // 只有椭圆写法的半径是按盒子宽高分别缩放的，圆形的百分比半径另有一套对角线换算，
    // 圆形统一交给插件端按 farthest-corner 兜底，误差比推错公式小。
    const size = head.match(/(^|\s)(-?[\d.]+%)\s+(-?[\d.]+%)(\s+at\b|$)/);
    if (size && shape === "ellipse") {
      rx = round4(parseFloat(size[2]) / 100);
      ry = round4(parseFloat(size[3]) / 100);
    }

    // 像素色标要按半径换算：插件端对 circle 取的是圆心到最远角，这里用同一条半径，
    // 椭圆长短轴各算各的，只能按这条半径近似
    let extent = 0;
    if (box) {
      const farX = Math.max(cx * box.width, box.width - cx * box.width);
      const farY = Math.max(cy * box.height, box.height - cy * box.height);
      extent = Math.sqrt(farX * farX + farY * farY);
    }
    const stops = parseStops(args.slice(cut), extent);
    if (!stops) return null;
    const grad = { kind: "radial", cx, cy, shape, stops };
    if (rx !== undefined && ry !== undefined) {
      grad.rx = rx;
      grad.ry = ry;
    }
    return { grad };
  }

  // background-image 允许多层叠加，CSS 把第一层画在最上面。
  // 逐层取出渐变名和括号内的完整内容（不能用贪婪正则，否则会把后面几层一起吞进来，
  // 之前 .d2-video 就是因此算出 NaN 矩阵，插件端导入不到渐变只能回落成纯色）。
  function gradientLayers(bgImage) {
    const out = [];
    for (const layer of splitTopLevel(bgImage)) {
      const name = layer.match(/([a-z-]*gradient)\s*\(/i);
      if (!name) continue;
      const open = layer.indexOf("(", name.index);
      let depth = 0;
      let body = null;
      for (let i = open; i < layer.length; i++) {
        if (layer[i] === "(") depth++;
        else if (layer[i] === ")" && --depth === 0) {
          body = layer.slice(open + 1, i);
          break;
        }
      }
      if (body === null) continue;
      out.push({ kind: name[1].toLowerCase(), body });
    }
    return out;
  }

  // conic-gradient 在 Figma 没有对应物，但环图和饼图本质是扇形，
  // 可以按色标区间算成 SVG 楔形交给导入器，落地是可编辑矢量。
  // 环心的洞不用特殊处理：.b-ring::after 那个内圆本来就是盖在上面的实心圆。
  function conicFraction(token) {
    if (token === undefined || token === null) return null;
    const t = String(token).trim();
    const pct = t.match(/^(-?[\d.]+)%$/);
    if (pct) return parseFloat(pct[1]) / 100;
    const deg = t.match(/^(-?[\d.]+)deg$/);
    if (deg) return parseFloat(deg[1]) / 360;
    const turn = t.match(/^(-?[\d.]+)turn$/);
    if (turn) return parseFloat(turn[1]);
    const grad = t.match(/^(-?[\d.]+)grad$/);
    if (grad) return parseFloat(grad[1]) / 400;
    const num = t.match(/^(-?[\d.]+)$/);
    if (num) return parseFloat(num[1]) / 100;
    return null;
  }

  function conicSvgOf(body, rect) {
    const args = splitTopLevel(body);
    const stops = [];
    for (const a of args) {
      // 头部参数（from 90deg / at 50% 50%）没有颜色，跳过
      const pos = [...a.matchAll(/(-?[\d.]+(?:%|deg|turn|grad))(?=\s|$|,)/g)].map((m) => m[1]);
      const colorText = a.replace(/(-?[\d.]+(?:%|deg|turn|grad))(?=\s|$|,)/g, "").trim();
      const color = toColor(colorText);
      if (!color) continue;
      stops.push({ color, p1: conicFraction(pos[0]), p2: conicFraction(pos[1]) });
    }
    if (stops.length < 2) return null;

    // CSS 色标语义：单值位置是该色标的"到达点"，硬边写法 A 68%, B 0 表示
    // A 实心到 68%、B 从 68% 起。所以区间按 [上一个到达点, 本到达点] 算，
    // 后一个色标即使声明了更小的位置也会被浏览器抬到不低于前一个，这里同样钳制。
    let prev = 0;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const last = i === stops.length - 1;
      if (s.p1 !== null && s.p2 !== null) {
        s.a = s.p1;
        s.b = Math.max(s.p2, s.a);
      } else if (s.p1 !== null || s.p2 !== null) {
        s.a = prev;
        s.b = Math.max(s.p1 !== null ? s.p1 : s.p2, prev);
      } else {
        // 完全没写位置的平滑色标，按均分近似
        s.a = prev;
        s.b = prev;
      }
      if (last) s.b = 1;
      prev = s.b;
    }
    // 一个位置都没写的情况：均分整圈
    if (stops.every((s) => s.b === s.a)) {
      stops.forEach((s, i) => {
        s.a = i / stops.length;
        s.b = (i + 1) / stops.length;
      });
    }

    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2;
    const at = (f) => {
      const rad = (f * 360 - 90) * (Math.PI / 180);
      return [round4(cx + r * Math.cos(rad)), round4(cy + r * Math.sin(rad))];
    };
    const paths = [];
    for (const s of stops) {
      const span = s.b - s.a;
      if (span <= 0.0005) continue;
      const c = s.color;
      const fill = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      const opacity = c.a === undefined ? 1 : c.a;
      if (span >= 0.9995) {
        paths.push(`<circle cx="${round4(cx)}" cy="${round4(cy)}" r="${round4(r)}" fill="${fill}" fill-opacity="${opacity}"/>`);
        continue;
      }
      const [x1, y1] = at(s.a);
      const [x2, y2] = at(s.b);
      const large = span > 0.5 ? 1 : 0;
      paths.push(
        `<path d="M ${round4(cx)} ${round4(cy)} L ${x1} ${y1} A ${round4(r)} ${round4(r)} 0 ${large} 1 ${x2} ${y2} Z" fill="${fill}" fill-opacity="${opacity}"/>`
      );
    }
    if (!paths.length) return null;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(h)}" viewBox="0 0 ${round(w)} ${round(h)}">${paths.join("")}</svg>`;
  }

  function gradientPaintOf(bgImage, el, box) {
    if (!bgImage || bgImage === "none") return null;
    for (const g of gradientLayers(bgImage)) {
      let paint = null;
      if (g.kind === "linear-gradient") paint = linearGradientPaint(g.body, box);
      else if (g.kind === "radial-gradient") paint = radialGradientPaint(g.body, box);
      if (paint) return paint;
      if (/^(repeating|conic)/.test(g.kind)) {
        warnings.push(`${g.kind} 在 Figma 没有对应写法，已改用下一层渐变: ${describe(el)}`);
      } else {
        warnings.push(`渐变无法解析，已改用下一层渐变: ${describe(el)} (${g.kind})`);
      }
    }
    return null;
  }

  function fillsOf(el, cs, rect, opacity) {
    const bg = toColor(cs.backgroundColor);
    const out = [];
    const grad = gradientPaintOf(cs.backgroundImage, el, rect);
    if (grad) {
      grad.grad.stops = grad.grad.stops.map((s) => ({ ...s, color: withOpacity(s.color, opacity) }));
      // Figma 的 fills 数组是后面的盖在上面，而 CSS 的 background-image 画在 background-color 之上，
      // 所以底色要先入栈（实测单选圆点就是被后入栈的底色整块盖住的）
      if (bg && bg.a > 0) out.push({ color: withOpacity(bg, opacity) });
      out.push(grad);
      return out;
    }
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      warnings.push(`渐变只能退回底色: ${describe(el)}`);
    }
    if (bg && bg.a > 0) out.push({ color: withOpacity(bg, opacity) });
    return out;
  }

  function describe(el) {
    const cls = el.className && typeof el.className === "string" && el.className.split(/\s+/)[0]
      ? "." + el.className.split(/\s+/)[0] : "";
    return `${el.tagName.toLowerCase()}${cls}`;
  }

// 表单控件的文字不在 DOM 里，只能自己量。原来用离屏 canvas，实测有三件事对不上：
// 1. canvas 的 font 不认 CSS 的 font-family 链，遇到自定义字体会静默回落到默认无衬线，
//    中英混排的量值和真实渲染差出很多；
// 2. canvas 的 measureText 不含 letter-spacing，控件普遍加了字距时会整体偏窄；
// 3. canvas 的 fontWeight 写 "400" 这类字符串在某些字体上不生效。
// 改成在页面里放一个隐藏量尺元素，用真实排版结果取宽度，和浏览器渲染完全一致。
const _ruler = document.createElement("span");
_ruler.setAttribute("data-figma-ruler", "1");
_ruler.style.cssText = "position:absolute;left:-99999px;top:0;white-space:pre;visibility:hidden;pointer-events:none;";
document.documentElement.appendChild(_ruler);

function measureTextWidth(text, cs) {
  try {
    const size = parsePx(cs.fontSize) || 14;
    // 只抄会影响宽度的属性，其余让量尺继承不到，避免继承到控件里的特殊排版
    _ruler.style.fontFamily = cs.fontFamily || "sans-serif";
    _ruler.style.fontSize = cs.fontSize || size + "px";
    _ruler.style.fontWeight = cs.fontWeight || "400";
    _ruler.style.fontStyle = cs.fontStyle || "normal";
    _ruler.style.letterSpacing = cs.letterSpacing && cs.letterSpacing !== "normal" ? cs.letterSpacing : "0px";
    _ruler.style.textTransform = cs.textTransform || "none";
    _ruler.style.fontVariantNumeric = cs.fontVariantNumeric || "normal";
    _ruler.textContent = text;
    return _ruler.getBoundingClientRect().width;
  } catch (e) {
    return text.length * (parsePx(cs.fontSize) || 14) * 0.55;
  }
}

  // 有值取值（密码转圆点），没值取 placeholder，下拉取当前选中项。
  // placeholder 的灰色写在 ::placeholder 伪元素上，要单独读计算样式。
  // 只有文本类输入的 value 才是"画在框里的字"。勾选框与单选框的 value 是 HTML 默认值
  // "on"、颜色选择器是 "#000000"、滑块是数字，照单全收就会把这些字符印在控件上。
  const TEXTUAL_TYPES = [
    "text", "search", "url", "tel", "email", "password", "number",
    "date", "datetime-local", "time", "month", "week",
  ];

  function controlOf(el, cs, rect, box, opacity, margin, parentAuto) {
    const bl = parsePx(cs.borderLeftWidth), bt = parsePx(cs.borderTopWidth);
    const br = parsePx(cs.borderRightWidth), bb = parsePx(cs.borderBottomWidth);
    const pl = parsePx(cs.paddingLeft), pr = parsePx(cs.paddingRight);
    const pt = parsePx(cs.paddingTop), pb = parsePx(cs.paddingBottom);
    const innerX = bl + pl;
    const innerY = bt + pt;
    const innerW = Math.max(1, rect.width - bl - br - pl - pr);
    const innerH = Math.max(1, rect.height - bt - bb - pt - pb);

    let text = "";
    let style = cs;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || (tag === "INPUT" && TEXTUAL_TYPES.indexOf(el.type) >= 0)) {
      const v = el.value || "";
      if (v) text = el.type === "password" ? "•".repeat(Math.min(v.length, 24)) : v;
      else if (el.placeholder) {
        text = el.placeholder;
        style = getComputedStyle(el, "::placeholder");
      }
    } else if (tag === "SELECT") {
      const i = el.selectedIndex;
      text = i >= 0 && el.options && el.options[i] ? el.options[i].text : "";
    }

    const kids = [];
    if (text) {
      const lh = style.lineHeight && style.lineHeight !== "normal"
        ? parsePx(style.lineHeight)
        : (parsePx(style.fontSize) || 14) * 1.4;
      const tw = measureTextWidth(text, style);
      // 控件文字恒为绝对定位，父容器不会裁它。实测振动趋势页那个下拉框：
      // 一句「LOX-PMP-VIB-01 · 液氧加注泵组 驱动端轴承座」按控件字体量出 341，
      // 而可用宽度只有 246，插进 Figma 后直接刺穿边框。
      // 浏览器里的 select / input 本来就不折行、超出部分被裁掉，这里按同一语义处理：
      // 文字宽度收到可用宽度内，超出的一侧由控件的 clipsContent 裁掉。
      let drawTw = tw;
      if (drawTw > innerW + 0.5) {
        drawTw = innerW;
        warnings.push(
          `控件文字超宽已截断: ${describe(el)} 「${text.slice(0, 18)}」 ${Math.round(tw)}>${Math.round(innerW)}`
        );
      }
      const align = style.textAlign === "center" ? "CENTER"
        : (style.textAlign === "right" || style.textAlign === "end") ? "RIGHT" : "LEFT";
      // 右对齐和居中的控件要从右端或中点往左收，左边才不会露出被裁掉的半截字符
      const tx = align === "RIGHT"
        ? innerX + innerW - drawTw
        : align === "CENTER"
          ? innerX + (innerW - drawTw) / 2
          : innerX;
      const ty = tag === "TEXTAREA" ? innerY : innerY + Math.max(0, (innerH - lh) / 2);
      kids.push({
        type: "text",
        name: text.slice(0, 24),
        x: round(tx), y: round(ty),
        width: round(drawTw), height: round(lh),
        fills: [{ color: withOpacity(toColor(style.color), opacity) }],
        text: { ...textSpec(style, { width: drawTw, height: lh }, text, opacity, tag), width: round(drawTw) },
        positionAbsolute: true,
      });
    }
    const accent = toColor(cs.accentColor) || toColor(cs.color) || { r: 0.17, g: 0.55, b: 1, a: 1 };
    const size = Math.min(rect.width, rect.height);
    // 勾选框与单选框是按选中状态着色的方块（走 accentColor），
    // 输入框、下拉这些走常规填充与描边。这个判断以前只写了使用处没写定义，
    // 页面一有表单控件就抛 isBox is not defined——夹具两页恰好没有，所以没暴露。
    const isBox = tag === "INPUT" && (el.type === "checkbox" || el.type === "radio");
    const boxFills = [];
    if (isBox) {
      // 选中态的底色写在 background-color 上（设计系统把控件底色设成了强调色），
      // 不能优先用 accent-color：那是浏览器原生控件的着色，计算值不是颜色，
      // 转不动时又会退到文字色，方块就被涂成黑色。
      const bg = toColor(cs.backgroundColor);
      const base = bg && bg.a > 0 ? { color: withOpacity(bg, opacity) } : { color: withOpacity(accent, opacity) };
      const dot = gradientPaintOf(cs.backgroundImage, el, rect);
      if (el.checked) {
        boxFills.push(base);
        if (dot) {
          boxFills.push({ ...dot, grad: { ...dot.grad, stops: dot.grad.stops.map((s) => ({ ...s, color: withOpacity(s.color, opacity) })) } });
        }
      } else {
        boxFills.push(bg && bg.a > 0 ? base : { color: { r: 1, g: 1, b: 1, a: 1 } });
      }
    }
    const fills = isBox ? boxFills : fillsOf(el, cs, rect, opacity);


    const own = strokeOf(cs, opacity);
    return {
      type: "frame",
      name: describe(el),
      ...box,
      fills,
      stroke: own || (isBox ? { color: withOpacity(accent, opacity), weight: 1 } : undefined),
      cornerRadius: isBox ? (el.type === "radio" ? round(size / 2) : Math.min(3, round(size / 3))) : radiusOf(cs),
      margin,
      positionAbsolute: !!parentAuto && hasMargin(margin),
      children: kids,
    };
  }

  // 内联 SVG（折线图、饼图、仪表盘、雷达图、电子围栏）整只交给 Figma 的 SVG 导入器，
  // 落地就是可编辑矢量。难点是图表颜色与线宽写在页面 CSS 的 class 上，
  // 单独摘出去会丢样式，所以先把计算样式逐元素内联、并去掉 class。
  const SVG_STYLE_PROPS = [
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
    "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
    "opacity", "visibility", "display",
  ];

  // viewBox 与实际盒子不一致时，导入器会按缩放比放大线宽。CSS 里写了
  // vector-effect: non-scaling-stroke 的元素本来就不该跟着缩放（电子围栏就是这种），
  // 这里把它换算成最终像素：线宽除以缩放比，导入器再乘回来就正好等于 CSS 的 px。
  function svgScaleOf(el, rect) {
    const vb = (el.getAttribute && el.getAttribute("viewBox")) || "";
    const parts = vb.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    if (parts.length !== 4 || !parts[2] || !parts[3]) return 1;
    const sx = rect.width / parts[2];
    const sy = rect.height / parts[3];
    if (!sx || !sy) return 1;
    return Math.sqrt(sx * sy);
  }

  // 图标 sprite：`<use href="#i-x">` 指向的是页面里另一段内联 <symbol>，
  // 只克隆宿主 svg 的话引用找不到，导出来就是空白图标。
  // 这里把被引用的 symbol 内容就地展开成 <g>，样式按原文档里的元素量。
  // 关键是样式该从哪儿取：`<symbol>` 不在渲染树里，它算出来的 fill 是初始值黑色、stroke 是 none，
  // 拿它当图标样式会把宿主 svg 真正的 `fill:none / stroke:currentColor` 盖掉，线型图标就变成一坨黑实心。
  // 渲染时克隆内容是从 <use> 的位置往下继承的，所以继承链起点要用宿主 svg 的计算值。
  const SVG_INHERIT_PROPS = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-opacity", "stroke-opacity"];

  function resolveUses(clone, hostCs) {
    const uses = Array.prototype.slice.call(clone.querySelectorAll("use"));
    for (const use of uses) {
      const ref = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      const parent = use.parentNode;
      if (!parent) continue;
      if (ref.charAt(0) !== "#") { use.remove(); continue; }
      const sym = document.getElementById(ref.slice(1));
      if (!sym) { use.remove(); continue; }
      const NS = "http://www.w3.org/2000/svg";
      const g = document.createElementNS(NS, "g");
      const x = parseFloat(use.getAttribute("x") || "0") || 0;
      const y = parseFloat(use.getAttribute("y") || "0") || 0;
      let transform = x || y ? `translate(${x} ${y})` : "";
      // symbol 自己声明过的呈现属性要覆盖在宿主的值之上
      const symCs = getComputedStyle(sym);
      const symParentCs = getComputedStyle(sym.parentElement || document.documentElement);
      const gStyle = SVG_INHERIT_PROPS.map((p) => {
        const v = symCs[p] !== symParentCs[p] ? symCs[p] : (hostCs && hostCs[p]) || symCs[p];
        return `${p}:${v}`;
      }).join(";");
      const hostVb = (clone.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      const symVb = (sym.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      // 宿主 svg 常常只有 width/height 没有 viewBox，而 `<use>` 指向的 `<symbol>` 带自己的
      // viewBox。浏览器会把 symbol 当成嵌套 svg 按 viewBox 映射到 use 的视口，
      // 我们不补这一层的话，24 单位的图形会直接画进 16 的框里，被裁掉三分之一。
      if ((!clone.getAttribute("viewBox") || hostVb.length !== 4) && symVb.length === 4 && symVb[2] && symVb[3]) {
        clone.setAttribute("viewBox", sym.getAttribute("viewBox"));
      } else if (hostVb.length === 4 && symVb.length === 4 && hostVb[2] && symVb[2] && (hostVb[2] !== symVb[2] || hostVb[3] !== symVb[3])) {
        transform += ` scale(${hostVb[2] / symVb[2]} ${hostVb[3] / symVb[3]})`;
      }
      if (transform) g.setAttribute("transform", transform.trim());
      g.setAttribute("style", gStyle);
      for (const k of Array.prototype.slice.call(sym.children)) {
        const c = k.cloneNode(true);
        const cs = getComputedStyle(k);
        const pcs = getComputedStyle(k.parentElement || sym);
        let css = "";
        for (const p of SVG_STYLE_PROPS) {
          const v = cs[p];
          if (!v || (v === "none" && /dasharray|filter|mask|clip-path/.test(p))) continue;
          // 与父级相同说明只是继承来的，写死会把上面那条继承链盖掉（黑色实心就是这么来的）
          const own = (k.getAttribute && k.getAttribute(p)) || (k.style && k.style.getPropertyValue(p));
          if (!own && v === pcs[p]) continue;
          css += `${p}:${v};`;
        }
        c.setAttribute("style", css);
        if (c.removeAttribute) c.removeAttribute("class");
        g.appendChild(c);
      }
      parent.replaceChild(g, use);
    }
  }

  // 圆环图普遍用 <circle> + stroke-dasharray/dashoffset 画分段，
  // Figma 导入器认 dasharray、不认 dashoffset，四段会全部叠回同一个起点。
  // 这里按"实线段长度 = 弧长"就地换算成真正的弧路径，段与段的位置关系才留得住。
  function unrollDashedArcs(clone) {
    const NS = "http://www.w3.org/2000/svg";
    for (const c of Array.prototype.slice.call(clone.querySelectorAll("circle"))) {
      const style = c.getAttribute("style") || "";
      const dash = /stroke-dasharray\s*:\s*([^;]+)/.exec(style);
      const off = /stroke-dashoffset\s*:\s*(-?[\d.]+)/.exec(style);
      if (!dash || !off) continue;
      const nums = dash[1].match(/-?[\d.]+/g) || [];
      if (nums.length < 2) continue;
      const num = (name) => {
        const v = c.getAttribute(name);
        if (v !== null && v !== "") return parseFloat(v);
        const m = new RegExp(name + "\\s*:\\s*(-?[\\d.]+)").exec(style);
        return m ? parseFloat(m[1]) : NaN;
      };
      const r = num("r");
      const cx = num("cx");
      const cy = num("cy");
      if (!(r > 0) || !isFinite(cx) || !isFinite(cy)) continue;
      const C = 2 * Math.PI * r;
      const cycle = nums.reduce((a, b) => a + Math.abs(parseFloat(b)), 0);
      // 分段多于四圈当装饰性点线处理：dasharray 本身 Figma 能表达，别把它拆爆
      if (!(cycle > 0) || C / cycle > 4) continue;
      const shift = ((-parseFloat(off[1]) % cycle) + cycle) % cycle;
      const arcs = [];
      let pos = 0;
      for (let j = 0; j < nums.length; j++) {
        const len = Math.abs(parseFloat(nums[j]));
        if (j % 2 === 0 && len > 0) {
          for (let t = pos + shift; t < C; t += cycle) {
            const a = Math.max(0, t);
            const b = Math.min(C, t + len);
            if (b - a > 0.01 && b - a < C - 0.01) arcs.push([a, b]);
          }
        }
        pos += len;
      }
      if (!arcs.length) continue;
      const parent = c.parentNode;
      if (!parent) continue;
      const plain = style
        .replace(/stroke-dasharray\s*:[^;]*;?/g, "")
        .replace(/stroke-dashoffset\s*:[^;]*;?/g, "");
      const made = arcs.map(([a, b]) => {
        const pt = (t) => `${round4(cx + r * Math.cos(t / r))} ${round4(cy + r * Math.sin(t / r))}`;
        const p = document.createElementNS(NS, "path");
        // 角度 = 弧长 / 半径，圆心角过半程时 large-arc-flag 取 1，方向固定顺时针（sweep=1）
        p.setAttribute("d", `M ${pt(a)} A ${round4(r)} ${round4(r)} 0 ${b - a > Math.PI * r ? 1 : 0} 1 ${pt(b)}`);
        p.setAttribute("style", plain);
        const tr = c.getAttribute("transform");
        if (tr) p.setAttribute("transform", tr);
        return p;
      });
      if (made.length === 1) parent.replaceChild(made[0], c);
      else {
        const g = document.createElementNS(NS, "g");
        made.forEach((p) => g.appendChild(p));
        parent.replaceChild(g, c);
      }
    }
  }

  function inlineSvgOf(el, rect) {
    let clone;
    try {
      clone = el.cloneNode(true);
    } catch (e) {
      return null;
    }
    const scale = svgScaleOf(el, rect);
    const strokeMin = Number(window.__FIGMA_STROKE_MIN || 0);
    const src = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
    const dst = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    for (let i = 0; i < src.length && i < dst.length; i++) {
      const s = getComputedStyle(src[i]);
      if (s.display === "none" || s.visibility === "hidden") {
        dst[i].setAttribute("style", "display:none");
        continue;
      }
      const noScale = /non-scaling-stroke/.test(s.vectorEffect || "");
      let css = "";
      for (const p of SVG_STYLE_PROPS) {
        let v = s[p];
        // fill:none 和 stroke:none 是有意义的，不能当默认值丢掉
        if (!v || (v === "none" && /dasharray|filter|mask|clip-path/.test(p))) continue;
        // 线宽和虚线节奏都按同一个缩放比换算，不然线是细了、虚线段却会被拉长
        if (noScale && scale > 1.01 && /^(stroke-width|stroke-dasharray|stroke-dashoffset)$/.test(p)) {
          v = String(v).replace(/(-?[\d.]+)px/g, (_m, n) => `${round4(parseFloat(n) / scale)}px`);
          // 描边下限按最终像素比对：先乘回缩放比再跟下限比，拿换算后的值比是错的。
          // 默认 0 表示完全跟浏览器一致，只有显式传参的项目才会抬。
          if (p === "stroke-width" && strokeMin > 0) {
            const finalPx = parseFloat(v) * scale;
            if (finalPx && finalPx < strokeMin) v = `${round4(strokeMin / scale)}px`;
          }
        }
        css += `${p}:${v};`;
      }
      // SVG 里的 <text> 字号和锚点通常写在页面 CSS 上（`svg text { font-size: 11px }`），
      // 不内联进去，导入器会按默认 16px 画，饼图标签就会糊成一团或跑到圆外。
      const tag = src[i].tagName && String(src[i].tagName).toLowerCase();
      if (tag === "text" || tag === "tspan") {
        css += `font-family:${s.fontFamily};font-size:${s.fontSize};font-weight:${s.fontWeight};font-style:${s.fontStyle};`;
        css += `text-anchor:${s.textAnchor || "start"};dominant-baseline:${s.dominantBaseline || "auto"};`;
        css += `letter-spacing:${s.letterSpacing};writing-mode:${s.writingMode || "horizontal-tb"};`;
      }
      dst[i].setAttribute("style", css);
      if (dst[i].removeAttribute) dst[i].removeAttribute("class");
    }
    // 样式抄完再展开 <use>，否则克隆体的元素数量和原树对不上
    resolveUses(clone, getComputedStyle(el));
    unrollDashedArcs(clone);
    clone.setAttribute("width", round(rect.width));
    clone.setAttribute("height", round(rect.height));
    if (clone.removeAttribute) clone.removeAttribute("class");
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return clone.outerHTML;
  }

  // display:block 的容器默认不转自动布局：实测每页只有 6 个左右容器够条件
  // （子元素全是块级、都没有 margin、没有直接文字），条件严格所以风险可控。
  // 转了的好处是子容器宽度能 FILL，改父级宽度会跟着走。
  function blockAutoLayout(el, cs, kids) {
    if (!window.__FIGMA_BLOCK_AUTO) return null;
    if (cs.display !== "block" && cs.display !== "flow-root") return null;
    const flow = Array.from(el.children).filter((c) => {
      const k = getComputedStyle(c);
      return k.display !== "none" && k.position !== "absolute" && k.position !== "fixed";
    });
    if (flow.length < 2) return null;
    for (const c of flow) {
      const k = getComputedStyle(c);
      if (!/^(block|flow-root|flex|grid)$/.test(k.display)) return null;
      if (parsePx(k.marginTop) || parsePx(k.marginBottom) || parsePx(k.marginLeft) || parsePx(k.marginRight)) return null;
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return null;
    }
    const pad = {
      top: parsePx(cs.paddingTop),
      right: parsePx(cs.paddingRight),
      bottom: parsePx(cs.paddingBottom),
      left: parsePx(cs.paddingLeft),
    };
    return {
      mode: "VERTICAL",
      padding: pad,
      itemSpacing: 0,
      counterAxisSpacing: 0,
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      layoutWrap: "NO_WRAP",
      blockAuto: true,
    };
  }

  function walk(el, parentRect, inheritedOpacity, parentAuto) {
    if (counted >= MAX_NODES) { skipped.budget++; return null; }
    if (el.tagName === "CANVAS" || el.tagName === "IFRAME") { skipped.svg++; return null; }

    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) {
      skipped.hidden++;
      return null;
    }
    if (rect.width < 1 || rect.height < 1) { skipped.hidden++; return null; }

    const opacity = round((parseFloat(cs.opacity) || 1) * inheritedOpacity);
    const box = {
      x: round(rect.left - parentRect.left),
      y: round(rect.top - parentRect.top),
      width: round(rect.width),
      height: round(rect.height),
    };
    const layout = layoutOf(cs, el);
    const margin = marginsOf(cs);

    if (el.tagName === "svg") {
      const svgText = inlineSvgOf(el, rect);
      if (!svgText) { skipped.svg++; return null; }
      counted++;
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0];
      return {
        type: "svg",
        name: "svg." + (cls || "chart"),
        ...box,
        svg: svgText,
        positionAbsolute: !!parentAuto,
      };
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      counted++;
      return controlOf(el, cs, rect, box, opacity, margin, parentAuto);
    }

    const iconSvg = iconSvgOf(cs);
    if (iconSvg) {
      counted++; icons++;
      return {
        type: "svg",
        name: describe(el).replace(/^\./, ""),
        ...box,
        svg: iconSvg,
        margin,
        positionAbsolute: !!parentAuto && hasMargin(margin),
        color: withOpacity(toColor(cs.color), opacity),
      };
    }

    // 按 DOM 原序收集子节点，文字用 Range 量真实位置，图标和文字才不会前后颠倒
    const kids = [];

    // 圆锥渐变（环图、饼图）画不成 Figma 渐变，改成按色标算出的扇形矢量，
    // 位置在元素自身内容之下、其它子节点之前，和 CSS 的背景绘制顺序一致。
    const conicLayer = gradientLayers(cs.backgroundImage || "").find((g) => g.kind === "conic-gradient");
    if (conicLayer) {
      const svgText = conicSvgOf(conicLayer.body, rect);
      if (svgText) {
        counted++;
        kids.push({
          type: "svg",
          name: "conic",
          x: 0, y: 0,
          width: box.width, height: box.height,
          svg: svgText,
          positionAbsolute: true,
        });
      } else {
        warnings.push(`圆锥渐变算不出扇形: ${describe(el)}`);
      }
    }

    const before = pseudoNode(el, "::before", rect, opacity);
    if (before) kids.push(before);

    // 相邻的纯文字节点先并成一个 Figma 文字块：一段话被 `<b>`、`<code>` 打断时，
    // 每个 DOM 文本节点的 Range 量到的是它跨行的并集盒，各画各的就压在一起（封面描述整段重叠）。
    let pendingRun = null;
    const flushRun = () => {
      if (!pendingRun) return;
      kids.push(pendingRun.node);
      pendingRun = null;
    };

    const pushTextChild = (t, tr) => {
      const spec = textSpec(cs, tr, t, opacity, el.tagName);
      // 已经按行拆过了，每一片本身就是单行，不再按"折行"处理。
      // 原来那条"宽度超过父内容盒就改成换行"的判断会误伤 white-space:nowrap
      // 和本来就溢出盒子的文字（树标签 59 宽的框装 60 宽的字，被压成两行）。
      // 度量漂移交给插件端压字距，不靠换行解决。
      const node = {
        type: "text",
        name: t.slice(0, 24),
        x: round(tr.left - rect.left),
        y: round(tr.top - rect.top),
        width: round(tr.width),
        height: round(tr.height),
        fills: [{ color: withOpacity(toColor(cs.color), opacity) }],
        text: spec,
      };
      // 只在同一行内合并：跨行合并又会造出并集盒，等于把刚拆开的重叠放回去
      if (pendingRun && pendingRun.style === cs.color && Math.abs(pendingRun.rect.top - tr.top) <= 2) {
        const a = pendingRun.rect;
        const left = Math.min(a.left, tr.left);
        const right = Math.max(a.right, tr.right);
        const top = Math.min(a.top, tr.top);
        const bottom = Math.max(a.bottom, tr.bottom);
        pendingRun.rect = { left, top, right, bottom, width: right - left, height: bottom - top };
        pendingRun.text += " " + t;
        pendingRun.node.text.characters = pendingRun.text;
        pendingRun.node.name = pendingRun.text.slice(0, 24);
        pendingRun.node.x = round(left - rect.left);
        pendingRun.node.y = round(top - rect.top);
        pendingRun.node.width = round(right - left);
        pendingRun.node.height = round(bottom - top);
        pendingRun.node.text.width = pendingRun.node.width;
        return;
      }
      flushRun();
      pendingRun = { node, rect: tr, text: t, style: cs.color };
    };

    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const raw = child.textContent;
        const t = raw.replace(/\s+/g, " ").trim();
        if (!t) continue;
        // 量字素盒而不是整段文本节点盒：源码缩进产生的首尾空白在浏览器里会折成一个空格
        // 占掉三四像素，但文字节点被 trim 掉了。按原始节点量，Figma 里的文字就会紧贴前一个
        // 行内元素（药丸标签和"关注阈值"之间原本差这么点间距）。
        const lead = raw.length - raw.replace(/^\s+/, "").length;
        const trail = raw.length - raw.replace(/\s+$/, "").length;
        for (const pc of rangePieces(child, lead, raw.length - trail)) {
          const piece = pc.text.replace(/\s+/g, " ").trim();
          if (!piece) continue;
          pushTextChild(piece, pc.rect);
        }
      } else if (child.nodeType === 1) {
        flushRun();
        const node = walk(child, rect, opacity, !!layout);
        if (node) kids.push(node);
      }
    }
    flushRun();

    const after = pseudoNode(el, "::after", rect, opacity);
    if (after) kids.push(after);

    // 块级容器够条件时补一个竖向自动布局，子节点按 FILL 走宽度
    let autoLayout = layout;
    if (!autoLayout) {
      autoLayout = blockAutoLayout(el, cs, kids);
      if (autoLayout) {
        blockAutoCount++;
        for (const k of kids) {
          if (k.positionAbsolute) continue;
          k.layoutSizingHorizontal = "FILL";
        }
      }
    }

    const hasPaint = fillsOf(el, cs, rect, opacity).length || strokeOf(cs, opacity);
    if (!kids.length && !hasPaint) { skipped.empty++; return null; }

    counted++;
    return {
      type: "frame",
      name: el.getAttribute("data-figma-name") || describe(el),
      ...box,
      fills: fillsOf(el, cs, rect, opacity),
      stroke: strokeOf(cs, opacity) || undefined,
      cornerRadius: radiusOf(cs),
      effects: [...toEffects(cs.boxShadow), ...blurEffectOf(cs.filter)],
      // 浏览器只要有一轴设成 hidden/auto/scroll，另一轴写着的 visible 就会被规范化成 auto，
      // 两个轴都不再让内容溢出——所以"任一轴不是 visible"就整框裁掉，才和浏览器一致。
      // 原来只认 hidden/clip，把 overflow:auto 的表格容器放过去了：报警详情那张表实测 1825 宽、
      // 容器只有 1568，多出的 257px 一路画到画板边上，看着就是"表格没显示全"。
      clipsContent: cs.overflowX !== "visible" || cs.overflowY !== "visible",
      margin,
      // 带 margin 的子元素在自动布局里无法表达，交给插件端改成绝对定位保持视觉位置
      positionAbsolute: !!parentAuto && hasMargin(margin),
      layout: autoLayout || undefined,
      children: kids,
    };
  }

  // 视口可能比设计尺寸小，这里把"撑满视口"的容器顶成目标高度，让整页按设计尺寸重排。
  // 不写死类名：谁的计算高度等于视口高度，就说明它用的是 100vh 这类全屏写法。
  const TARGET = window.__FIGMA_TARGET || { width: 1920, height: 1080 };

  function forceStage(target) {
    const de = document.documentElement;
    const b = document.body;
    de.style.setProperty("width", target.width + "px", "important");
    de.style.setProperty("min-width", target.width + "px", "important");
    b.style.setProperty("width", target.width + "px", "important");
    b.style.setProperty("min-width", target.width + "px", "important");
    b.style.setProperty("height", target.height + "px", "important");
    b.style.setProperty("min-height", target.height + "px", "important");

    const vh = innerHeight;
    let forced = 0;
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (Math.abs(parseFloat(cs.height) - vh) <= 1.5) {
        el.style.setProperty("height", target.height + "px", "important");
        forced++;
      }
    }
    document.body.getBoundingClientRect();

    // 长页面在浏览器里是"内滚"的，画板没有滚动条，只能把内滚容器整层摊开。
    // 两件事必须同时做，缺一边都摊不开：
    //   一、滚动容器本身设成内容高；它是竖向 flex 的子项时还要解除收缩，
    //       否则容器固定高度会把它压回去（实测 admin 的 .card-body 设 908 仍然只有 726）。
    //   二、把缺口逐层往上加到祖先。祖先大多是 overflow:visible 的固定高度框，
    //       它的 scrollHeight 不会反映子级增长，所以不能只等它自己"发现"内容变高了。
    // 往上加的时候只能取最长那一支，不能累加：两个分支各差 476 和 668 时祖先只需要 668，
    // 累加成 1144 就会在画板底部留下大片空白。
    // flex 只在父级是竖向 flex 时才动：横向 flex 里写 flex:0 0 auto 会让这一列不再收缩，
    // 整页宽度被撑到画板外（实测右侧栏跑到 x=1975）。
    if (window.__FIGMA_EXPAND_SCROLL) {
      const reverseAll = () => Array.prototype.slice.call(document.querySelectorAll("body *")).reverse();
      // 内容实测高：这个元素"装下所有流子里物到底需要多高"。
      // 绝不能拿 scrollHeight 当内容高：scrollHeight 永远不小于元素自己的 clientHeight。
      // 这套原型的列表普遍用 height:100% 或 flex 撑满，祖先一旦被加高，它就跟着被拉长，
      // 于是"被拉多高"会被读成"内容多高"，下一轮再拿这个值继续加高祖先，
      // 冻结下来就是画布上卡片里那一大片空白（实测 .t3__list-scroll 内容只到 656，却被记成 1802）。
      const naturalHeight = (el) => {
        const cs = getComputedStyle(el);
        const er = el.getBoundingClientRect();
        const top = er.top + (parseFloat(cs.borderTopWidth) || 0);
        let bottom = top + (parseFloat(cs.paddingTop) || 0);
        let seen = false;
        for (const k of el.children) {
          const kcs = getComputedStyle(k);
          if (kcs.display === "none") continue;
          if (kcs.position === "absolute" || kcs.position === "fixed") continue;
          const kr = k.getBoundingClientRect();
          if (kr.height <= 0) continue;
          seen = true;
          const v = kr.bottom + (parseFloat(kcs.marginBottom) || 0);
          if (v > bottom) bottom = v;
        }
        if (!seen) {
          // 没有元素子级的滚动容器（里面是纯文字/内联）只能退回 scrollHeight
          return Math.ceil(Math.max(el.scrollHeight, er.height));
        }
        // 只看直接子节点会漏：内容常在孙辈里，而中间那层可能被 flex 挤成 0 高、
        // 靠"可见溢出"把内容透出来（实测 report-diagnosis 的 main.workspace 量到 54，
        // 真实内容是 2147，画板于是被截掉大半）。所以再往下一层量"最深可见底边"，
        // 遇到会裁切的层（overflow 非 visible）就停在它的盒子底边，剩下的交给它自己那一轮。
        const deepest = (node) => {
          let b = 0;
          for (const k of node.children) {
            const kcs = getComputedStyle(k);
            if (kcs.display === "none") continue;
            const kr = k.getBoundingClientRect();
            if (kr.height <= 0 && kr.width <= 0) continue;
            if (kr.bottom > b) b = kr.bottom;
            if (/visible/.test(kcs.overflowY) && k.children && k.children.length) {
              const kb = deepest(k);
              if (kb > b) b = kb;
            }
          }
          return b;
        };
        const deep = deepest(el);
        if (deep > bottom) bottom = deep;
        return Math.ceil(bottom - er.top + (parseFloat(cs.borderBottomWidth) || 0));
      };
      const isScroller = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY);
      const touched = new Set();
      // 设了 height 还不够：flex:1 的子项会被父级的拉伸算法重新分配高度，我们写的 height 直接被覆盖。
      // 只在父级是竖向 flex 时解除收缩；横向 flex 里写 flex:0 0 auto 会让这一列不再收缩、整页撑到画板外。
      const stretchGuard = (el) => {
        const p = el.parentElement;
        if (!p) return;
        const pcs = getComputedStyle(p);
        const isFlex = /^(flex|inline-flex)$/.test(pcs.display);
        const isGrid = /^(grid|inline-grid)$/.test(pcs.display);
        if (isFlex && /^column/.test(pcs.flexDirection)) {
          // 竖向 flex：高度是主轴，靠 flex 解除收缩
          el.style.setProperty("flex", "0 0 auto", "important");
          el.style.setProperty("align-self", "auto", "important");
        } else if (isFlex) {
          // 横向 flex：高度是交叉轴，flex 那套动不得（动过会把整列撑到画板外），
          // 只把自身的交叉轴拉伸关掉。.t2__scroll 这类滚动区就是这么被父级拉高的。
          const cs = getComputedStyle(el);
          if (/^(stretch|auto)$/.test(cs.alignSelf)) el.style.setProperty("align-self", "flex-start", "important");
        } else if (isGrid) {
          const cs = getComputedStyle(el);
          if (/^(stretch|auto)$/.test(cs.alignSelf)) el.style.setProperty("align-self", "start", "important");
        }
      };
      const relax = (el) => {
        el.style.setProperty("height", naturalHeight(el) + "px", "important");
        el.style.setProperty("max-height", "none", "important");
        el.style.setProperty("min-height", "0", "important");
        touched.add(el);
        stretchGuard(el);
      };
      const grown = new WeakMap();
      let anyGrew = false;
      for (let pass = 0; pass < 3; pass++) {
        const jobs = [];
        for (const el of reverseAll()) {
          // 已经被摊开、或已经被某个子级缺口补齐过的容器不要再算一次。
          // 否则像 .t6__panel 这种“滚动区本身又是 grid/flex 子项”的结构，会把同一段
          // 缺口先加给父级、下一轮又当成父级自己的滚动缺口再加一次，形成双倍空白。
          if (touched.has(el)) continue;
          if (!isScroller(el)) continue;
          const deficit = naturalHeight(el) - el.clientHeight;
          if (deficit <= 8) continue;
          relax(el);
          jobs.push({ el, deficit });
          anyGrew = true;
        }
        if (!jobs.length) break;
        for (const job of jobs) {
          let anc = job.el.parentElement;
          while (anc && anc !== b) {
            // 子级被摊开后，祖先自己可能已经顺着 grid/flex 自然长高了一部分。
            // 这里不能再盲目加“子级缺口”，只能按祖先当前真实内容高和当前盒高的差额补。
            // 否则 .t6__panel 的 880 缺口会先让 .workspace__content 从 942 长到 1806，
            // 再被加一次 880，变成 2686，画板中段就出现整块空白。
            const need = naturalHeight(anc);
            const cur = anc.getBoundingClientRect().height;
            const add = Math.ceil(need - cur);
            if (add <= 8) { anc = anc.parentElement; continue; }
            const already = grown.get(anc) || 0;
            if (already >= add) { anc = anc.parentElement; continue; }
            grown.set(anc, add);
            const nextH = Math.ceil(cur + add - already);
            anc.style.setProperty("height", nextH + "px", "important");
            anc.style.setProperty("max-height", "none", "important");
            // 祖先加高后，flex/grid 默认的 align-items:stretch 会把同一排本来矮的兄弟一起拉长，
            // 卡片里那一大片空白就是这么来的。只在它是默认的 stretch 时改成贴内容对齐，
            // center / flex-end 这类刻意的对齐一律不动，免得把垂直居中改成顶部对齐。
            const acs = getComputedStyle(anc);
            if (/^(flex|grid|inline-flex|inline-grid)$/.test(acs.display) && acs.alignItems === "stretch") {
              anc.style.setProperty("align-items", /^(grid|inline-grid)$/.test(acs.display) ? "start" : "flex-start", "important");
            }
            // 加过高的祖先要登记进 touched：等子级都收到真实内容高之后，收尾那趟会把它也收回真实高度，
            // 否则祖先会一直留着"当时估算的缺口"，孩子缩回去了父亲还是空的。
            touched.add(anc);
            const p = anc.parentElement;
            if (p) {
              const pcs = getComputedStyle(p);
              if (/^(flex|inline-flex)$/.test(pcs.display) && /^column/.test(pcs.flexDirection)) {
                anc.style.setProperty("flex", "0 0 auto", "important");
              }
            }
            anc = p;
          }
        }
        document.body.getBoundingClientRect();
      }
      // 收尾一次"按实测内容收紧"：从最深层往上，把我们加高过的祖先、以及被百分比/flex
      // 顺带拉长的滚动容器，都收回到真实内容高。顺序是反向遍历，所以子级先定高、父级再算。
      // 阈值 24px 是为了不去动那些本来就只有几像素舍入差的容器。
      //
      // 候选分两类：
      //   一、我们动过的（滚动区本身、被缺口上传加高的祖先）以及其它滚动容器；
      //   二、没动过但被父级布局拉伸的"卡片"。第二类的必要性：一列里有个真需要加高的滚动区，
      //       同一行的别的卡片会被 grid/flex 一起拉伸到同样高，内容只占上半截，画布上就是
      //       section.card 高 1050、内容只到 518 那种观感。但侧边栏、主体背景这类"本来就该铺满"的
      //       不能一起收，收了画板左侧会缺一截。区分办法用观感而不是猜类名：
      //       有圆角/两条以上描边的当卡片收；什么都不画的纯排版容器也收（收了她不留痕迹）。
      const looksLikeBox = (cs) => {
        const r = parseFloat(cs.borderTopLeftRadius) || 0;
        const edges = ["Top", "Right", "Bottom", "Left"].filter(
          (s) => (parseFloat(cs["border" + s + "Width"]) || 0) > 0
        ).length;
        return r > 0 || edges >= 2;
      };
      // 这一层自己有没有画东西（背景色或背景图）。不画背景的是纯排版容器：
      // 把它收回去不会留下可见缺口，因为它本来什么都不填；
      // 而侧边栏、主体区这种有底色的要留着铺满，收了画板左侧就会缺一截。
      const paints = (cs) => {
        const b = (cs.backgroundColor || "").trim();
        const painted = b && b !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(b);
        const img = (cs.backgroundImage || "").trim();
        return painted || (img && img !== "none");
      };
      // 收尾只收我们自己动过的（被摊开的滚动区、被缺口上传加高的祖先）。
      // 曾经这里还想顺带收"被父级拉伸的卡片和不画背景的排版容器"，实测会把真内容收掉：
      // 诊断记录页 .workspace__content 里的内容本来 1187 高，被按"最后一个流子里物"量成 942，
      // 画板直接从 1267 截到 1080，用户看到的是内容被切掉。丢内容比留空白严重得多，
      // 所以拉伸问题不在这里治，改在下面"加高祖先时不许它把兄弟拉伸"那条解决。
      if (anyGrew) {
        for (const el of reverseAll()) {
          // 候选：我们动过的、滚动容器本身，以及"被父级拉伸且自己不像要铺满"的层。
          // 第三类必须收，因为这套原型里 .t3__list-scroll 这类列表是 height:100%/flex 撑满的，
          // 被祖先带高之后自身内容根本填不满，但它不是我们动过的，只收前两类就会漏掉它。
          // 上一版这条把内容截断了，原因不在候选而在尺子（当时只量直接子节点，
          // 孙辈靠可见溢出透出来的内容量不到）；现在 naturalHeight 会往深里量，可以安全启用。
          // 收三类：滚动容器自己、我们加高过的层、以及"被拉伸又不像要铺满"的卡片/纯排版容器。
          // 只收前两类会把用户报的原始症状放回来（卡片内部一大片空，实测振动趋势分析 532px、
          // 模拟听诊 555px、预案库 1146px 都属第三类）。
          const cs = getComputedStyle(el);
          const mine = touched.has(el) || /(auto|scroll)/.test(cs.overflowY);
          if (!mine && !el.children.length) continue;
          if (!mine) {
            const r0 = parseFloat(cs.borderTopLeftRadius) || 0;
            const edges = ["Top", "Right", "Bottom", "Left"].filter((t2) => (parseFloat(cs["border" + t2 + "Width"]) || 0) > 0).length;
            const paintedBox = r0 > 0 || edges >= 2;
            const bg = (cs.backgroundColor || "").trim();
            const painted = (bg && bg !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(bg)) ||
              ((cs.backgroundImage || "").trim() && cs.backgroundImage !== "none");
            // 带底色又不像卡片的（侧栏、主体背景）一律不动，收了画板会缺一截
            if (!paintedBox && painted) continue;
          }
          const need = naturalHeight(el);
          const cur = el.getBoundingClientRect().height;
          if (need > 40 && cur - need > 24) {
            el.style.setProperty("height", need + "px", "important");
            el.style.setProperty("min-height", "0", "important");
            el.style.setProperty("max-height", "none", "important");
            stretchGuard(el);
          }
        }
      }
      // 反向补一刀：会画背景的容器必须包住内容。
      // 摊开只把里面那层滚动区长高，外层壳子（div.app-shell 这类带页面底色的 grid/flex 框）
      // 停在摊开前的高度，结果下半页内容溢出到壳子外面——Figma 里表现为画板 2824 高、
      // 壳子只有 1960，下面那截没有页面底色，看着像坏了。实测 41 页里 5 页中招。
      // 只在"这层自己画了背景、溢出部分来自常规流子级（不是被裁切的绝对定位装饰）"时补高，
      // 免得把"故意 overflow:hidden 裁掉的装饰圆片"也算进内容。
      if (anyGrew) {
        const inFlowReach = (node, top) => {
          let b = top;
          for (const k of node.children) {
            const kcs = getComputedStyle(k);
            if (kcs.display === "none" || kcs.position === "absolute" || kcs.position === "fixed") continue;
            const kr = k.getBoundingClientRect();
            if (kr.height <= 0 && kr.width <= 0) continue;
            let kb = kr.bottom;
            if (/visible/.test(kcs.overflowY) && k.children.length) kb = Math.max(kb, inFlowReach(k, kr.bottom));
            if (kb > b) b = kb;
          }
          return b;
        };
        for (const el of reverseAll()) {
          const cs = getComputedStyle(el);
          const bg = (cs.backgroundColor || "").trim();
          const painted = (bg && bg !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(bg)) ||
            ((cs.backgroundImage || "").trim() && cs.backgroundImage !== "none");
          if (!painted) continue;
          const er = el.getBoundingClientRect();
          const reach = inFlowReach(el, er.bottom);
          const gap = Math.ceil(reach - er.bottom);
          if (gap > 24) {
            el.style.setProperty("height", Math.ceil(er.height + gap) + "px", "important");
            el.style.setProperty("min-height", "0", "important");
            el.style.setProperty("max-height", "none", "important");
            stretchGuard(el);
            touched.add(el);
          }
        }
      }
      b.style.setProperty("height", "auto", "important");
      b.style.setProperty("min-height", target.height + "px", "important");
      return forced;
    }

    return forced;
  }

  // 标签页在后台时 CSS 过渡的动画时间线是冻结的：切换 data-theme 后，
  // 带 transition 的属性会停在旧值上，量到的就是上一个主题的颜色。
  // 抽取前统一关掉过渡和动画，保证读到的都是最终值。
  function killTransitions() {
    const st = document.createElement("style");
    st.id = "figma-kill-transition";
    st.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(st);
  }
  killTransitions();

  const forcedContainers = forceStage(TARGET);

  const source = (location.pathname.split("/").pop() || "").replace(/\.html?$/i, "") || "page";

  // ---------- 组件化 ----------
  // 同一页里结构、尺寸、颜色都一致、只有文字不同的子树，第一次建成组件，
  // 后面的副本改成放实例并按子索引路径覆盖文字。表格行、统计卡片、标签都会命中。
  // 签名必须把颜色和图标内容算进去，否则红蓝两种数值会被当成同一个组件。
  function colorsOf(node) {
    const bits = [];
    for (const f of node.fills || []) {
      if (f.grad) bits.push(`g${f.grad.kind}${f.grad.angle || ""}${f.grad.stops.length}`);
      else if (f.color) bits.push(`${f.color.r},${f.color.g},${f.color.b},${f.color.a}`);
    }
    if (node.stroke && node.stroke.color) {
      const c = node.stroke.color;
      bits.push(`s${c.r},${c.g},${c.b},${c.a}${node.stroke.weight || ""}`);
    }
    if (node.cornerRadius !== undefined) bits.push(`r${node.cornerRadius}`);
    if (node.effects && node.effects.length) bits.push(`e${node.effects.map((x) => x.type + (x.radius || "")).join("/")}`);
    return bits.join("|");
  }

  function shortHash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function signatureOf(node) {
    if (node.type === "text") {
      const t = node.text || {};
      node._sig = `T:${t.fontSize}:${t.fontStyle}:${t.textAlignHorizontal}:${colorsOf(node)}`;
      node._size = 1;
      return;
    }
    if (node.type === "svg") {
      node._sig = `S:${Math.round(node.width)}x${Math.round(node.height)}:${shortHash(node.svg || "")}:${colorsOf(node)}`;
      node._size = 1;
      return;
    }
    for (const c of node.children || []) signatureOf(c);
    const kids = node.children || [];
    node._sig = `${node.type}:${node.name || ""}:${Math.round(node.width)}x${Math.round(node.height)}:${colorsOf(node)}(${kids.map((k) => k._sig).join(",")})`;
    node._size = 1 + kids.reduce((a, c) => a + c._size, 0);
  }

  function classBaseOf(node) {
    const m = String(node.name || "").match(/^[a-z]+\.([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function textPaths(node, out, path) {
    const list = out || [];
    const p = path || [];
    if (node.type === "text" && node.text) {
      list.push({ path: p.slice(), characters: String(node.text.characters || "") });
    }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) textPaths(kids[i], list, p.concat(i));
    return list;
  }

  function componentize(tree, options) {
    const minCount = options.minCount || 3;
    const maxSize = options.maxSize || 60;
    const maxComponents = options.maxComponents || 12;
    // 签名字典由收集服务持久化：同一个结构在任何页面都叫同一个名字，
    // 否则跨页遇到同名不同结构的子树，插件按名字找组件会拿错结构。
    const known = options.names || {};
    signatureOf(tree);

    const stats = new Map();
    (function count(node) {
      for (const c of node.children || []) {
        const base = classBaseOf(c);
        if (base && c._size >= 3 && c._size <= maxSize && !c._skipComponent) {
          const prev = stats.get(c._sig) || { count: 0, name: base, size: c._size };
          prev.count++;
          stats.set(c._sig, prev);
        }
        count(c);
      }
    })(tree);

    // 已有签名的优先级高于“本页重复次数”：新页面里即使只出现一次，
    // 只要和上一页已有组件结构一致，也应该直接放实例，而不是再建一个同名母版。
    const knownHits = [...stats.entries()].filter(([sig]) => !!known[sig]);
    const newHits = [...stats.entries()]
      .filter(([sig, v]) => !known[sig] && v.count >= minCount)
      .sort((a, b) => b[1].count * b[1].size - a[1].count * a[1].size)
      .slice(0, maxComponents);
    const picked = new Map();
    const added = {};
    const taken = new Set(Object.values(known));
    const usedNames = new Map();
    for (const [sig] of knownHits) {
      picked.set(sig, { name: known[sig], known: true });
    }
    for (const [sig, v] of newHits) {
      const seen = usedNames.get(v.name) || 0;
      usedNames.set(v.name, seen + 1);
      let name = `组件/${v.name}`;
      let n = 2;
      while (taken.has(name)) name = `组件/${v.name}·${n++}`;
      taken.add(name);
      picked.set(sig, { name, known: false });
      added[sig] = name;
    }

    const made = [];
    const emitted = new Set();
    (function apply(node) {
      for (const c of node.children || []) {
        const hit = picked.get(c._sig);
        if (!hit) {
          apply(c);
          continue;
        }
        if (hit.known) {
          c.overrides = textPaths(c);
          c.componentRef = hit.name;
          c.children = [];
          continue;
        }
        if (!emitted.has(c._sig)) {
          emitted.add(c._sig);
          c.component = hit.name;
          made.push({ name: hit.name, size: c._size });
          continue; // 组件内部不再往里找重复
        }
        c.overrides = textPaths(c);
        c.componentRef = hit.name;
        c.children = [];
      }
    })(tree);

    // 清掉临时字段，别把它们写进 JSON
    (function clean(node) {
      delete node._sig;
      delete node._size;
      delete node._emitted;
      delete node._skipComponent;
      for (const c of node.children || []) clean(c);
    })(tree);
    return { added, made };
  }

  const root = document.body;
  // 画板高度也用"最深可见后代"，不再用 documentElement.scrollHeight：
  // 后者会把"被可见溢出透出来但根本不画东西"的余量算进来（实测诊断简报画板 2544、内容只到 2191，
  // 底部多出 353 空档），而按子树量出来的就是内容真实到的位置。
  const visibleBottom = (el) => {
    const r = el.getBoundingClientRect();
    let b = r.bottom;
    for (const k of el.children) {
      const cs = getComputedStyle(k);
      if (cs.display === "none") continue;
      const kr = k.getBoundingClientRect();
      if (kr.height <= 0 && kr.width <= 0) continue;
      if (kr.bottom > b) b = kr.bottom;
      if (/visible/.test(cs.overflowY) && k.children && k.children.length) {
        const kb = visibleBottom(k);
        if (kb > b) b = kb;
      }
    }
    return b;
  };
  const rootRect = root.getBoundingClientRect();
  const rootCs = getComputedStyle(root);
  const tree = {
    type: "frame",
    name: document.title || "页面",
    x: 0, y: 0,
    width: round(Math.max(rootRect.width, document.documentElement.scrollWidth)),
    height: round(Math.max(rootRect.height, Math.ceil(visibleBottom(document.body) - rootRect.top))),
    fills: [{ color: toColor(rootCs.backgroundColor) || { r: 0, g: 0, b: 0, a: 1 } }],
    children: Array.from(root.children)
      .map((el) => walk(el, { left: 0, top: 0 }, 1))
      .filter(Boolean),
  };

  let treeNodes = 0;
  (function sizeOf(node) {
    treeNodes++;
    for (const c of node.children || []) sizeOf(c);
  })(tree);
  const treeNodesRaw = treeNodes;
  let componentInfo = null;
  if (window.__FIGMA_COMPONENTS) {
    componentInfo = componentize(tree, {
      minCount: Number(window.__FIGMA_COMPONENT_MIN || 3),
      maxComponents: Number(window.__FIGMA_COMPONENT_MAX || 12),
      names: window.__FIGMA_COMPONENT_NAMES || {},
    });
  }
  let treeNodesAfter = 0;
  (function sizeAgain(node) {
    treeNodesAfter++;
    for (const c of node.children || []) sizeAgain(c);
  })(tree);

  const payload = {
    url: location.href,
    title: document.title,
    source,
    viewport: { width: innerWidth, height: innerHeight },
    tree,
    sigNames: componentInfo ? componentInfo.added : {},
    stats: {
      nodes: counted,
      treeNodes: treeNodesRaw,
      treeNodesAfter,
      icons,
      pseudos,
      blockAuto: blockAutoCount,
      components: componentInfo ? Object.keys(componentInfo.added).length : 0,
      componentNames: componentInfo ? Object.values(componentInfo.added) : [],
      forcedContainers,
      target: TARGET,
      skipped,
      warnings: warnings.length,
    },
    warnings: [...new Set(warnings)].slice(0, 40),
    // 落盘目录由外层批量脚本按项目单给；没给就留空，收集服务回落到自己启动时那个目录
    outDir: window.__FIGMA_OUT_DIR || "",
  };

  fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload) })
    .then(() => { window.__FIGMA_DONE = true; })
    .catch((e) => { window.__FIGMA_ERROR = String(e); });
})();
