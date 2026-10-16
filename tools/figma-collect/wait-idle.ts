// 等插件空闲：轻命令往返低于阈值并连续两次成立才算空闲。
// 用途是批量推送时不要把自己排到上一页还没建完的队后面。
import { openFigma } from "./bridge.ts";

const CHANNEL = process.env.CHANNEL || "powerplant";
const LIMIT = Number(process.env.LIMIT_MS || 40);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 900000);

const figma = await openFigma(CHANNEL);
let ok = 0;
const deadline = Date.now() + DEADLINE_MS;
while (Date.now() < deadline) {
  try {
    const t0 = Date.now();
    await figma.call("get_document_info", {});
    if (Date.now() - t0 < LIMIT) ok++;
    else ok = 0;
  } catch {
    ok = 0;
  }
  if (ok >= 2) break;
  await new Promise((r) => setTimeout(r, 4000));
}
const idle = ok >= 2;
figma.close();
console.log(idle ? "插件已空闲" : "等空闲超时，继续");
process.exit(idle ? 0 : 1);
