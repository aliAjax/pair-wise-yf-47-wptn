import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: string[];
  note: string;
  withdrawalState: "未安排" | "已安排收车" | "已作废";
  withdrawalAt?: string;
  withdrawalBy?: Role;
  withdrawalReason?: string;
}

// 区段放行链：区段有先后顺序，前行区段未放行则后行区段不能放行
export interface SectionInfo {
  id: string;
  name: string;
  order: number;
}

export type ReleaseState = "待放行" | "已放行" | "已作废";

export interface SectionRelease {
  sectionId: string;
  state: ReleaseState;
  releasedAt?: string;
  releasedBy?: Role;
  generation?: number; // 放行结论依据的车站状态代数
  reason?: string; // 作废 / 拒绝原因
}

// 断网时先记在本地的操作，回网后按编号合并
export type OutboxStatus = "待同步" | "已合并" | "待协调" | "合并失败";

export interface OutboxItem {
  id: string; // 编号，用于按编号合并
  consoleId: string; // 提交的调度台
  action: string;
  detail: string;
  time: string;
  status: OutboxStatus;
  seq: number; // 合并序号，先到先生效
  retries: number;
  error?: string; // 合并失败原因（留住原因重试）
  payload:
    | { type: "stationRestore"; stationId: string; status: StationStatus; note?: string }
    | { type: "stationChange"; stationId: string; status: StationStatus; note?: string }
    | { type: "timeline"; entry: Omit<TimelineEntry, "id" | "time"> };
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  item?: OutboxItem;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  sections: SectionInfo[];
  sectionReleases: Record<string, SectionRelease>;
  stationGeneration: number; // 车站状态代数：一变则放行结论、收车安排全部作废
  outbox: OutboxItem[];
  mergeSeq: number;
  consoleId: string;
  role: Role;
  online: boolean;
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => ActionResult;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals" | "withdrawalState">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  releaseSection: (sectionId: string) => ActionResult;
  withdrawPlan: (planId: string) => ActionResult;
  submitStationRestore: (stationId: string, note?: string) => ActionResult;
  syncOutbox: () => void;
  retryOutbox: (id?: string) => void;
  simulateRivalConsole: (stationId: string) => void;
}

const now = () => new Date().toISOString();

