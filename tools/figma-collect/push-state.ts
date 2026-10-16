// 推送进度落盘：控制台页面读它显示"第几页 / 共几页 / 当前页状态"。
// 单独一个模块是为了让 build-page 与 build-batch 各写各的字段而不互相覆盖：
// 谁写之前都先读回整份，合并自己那一段再原子换回去。
import { writeFileSync, readFileSync, renameSync, existsSync } from "fs";
import { join } from "path";

export type PageState = {
  name?: string;
  source?: string;
  nodes?: number;
  status?: "running" | "done" | "unverified" | "failed";
  startedAt?: number;
  finishedAt?: number | null;
  elapsedMs?: number;
  verified?: boolean;
  childCount?: number;
  expectChildren?: number;
  created?: number;
  error?: string;
};

export type BatchState = {
  dir?: string;
  total?: number;
  index?: number;
  current?: string;
  startedAt?: number;
  finishedAt?: number | null;
  done?: number;
  failed?: number;
};

export type PushState = { updatedAt?: number; batch: BatchState | null; page: PageState | null };

export const PUSH_STATE_FILE =
  process.env.PUSH_STATE || join(import.meta.dir, "push-state.json");

export function readState(): PushState {
  try {
    if (!existsSync(PUSH_STATE_FILE)) return { batch: null, page: null };
    const raw = JSON.parse(readFileSync(PUSH_STATE_FILE, "utf8"));
    return { batch: raw.batch || null, page: raw.page || null };
  } catch {
    return { batch: null, page: null };
  }
}

export function writeState(patch: Partial<PushState>) {
  const cur = readState();
  const next: PushState = {
    updatedAt: Date.now(),
    batch: patch.batch !== undefined ? patch.batch : cur.batch,
    page: patch.page !== undefined ? { ...(cur.page || {}), ...patch.page } : cur.page,
  };
  // 先写临时文件再改名：页面随时在读，不能读到半截 JSON
  const tmp = PUSH_STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, PUSH_STATE_FILE);
  return next;
}
