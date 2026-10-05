import type { Role, ShuttlePlan, Station, StationStatus, TimelineEntry } from "../store/incident";

/**
 * 放行链领域逻辑（纯函数，不依赖 UI / 存储）。
 *
 * 规则总览：
 * 1. 区段按 order 顺序放行：本区段车站全部恢复正常且前序区段均已放行，才可放行本区段。
 * 2. 接驳车收车：计划覆盖的车站全部恢复正常才可安排收车。
 * 3. 车站状态一变（stationRevision 递增），所有放行结论与待收车安排立即作废。
 * 4. 操作带编号（seq），断网落本地队列，回网按编号合并；合并失败保留原因可重试。
 * 5. 两个调度台同时恢复同一车站：合并排序后先到者生效，落选者进入待协调。
 * 6. 客服主管变更车站状态：直接拒绝。
 */

export type OpType = "station.restore" | "station.status" | "section.release" | "shuttle.withdraw";

/** 一条调度操作（本地或对端调度台），seq 为合并排序编号 */
export interface Op {
  id: string;
  seq: number;
  consoleId: string;
  actor: Role;
  type: OpType;
  stationId?: string;
  status?: StationStatus;
  note?: string;
  sectionId?: string;
  planId?: string;
  createdAt: string;
}

/** 本地队列中的操作：待同步；合并失败后为"失败"并留住原因 */
export interface QueuedOp extends Op {
  state: "待同步" | "失败";
  error?: string;
}

export interface SectionDef {
  id: string;
  name: string;
  order: number;
}

/** 区段放行结论，只在生成时的 stationRevision 下有效 */
export interface SectionRelease {
  sectionId: string;
  revision: number;
  releasedAt: string;
  by: string;
}

export type SectionGate = "已放行" | "可放行" | "待恢复" | "待前段放行";

export interface SectionView {
  section: SectionDef;
  stations: Station[];
  gate: SectionGate;
  blocking: Station[];
  release?: SectionRelease;
}

/** 收车安排，待收车状态只在生成时的 stationRevision 下有效 */
export interface Withdrawal {
  id: string;
  planId: string;
  revision: number;
  status: "待收车" | "已收车" | "已作废";
  createdAt: string;
  reason?: string;
}

export type PlanGate = "未执行" | "服务中" | "可收车" | "已收车";

export interface PlanView {
  gate: PlanGate;
  blocking: Station[];
  withdrawal?: Withdrawal;
}

export interface VoidRecord {
  id: string;
  kind: "放行作废" | "收车作废";
  detail: string;
  time: string;
}

/** 落选待协调：合并时晚到的恢复操作 */
export interface CoordinationItem {
  id: string;
  op: Op;
  reason: string;
  time: string;
}