function getConsoleId(): string {
  if (typeof window === "undefined") return "调度台-服务端";
  try {
    let id = sessionStorage.getItem("rail-console-id");
    if (!id) {
      id = `调度台-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      sessionStorage.setItem("rail-console-id", id);
    }
    return id;
  } catch {
    return "调度台-本机";
  }
}

// 跨调度台（浏览器标签页）同步：任一调度台合并后通知其它台重新读取本地账本
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  try {
    if (!channel) {
      channel = new BroadcastChannel("rail-ops-outbox");
      channel.onmessage = (ev: MessageEvent) => {
        if (ev.data?.type === "outbox-changed") {
          void useIncidentStore.persist.rehydrate();
        }
      };
    }
    return channel;
  } catch {
    return null;
  }
}
function broadcastOutbox() {
  try {
    getChannel()?.postMessage({ type: "outbox-changed" });
  } catch {
    /* 广播不可用时忽略 */
  }
}

// 车站状态一变，所有已放行结论作废
function invalidateReleases(releases: Record<string, SectionRelease>, reason: string): Record<string, SectionRelease> {
  const next: Record<string, SectionRelease> = {};
  for (const [key, value] of Object.entries(releases)) {
    next[key] = value.state === "已放行" ? { ...value, state: "已作废", reason } : value;
  }
  return next;
}

// 车站状态一变，所有已安排的收车作废
function invalidateWithdrawals(plans: ShuttlePlan[], reason: string): ShuttlePlan[] {
  return plans.map((plan) =>
    plan.withdrawalState === "已安排收车" ? { ...plan, withdrawalState: "已作废" as const, withdrawalReason: reason } : plan
  );
}

const seedSections: SectionInfo[] = [
  { id: "sec-1", name: "中心—滨江", order: 1 },
  { id: "sec-2", name: "滨江—会展", order: 2 },
  { id: "sec-3", name: "会展—东港", order: 3 }
];

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心—滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "滨江—会展", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "会展—东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

// 合并单条本地操作；失败时留住原因，交由调用方标记“合并失败”并重试
function applyOutboxItem(
  item: OutboxItem,
  ctx: { stations: Station[]; timeline: TimelineEntry[]; sectionReleases: Record<string, SectionRelease>; plans: ShuttlePlan[] }
): { ok: true; stations: Station[]; timeline: TimelineEntry[]; sectionReleases: Record<string, SectionRelease>; plans: ShuttlePlan[] } | { ok: false; reason: string } {
  const payload = item.payload;
  switch (payload.type) {
    case "timeline": {
      return {
        ok: true,
        stations: ctx.stations,
        sectionReleases: ctx.sectionReleases,
        plans: ctx.plans,
        timeline: [{ ...payload.entry, id: item.id, time: item.time }, ...ctx.timeline]
      };
    }
    case "stationRestore":
    case "stationChange": {
      const station = ctx.stations.find((s) => s.id === payload.stationId);
      if (!station) {
        return { ok: false, reason: `目标车站不存在或已删除（编号 ${item.id.slice(0, 8)}）` };
      }
      const stations = ctx.stations.map((s) =>
        s.id === payload.stationId ? { ...s, status: payload.status, note: payload.note ?? s.note, updatedAt: item.time } : s
      );
      const sectionReleases = invalidateReleases(ctx.sectionReleases, `车站 ${station.name} 状态变化，放行结论作废`);
      const plans = invalidateWithdrawals(ctx.plans, `车站 ${station.name} 状态变化，收车安排作废`);
      const timeline: TimelineEntry[] = [
        {
          id: item.id,
          time: item.time,
          actor: "调度员",
          action: payload.type === "stationRestore" ? "恢复车站" : "更新车站状态",
          detail: `${station.name} → ${payload.status}（编号 ${item.id.slice(0, 8)}，调度台 ${item.consoleId}）`,
          phase: payload.status === "正常" || payload.status === "恢复中" ? "恢复" : "响应"
        },
        ...ctx.timeline
      ];
      return { ok: true, stations, timeline, sectionReleases, plans };
    }
  }
}

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set, get) => ({
      incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
      stations: seedStations,
      timeline: [
        { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
        { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
      ],
      plans: [
        { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客", withdrawalState: "未安排" }
      ],
      sections: seedSections,
      sectionReleases: {},
      stationGeneration: 0,
      outbox: [],
      mergeSeq: 0,
      consoleId: getConsoleId(),
      role: "调度员",
      online: true,
      setRole: (role) => set({ role }),
      setOnline: (online) => {
        set({ online });
        if (online) {
          // 回网后自动按编号合并本地队列
          setTimeout(() => get().syncOutbox(), 0);
        }
      },
      setStationStatus: (id, status, note) => {
        const state = get();
        if (state.role === "客服主管") return { ok: false, reason: "客服主管无权变更车站状态，已直接拒绝" };
        const station = state.stations.find((item) => item.id === id);
        if (!station) return { ok: false, reason: "车站不存在" };
        const nextStations = state.stations.map((item) =>
          item.id === id ? { ...item, status, note: note ?? item.note, updatedAt: now() } : item
        );
        const nextReleases = invalidateReleases(state.sectionReleases, `车站 ${station.name} 状态变化，放行结论作废`);
        const nextPlans = invalidateWithdrawals(state.plans, `车站 ${station.name} 状态变化，收车安排作废`);
        const nextTimeline: TimelineEntry[] = [
          { id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${station.name} → ${status}`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" },
          ...state.timeline
        ];
        if (state.online) {
          set({ stations: nextStations, stationGeneration: state.stationGeneration + 1, sectionReleases: nextReleases, plans: nextPlans, timeline: nextTimeline });
          broadcastOutbox();
          return { ok: true };
        }
        // 弱网：先记在本地，回网后按编号合并
        const item: OutboxItem = {
          id: crypto.randomUUID(),
          consoleId: state.consoleId,
          action: "更新车站状态",
          detail: `${station.name} → ${status}`,
          time: now(),
          status: "待同步",
          seq: state.mergeSeq + 1,
          retries: 0,
          payload: { type: "stationChange", stationId: id, status, note }
        };
        set({
          stations: nextStations,
          stationGeneration: state.stationGeneration + 1,
          sectionReleases: nextReleases,
          plans: nextPlans,
          timeline: nextTimeline,
          outbox: [item, ...state.outbox],
          mergeSeq: state.mergeSeq + 1
        });
        broadcastOutbox();
        return { ok: true };
      },
      addTimeline: (entry) => {
        const state = get();
        const item: OutboxItem = {
          id: crypto.randomUUID(),
          consoleId: state.consoleId,
          action: entry.action,
          detail: entry.detail,
          time: now(),
          status: "待同步",
          seq: state.mergeSeq + 1,
          retries: 0,
          payload: { type: "timeline", entry }
        };
        if (state.online) {
          set({ timeline: [{ ...entry, id: item.id, time: item.time }, ...state.timeline] });
        } else {
          set({ timeline: [{ ...entry, id: item.id, time: item.time }, ...state.timeline], outbox: [item, ...state.outbox], mergeSeq: state.mergeSeq + 1 });
        }
        broadcastOutbox();
      },
      addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [], withdrawalState: "未安排" }, ...state.plans] })),
      submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline] })),
      approvePlan: (id, approver) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan) })),
      executePlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "已执行" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline] })),
      releaseSection: (sectionId) => {
        const state = get();
        const section = state.sections.find((item) => item.id === sectionId);
        if (!section) return { ok: false, reason: "区段不存在" };
        const existing = state.sectionReleases[sectionId];
        if (existing?.state === "已放行") return { ok: false, reason: "该区段已放行，无需重复操作" };
        const prior = state.sections.filter((item) => item.order < section.order).sort((a, b) => a.order - b.order);
        const priorBlocked = prior.filter((item) => state.sectionReleases[item.id]?.state !== "已放行");
        if (priorBlocked.length) return { ok: false, reason: `前行区段 ${priorBlocked.map((item) => item.name).join("、")} 尚未放行，不能越级放行` };
        const notNormal = state.stations.filter((item) => item.section === section.name && item.status !== "正常");
        if (notNormal.length) return { ok: false, reason: `区段内车站 ${notNormal.map((item) => item.name).join("、")} 未恢复正常，不能放行` };
        const release: SectionRelease = { sectionId, state: "已放行", releasedAt: now(), releasedBy: state.role, generation: state.stationGeneration };
        set({
          sectionReleases: { ...state.sectionReleases, [sectionId]: release },
          timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "放行区段", detail: `${section.name} 恢复行车（依据第 ${state.stationGeneration} 代车站状态）`, phase: "恢复" }, ...state.timeline]
        });
        broadcastOutbox();
        return { ok: true };
      },
      withdrawPlan: (planId) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === planId);
        if (!plan) return { ok: false, reason: "接驳计划不存在" };
        if (plan.withdrawalState === "已安排收车") return { ok: false, reason: "已安排收车，无需重复操作" };
        const covered = state.stations.filter((item) => plan.stations.includes(item.name));
        const notNormal = covered.filter((item) => item.status !== "正常");
        if (notNormal.length) return { ok: false, reason: `覆盖车站 ${notNormal.map((item) => item.name).join("、")} 未全部恢复正常，接驳车暂不能收` };
        set({
          plans: state.plans.map((item) => item.id === planId ? { ...item, withdrawalState: "已安排收车", withdrawalAt: now(), withdrawalBy: state.role, withdrawalGeneration: state.stationGeneration, withdrawalReason: undefined } : item),
          timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "安排收车", detail: `${plan.stations.join(" → ")} 接驳车收车（覆盖车站已全部恢复）`, phase: "接驳" }, ...state.timeline]
        });
        broadcastOutbox();
        return { ok: true };
      },
      submitStationRestore: (stationId, note) => {
        const state = get();
        if (state.role === "客服主管") return { ok: false, reason: "客服主管无权恢复车站状态，已直接拒绝" };
        const station = state.stations.find((item) => item.id === stationId);
        if (!station) return { ok: false, reason: "车站不存在" };
        const item: OutboxItem = {
          id: crypto.randomUUID(),
          consoleId: state.consoleId,
          action: "恢复车站",
          detail: `${station.name} → 正常`,
          time: now(),
          status: "待同步",
          seq: state.mergeSeq + 1,
          retries: 0,
          payload: { type: "stationRestore", stationId, status: "正常", note }
        };
        // 本地先记一笔（乐观生效），回网 / 在线时按编号合并，先到先生效
        const nextStations = state.stations.map((s) => s.id === stationId ? { ...s, status: "正常" as StationStatus, note: note ?? s.note, updatedAt: now() } : s);
        set({
          stations: nextStations,
          stationGeneration: state.stationGeneration + 1,
          sectionReleases: invalidateReleases(state.sectionReleases, `车站 ${station.name} 状态变化，放行结论作废`),
          plans: invalidateWithdrawals(state.plans, `车站 ${station.name} 状态变化，收车安排作废`),
          outbox: [item, ...state.outbox],
          mergeSeq: state.mergeSeq + 1
        });
        broadcastOutbox();
        if (state.online) get().syncOutbox();
        return { ok: true, item };
      },
      syncOutbox: () => {
        const state = get();
        const pending = state.outbox
          .filter((item) => item.status === "待同步" || item.status === "合并失败")
          .sort((a, b) => a.seq - b.seq || a.time.localeCompare(b.time));
        if (pending.length === 0) return;
        let stations = state.stations;
        let timeline = state.timeline;
        let sectionReleases = { ...state.sectionReleases };
        let plans = state.plans.map((item) => ({ ...item }));
        let outbox = state.outbox.map((item) => ({ ...item }));
        for (const item of pending) {
          const index = outbox.findIndex((entry) => entry.id === item.id);
          const applied = applyOutboxItem(item, { stations, timeline, sectionReleases, plans });
          if (!applied.ok) {
            // 合并失败：留住原因，次数 +1，稍后可重试
            outbox[index] = { ...item, status: "合并失败", error: applied.reason, retries: item.retries + 1 };
            continue;
          }
          if (item.payload.type === "stationRestore") {
            const stationId = item.payload.stationId;
            const winner = outbox.find((entry) => entry.status === "已合并" && entry.payload.type === "stationRestore" && entry.payload.stationId === stationId);
            if (winner) {
              if (winner.seq < item.seq) {
                // 先到的一条已生效，落选的留成待协调
                outbox[index] = { ...item, status: "待协调", error: `调度台 ${winner.consoleId} 已先恢复该车站（编号 ${winner.id.slice(0, 8)}），先到先生效` };
                continue;
              }
              if (winner.seq > item.seq) {
                // 更早的编号晚到：先到先生效，原生效一条改留待协调
                const winnerIndex = outbox.findIndex((entry) => entry.id === winner.id);
                outbox[winnerIndex] = { ...winner, status: "待协调", error: `更早编号 ${item.id.slice(0, 8)} 到达生效，先到先生效` };
              }
            }
          }
          stations = applied.stations;
          timeline = applied.timeline;
          sectionReleases = applied.sectionReleases;
          plans = applied.plans;
          outbox[index] = { ...item, status: "已合并", error: undefined };
        }
        set({ stations, timeline, sectionReleases, plans, outbox });
        broadcastOutbox();
      },
      retryOutbox: (id) => {
        set((state) => ({
          outbox: state.outbox.map((item) => (id === undefined || item.id === id) && item.status === "合并失败" ? { ...item, status: "待同步", error: undefined } : item)
        }));
        broadcastOutbox();
        get().syncOutbox();
      },
      simulateRivalConsole: (stationId) => {
        const state = get();
        const station = state.stations.find((item) => item.id === stationId);
        if (!station) return;
        const item: OutboxItem = {
          id: crypto.randomUUID(),
          consoleId: "调度台-兄弟",
          action: "恢复车站",
          detail: `${station.name} → 正常`,
          time: now(),
          status: "待同步",
          seq: state.mergeSeq + 1,
          retries: 0,
          payload: { type: "stationRestore", stationId, status: "正常" }
        };
        set({ outbox: [item, ...state.outbox], mergeSeq: state.mergeSeq + 1 });
        broadcastOutbox();
        if (state.online) get().syncOutbox();
      }
    }),
    {
      name: "pair-wise-yf-47/incident",
      partialize: (state) => {
        const { consoleId: _consoleId, ...rest } = state;
        return rest;
      }
    }
  )
);
