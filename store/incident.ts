import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyOp,
  decideOp,
  mergeOrder,
  type ChainState,
  type CoordinationItem,
  type Op,
  type QueuedOp,
  type SectionDef,
  type SectionRelease,
  type VoidRecord,
  type Withdrawal
} from "../lib/releaseChain";

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
  sectionId: string;
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
}

export interface PendingAction {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface OpResult {
  ok: boolean;
  reason?: string;
  queued?: boolean;
}

interface IncidentState extends ChainState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  /** 断网本地队列：带编号，回网按编号合并；失败留住原因 */
  pendingOps: QueuedOp[];
  /** 对端调度台送达、尚未合并的操作 */
  remoteInbox: Op[];
  /** 恢复冲突中落选、待人工协调的操作 */
  coordination: CoordinationItem[];
  consoleId: string;
  opSeq: number;
  peerSeq: number;
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  requestStationStatus: (id: string, status: StationStatus, note?: string) => OpResult;
  releaseSection: (sectionId: string) => OpResult;
  planWithdrawal: (planId: string) => OpResult;
  confirmWithdrawal: (planId: string) => OpResult;
  syncQueue: () => void;
  retryOp: (id: string) => void;
  injectPeerRestore: (stationId: string) => void;
  dismissCoordination: (id: string) => void;
  resubmitCoordination: (id: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const seedSections: SectionDef[] = [
  { id: "sec-1", name: "中心—滨江", order: 1 },
  { id: "sec-2", name: "滨江—会展", order: 2 },
  { id: "sec-3", name: "会展—东港", order: 3 }
];

const seedStations: Station[] = [
  { id: "s0", name: "中心站", section: "中心—滨江", sectionId: "sec-1", status: "恢复中", passengerRisk: "中", note: "积水已退，站台设备检查中", updatedAt: now() },
  { id: "s1", name: "滨江站", section: "中心—滨江", sectionId: "sec-1", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "滨江—会展", sectionId: "sec-2", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "会展—东港", sectionId: "sec-3", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const pickChain = (state: IncidentState): ChainState => ({
  stations: state.stations,
  sections: state.sections,
  plans: state.plans,
  releases: state.releases,
  withdrawals: state.withdrawals,
  stationRevision: state.stationRevision,
  voidLog: state.voidLog,
  timeline: state.timeline
});

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set, get) => {
      /** 在线时立即校验并应用一条操作 */
      const runOp = (op: Op): OpResult => {
        const decision = decideOp(op, pickChain(get()));
        if (decision.kind === "apply") {
          set(applyOp(pickChain(get()), op));
          return { ok: true };
        }
        if (decision.kind === "coordinate") {
          set((state) => ({ coordination: [{ id: uid(), op, reason: decision.reason, time: now() }, ...state.coordination] }));
          return { ok: false, reason: decision.reason };
        }
        return { ok: false, reason: decision.reason };
      };

      /** 断网时先记在本地，带回网后按编号合并 */
      const enqueue = (op: Op): OpResult => {
        set((state) => ({ pendingOps: [{ ...op, state: "待同步" }, ...state.pendingOps] }));
        return { ok: true, queued: true };
      };

      const buildOp = (partial: Pick<Op, "type"> & Partial<Op>): Op => {
        const state = get();
        const seq = state.opSeq + 1;
        set({ opSeq: seq });
        return { id: uid(), seq, consoleId: state.consoleId, actor: state.role, createdAt: now(), ...partial };
      };

      const dispatch = (op: Op): OpResult => (get().online ? runOp(op) : enqueue(op));

      return {
        incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
        stations: seedStations,
        sections: seedSections,
        releases: [],
        withdrawals: [],
        stationRevision: 0,
        voidLog: [],
        timeline: [
          { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
          { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
        ],
        plans: [
          { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "已执行", approvals: ["调度员", "公交接驳负责人"], note: "优先疏运站外滞留乘客" }
        ],
        role: "调度员",
        online: true,
        pendingActions: [],
        pendingOps: [],
        remoteInbox: [],
        coordination: [],
        consoleId: "调度台-A",
        opSeq: 0,
        peerSeq: 0,
        setRole: (role) => set({ role }),
        setOnline: (online) => set({ online }),
        requestStationStatus: (id, status, note) => {
          const state = get();
          // 客服主管越权改车站状态：直接拒绝并留痕
          if (state.role === "客服主管") {
            set((current) => ({
              timeline: [
                { id: uid(), time: now(), actor: current.role, action: "越权拦截", detail: "客服主管尝试变更车站状态，已直接拒绝", phase: "响应" as const },
                ...current.timeline
              ]
            }));
            return { ok: false, reason: "客服主管无权变更车站状态，已直接拒绝" };
          }
          return dispatch(buildOp({ type: status === "正常" ? "station.restore" : "station.status", stationId: id, status, note }));
        },
        releaseSection: (sectionId) => {
          if (get().role !== "调度员") return { ok: false, reason: "仅调度员可放行区段" };
          return dispatch(buildOp({ type: "section.release", sectionId }));
        },
        planWithdrawal: (planId) => {
          const role = get().role;
          if (role !== "公交接驳负责人" && role !== "调度员") return { ok: false, reason: "仅公交接驳负责人或调度员可安排收车" };
          return dispatch(buildOp({ type: "shuttle.withdraw", planId }));
        },
        confirmWithdrawal: (planId) => {
          const state = get();
          const withdrawal = state.withdrawals.find((item) => item.planId === planId && item.status === "待收车");
          if (!withdrawal) return { ok: false, reason: "没有待收车安排" };
          if (withdrawal.revision !== state.stationRevision) return { ok: false, reason: "车站状态已变化，该收车安排已作废" };
          set((current) => ({
            withdrawals: current.withdrawals.map((item) => (item.id === withdrawal.id ? { ...item, status: "已收车" as const } : item)),
            timeline: [
              { id: uid(), time: now(), actor: current.role, action: "接驳收车", detail: `计划 ${planId.slice(0, 6)} 接驳车已收车，运力撤回`, phase: "接驳" as const },
              ...current.timeline
            ]
          }));
          return { ok: true };
        },
        syncQueue: () => {
          const state = get();
          if (!state.online) return;
          if (!state.pendingOps.length && !state.remoteInbox.length) return;
          // 本地队列与对端操作按编号合并，先到先生效
          const ordered = mergeOrder([...state.pendingOps, ...state.remoteInbox]);
          const localIds = new Set(state.pendingOps.map((op) => op.id));
          let working = pickChain(state);
          const failed: QueuedOp[] = [];
          const coordination = [...state.coordination];
          for (const op of ordered) {
            const decision = decideOp(op, working);
            if (decision.kind === "apply") {
              working = applyOp(working, op);
              continue;
            }
            if (decision.kind === "coordinate") {
              coordination.unshift({ id: uid(), op, reason: decision.reason, time: now() });
              continue;
            }
            // 合并失败：本地操作留住原因待重试；对端操作转待协调
            if (localIds.has(op.id)) failed.push({ ...op, state: "失败", error: decision.reason });
            else coordination.unshift({ id: uid(), op, reason: `对端操作合并失败：${decision.reason}`, time: now() });
          }
          set({ ...working, pendingOps: failed, remoteInbox: [], coordination });
        },
        retryOp: (id) => {
          const state = get();
          if (!state.online) return;
          const op = state.pendingOps.find((item) => item.id === id);
          if (!op) return;
          const decision = decideOp(op, pickChain(state));
          if (decision.kind === "apply") {
            set({ ...applyOp(pickChain(state), op), pendingOps: state.pendingOps.filter((item) => item.id !== id) });
            return;
          }
          if (decision.kind === "coordinate") {
            set({
              pendingOps: state.pendingOps.filter((item) => item.id !== id),
              coordination: [{ id: uid(), op, reason: decision.reason, time: now() }, ...state.coordination]
            });
            return;
          }
          set({ pendingOps: state.pendingOps.map((item) => (item.id === id ? { ...item, state: "失败", error: decision.reason } : item)) });
        },
        injectPeerRestore: (stationId) => {
          const state = get();
          const op: Op = {
            id: uid(),
            seq: state.peerSeq + 1,
            consoleId: "调度台-B",
            actor: "调度员",
            type: "station.restore",
            stationId,
            status: "正常",
            createdAt: now()
          };
          set({ peerSeq: state.peerSeq + 1, remoteInbox: [op, ...state.remoteInbox] });
          if (state.online) get().syncQueue();
        },
        dismissCoordination: (id) => set((state) => ({ coordination: state.coordination.filter((item) => item.id !== id) })),
        resubmitCoordination: (id) => {
          const state = get();
          const item = state.coordination.find((entry) => entry.id === id);
          if (!item) return;
          set({ coordination: state.coordination.filter((entry) => entry.id !== id) });
          dispatch(
            buildOp({ type: item.op.type, stationId: item.op.stationId, status: item.op.status, note: item.op.note, sectionId: item.op.sectionId, planId: item.op.planId })
          );
        },
        addTimeline: (entry) =>
          set((state) => ({
            timeline: [{ ...entry, id: uid(), time: now() }, ...state.timeline],
            pendingActions: state.online
              ? state.pendingActions
              : [{ id: uid(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions]
          })),
        addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: uid(), status: "草稿", approvals: [] }, ...state.plans] })),
        submitPlan: (id) =>
          set((state) => ({
            plans: state.plans.map((plan) => (plan.id === id ? { ...plan, status: "待确认" } : plan)),
            timeline: [{ id: uid(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline]
          })),
        approvePlan: (id, approver) =>
          set((state) => ({
            plans: state.plans.map((plan) =>
              plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan
            )
          })),
        executePlan: (id) =>
          set((state) => ({
            plans: state.plans.map((plan) => (plan.id === id ? { ...plan, status: "已执行" } : plan)),
            timeline: [{ id: uid(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline]
          })),
        queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: uid(), action, detail, time: now() }, ...state.pendingActions] })),
        syncActions: () => set({ pendingActions: [] })
      };
    },
    // version 2：放行链引入新状态结构，旧缓存直接弃用
    { name: "pair-wise-yf-47/incident", version: 2 }
  )
);