/** 放行链推导与操作应用所需的状态切片 */
export interface ChainState {
  stations: Station[];
  sections: SectionDef[];
  plans: ShuttlePlan[];
  releases: SectionRelease[];
  withdrawals: Withdrawal[];
  stationRevision: number;
  voidLog: VoidRecord[];
  timeline: TimelineEntry[];
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** 合并排序：编号优先，同号按提交时间，再按台位编号，保证"先到先生效"且结果确定 */
export function mergeOrder<T extends Op>(ops: T[]): T[] {
  return [...ops].sort(
    (a, b) =>
      a.seq - b.seq ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.consoleId.localeCompare(b.consoleId) ||
      a.id.localeCompare(b.id)
  );
}

/** 推导区段放行链：任一区段未放行，其后的区段一律"待前段放行" */
export function deriveSectionChain(
  sections: SectionDef[],
  stations: Station[],
  releases: SectionRelease[],
  revision: number
): SectionView[] {
  const views: SectionView[] = [];
  let previousReleased = true;
  for (const section of [...sections].sort((a, b) => a.order - b.order)) {
    const sectionStations = stations.filter((station) => station.sectionId === section.id);
    const blocking = sectionStations.filter((station) => station.status !== "正常");
    const release = releases.find((item) => item.sectionId === section.id && item.revision === revision);
    let gate: SectionGate;
    if (release) gate = "已放行";
    else if (blocking.length) gate = "待恢复";
    else if (!previousReleased) gate = "待前段放行";
    else gate = "可放行";
    views.push({ section, stations: sectionStations, gate, blocking, release });
    previousReleased = Boolean(release);
  }
  return views;
}

/** 推导单个接驳计划的收车门禁：覆盖车站全部正常才可收车 */
export function derivePlanGate(
  plan: ShuttlePlan,
  stations: Station[],
  withdrawals: Withdrawal[],
  revision: number
): PlanView {
  if (plan.status !== "已执行") return { gate: "未执行", blocking: [] };
  const done = withdrawals.find((item) => item.planId === plan.id && item.status === "已收车");
  if (done) return { gate: "已收车", blocking: [], withdrawal: done };
  const blocking = stations.filter((station) => plan.stations.includes(station.name) && station.status !== "正常");
  if (blocking.length) return { gate: "服务中", blocking };
  const pending = withdrawals.find((item) => item.planId === plan.id && item.status === "待收车" && item.revision === revision);
  return { gate: "可收车", blocking: [], withdrawal: pending };
}

export type OpDecision =
  | { kind: "apply" }
  | { kind: "reject"; reason: string }
  | { kind: "coordinate"; reason: string };

/** 校验一条操作在当前状态下能否生效：越权直接拒绝，恢复落选转待协调，其余不满足条件给原因 */
export function decideOp(op: Op, state: ChainState): OpDecision {
  if ((op.type === "station.restore" || op.type === "station.status") && op.actor === "客服主管") {
    return { kind: "reject", reason: "客服主管无权变更车站状态，已直接拒绝" };
  }
  switch (op.type) {
    case "station.restore": {
      const station = state.stations.find((item) => item.id === op.stationId);
      if (!station) return { kind: "reject", reason: "车站不存在" };
      if (station.status === "正常") {
        return { kind: "coordinate", reason: `${station.name} 已被先行恢复正常，本操作落选，留待协调` };
      }
      return { kind: "apply" };
    }
    case "station.status": {
      const station = state.stations.find((item) => item.id === op.stationId);
      if (!station) return { kind: "reject", reason: "车站不存在" };
      return { kind: "apply" };
    }
    case "section.release": {
      const view = deriveSectionChain(state.sections, state.stations, state.releases, state.stationRevision).find(
        (item) => item.section.id === op.sectionId
      );
      if (!view) return { kind: "reject", reason: "区段不存在" };
      if (view.gate === "已放行") return { kind: "reject", reason: `区段 ${view.section.name} 已放行，重复操作被拒绝` };
      if (view.gate === "待恢复") {
        return { kind: "reject", reason: `区段 ${view.section.name} 内 ${view.blocking.map((item) => item.name).join("、")} 未恢复正常，不能放行` };
      }
      if (view.gate === "待前段放行") return { kind: "reject", reason: `前序区段尚未放行，区段 ${view.section.name} 不能先放行` };
      return { kind: "apply" };
    }
    case "shuttle.withdraw": {
      const plan = state.plans.find((item) => item.id === op.planId);
      if (!plan) return { kind: "reject", reason: "接驳计划不存在" };
      if (plan.status !== "已执行") return { kind: "reject", reason: "接驳计划未执行，车辆尚未上线" };
      const view = derivePlanGate(plan, state.stations, state.withdrawals, state.stationRevision);
      if (view.gate === "已收车") return { kind: "reject", reason: "该计划接驳车已收车" };
      if (view.blocking.length) {
        return { kind: "reject", reason: `覆盖车站 ${view.blocking.map((item) => item.name).join("、")} 未恢复正常，接驳车不能收车` };
      }
      if (view.withdrawal) return { kind: "reject", reason: "已存在待收车安排，请勿重复提交" };
      return { kind: "apply" };
    }
  }
}

/** 应用一条通过校验的操作，返回新状态（车站状态变更会作废旧放行结论与待收车安排） */
export function applyOp(state: ChainState, op: Op): ChainState {
  if (op.type === "station.restore" || op.type === "station.status") {
    const status: StationStatus = op.type === "station.restore" ? "正常" : (op.status as StationStatus);
    const station = state.stations.find((item) => item.id === op.stationId);
    if (!station) return state;
    const revision = state.stationRevision + 1;
    const voidLog = [...state.voidLog];
    // 车站状态一变，全部放行结论作废
    const releases = state.releases.filter((release) => {
      const sectionName = state.sections.find((section) => section.id === release.sectionId)?.name ?? release.sectionId;
      voidLog.unshift({
        id: uid(),
        kind: "放行作废",
        detail: `区段 ${sectionName} 的放行结论因 ${station.name} 状态变更（→ ${status}）作废`,
        time: now()
      });
      return false;
    });
    // 待收车安排一并作废
    const withdrawals = state.withdrawals.map((withdrawal) => {
      if (withdrawal.status !== "待收车") return withdrawal;
      voidLog.unshift({
        id: uid(),
        kind: "收车作废",
        detail: `计划 ${withdrawal.planId.slice(0, 6)} 的收车安排因 ${station.name} 状态变更（→ ${status}）作废`,
        time: now()
      });
      return { ...withdrawal, status: "已作废" as const, reason: `${station.name} 状态变更，收车安排作废` };
    });
    const stations = state.stations.map((item) =>
      item.id === op.stationId ? { ...item, status, note: op.note ?? item.note, updatedAt: now() } : item
    );
    const timeline: TimelineEntry[] = [
      {
        id: uid(),
        time: now(),
        actor: op.actor,
        action: op.type === "station.restore" ? "恢复车站" : "更新车站状态",
        detail: `${station.name} → ${status}（${op.consoleId} · 编号 #${op.seq}）`,
        phase: status === "正常" || status === "恢复中" ? "恢复" : "响应"
      },
      ...state.timeline
    ];
    return { ...state, stations, releases, withdrawals, stationRevision: revision, voidLog, timeline };
  }
  if (op.type === "section.release") {
    const section = state.sections.find((item) => item.id === op.sectionId);
    if (!section) return state;
    const release: SectionRelease = { sectionId: section.id, revision: state.stationRevision, releasedAt: now(), by: op.actor };
    const timeline: TimelineEntry[] = [
      {
        id: uid(),
        time: now(),
        actor: op.actor,
        action: "区段放行",
        detail: `区段 ${section.name} 恢复行车（${op.consoleId} · 编号 #${op.seq}）`,
        phase: "恢复"
      },
      ...state.timeline
    ];
    return { ...state, releases: [...state.releases, release], timeline };
  }
  const withdrawal: Withdrawal = {
    id: uid(),
    planId: op.planId as string,
    revision: state.stationRevision,
    status: "待收车",
    createdAt: now()
  };
  const timeline: TimelineEntry[] = [
    {
      id: uid(),
      time: now(),
      actor: op.actor,
      action: "安排收车",
      detail: `接驳计划 ${String(op.planId).slice(0, 6)} 覆盖车站已全部恢复，安排收车（${op.consoleId} · 编号 #${op.seq}）`,
      phase: "接驳"
    },
    ...state.timeline
  ];
  return { ...state, withdrawals: [...state.withdrawals, withdrawal], timeline };
}

export function describeOp(op: Op, stations: Station[], sections: SectionDef[]): string {
  const stationName = stations.find((item) => item.id === op.stationId)?.name ?? "";
  const sectionName = sections.find((item) => item.id === op.sectionId)?.name ?? "";
  switch (op.type) {
    case "station.restore":
      return `恢复 ${stationName} 至正常`;
    case "station.status":
      return `${stationName} → ${op.status}`;
    case "section.release":
      return `放行区段 ${sectionName}`;
    case "shuttle.withdraw":
      return `安排收车（计划 ${String(op.planId).slice(0, 6)}）`;
  }
}
