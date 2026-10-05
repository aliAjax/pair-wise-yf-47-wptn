"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { useIncidentStore, type OutboxStatus, type Role, type ShuttlePlan, type Station, type StationStatus } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const releaseColor: Record<string, string> = { 已放行: "green", 已作废: "red", 待放行: "default" };
const outboxColor: Record<OutboxStatus, string> = { 已合并: "green", 待协调: "orange", 合并失败: "red", 待同步: "blue" };

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const reject = (result: { ok: boolean; reason?: string }) => {
    if (!result.ok && result.reason) messageApi.error(result.reason);
    return result.ok;
  };

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "处置", render: (_, record) => {
      const disabled = state.role === "客服主管";
      return <Space wrap>
        <Button size="small" disabled={disabled || record.status === "正常"} onClick={() => { if (reject(state.submitStationRestore(record.id))) messageApi.success(`${record.name} 恢复正常已提交，按编号合并`); }}>恢复正常</Button>
        <Button size="small" disabled={disabled} onClick={() => reject(state.setStationStatus(record.id, "限流"))}>限流</Button>
        <Button size="small" disabled={disabled} danger={record.status !== "封闭"} onClick={() => reject(state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭"))}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button>
        <Button size="small" type="dashed" onClick={() => { state.simulateRivalConsole(record.id); messageApi.info(`兄弟调度台也提交了 ${record.name} 的恢复，先到先生效`); }}>模拟兄弟台</Button>
      </Space>;
    } }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  const coveredStations = (plan: ShuttlePlan) => state.stations.filter((s) => plan.stations.includes(s.name));

  return <div className="shell">
    {contextHolder}
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "放行链", "本地队列"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>本机调度台 {state.consoleId}</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待同步 / 待协调" value={`${state.outbox.filter((i) => i.status === "待同步").length} / ${state.outbox.filter((i) => i.status === "待协调").length}`} /></Card><Card><Statistic title="合并失败" value={state.outbox.filter((i) => i.status === "合并失败").length} valueStyle={{ color: state.outbox.some((i) => i.status === "合并失败") ? "#e5484d" : undefined }} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。关键处置会进入本地队列，恢复连接后按编号合并，合并失败会留住原因可重试。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 860 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交负责人双方确认。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={[{title:"接驳站",dataIndex:"stations",render:(v:string[])=>v.join(" → ")},{title:"车辆",dataIndex:"vehicles"},{title:"间隔",dataIndex:"interval",render:(v:number)=>`${v} 分钟`},{title:"运营方",dataIndex:"operator"},{title:"确认",dataIndex:"approvals",render:(v:string[])=>v.length? v.map((x)=><Tag key={x} color="green">{x}</Tag>) : <Tag>未确认</Tag>},{title:"状态",dataIndex:"status",render:(v)=> <Tag color={v==="已确认"||v==="已执行"?"green":v==="待确认"?"orange":"default"}>{v}</Tag>},{title:"收车",dataIndex:"withdrawalState",render:(v:string, record: ShuttlePlan)=>{
        const covered = coveredStations(record);
        const notNormal = covered.filter((s) => s.status !== "正常");
        const disabled = state.role === "客服主管" || record.status === "草稿" || v === "已安排收车";
        return <Space direction="vertical" size={2}>
          <Tag color={v === "已安排收车" ? "green" : v === "已作废" ? "red" : "default"}>{v === "已安排收车" ? "已安排收车" : v === "已作废" ? "收车已作废" : "未安排收车"}</Tag>
          {v === "已作废" && record.withdrawalReason && <small style={{ color: "#e5484d" }}>{record.withdrawalReason}</small>}
          <Button size="small" type="primary" disabled={disabled} onClick={() => { const r = state.withdrawPlan(record.id); if (!r.ok) messageApi.error(r.reason); else messageApi.success("已安排收车"); }}>安排收车</Button>
          {notNormal.length > 0 && <small style={{ color: "#b06a00" }}>覆盖站未恢复：{notNormal.map((s) => s.name).join("、")}</small>}
        </Space>;
      }},{title:"操作",render:(_,record:ShuttlePlan)=><Space><Button size="small" disabled={record.status!=="草稿"} onClick={()=>state.submitPlan(record.id)}>提交确认</Button><Button size="small" disabled={record.status!=="待确认"||state.role==="客服主管"} onClick={()=>state.approvePlan(record.id,state.role)}>确认</Button><Button size="small" type="primary" disabled={record.status!=="已确认"} onClick={()=>state.executePlan(record.id)}>执行</Button></Space>}]} /></Card>}
      {panel === "放行链" && <Card title="区段放行链" extra={<Tag>第 {state.stationGeneration} 代车站状态</Tag>}>
        <Timeline items={state.sections.map((section) => {
          const release = state.sectionReleases[section.id];
          const releaseState = release?.state ?? "待放行";
          const inSection = state.stations.filter((s) => s.section === section.name);
          const notNormal = inSection.filter((s) => s.status !== "正常");
          const prior = state.sections.filter((s) => s.order < section.order).sort((a, b) => a.order - b.order);
          const priorBlocked = prior.filter((s) => state.sectionReleases[s.id]?.state !== "已放行");
          const blockReason = priorBlocked.length ? `前行区段 ${priorBlocked.map((s) => s.name).join("、")} 尚未放行` : notNormal.length ? `区段内 ${notNormal.map((s) => s.name).join("、")} 未恢复正常` : "";
          return { color: releaseColor[releaseState], children: <div className="release-row">
            <Space><b>{section.order}. {section.name}</b><Tag color={releaseColor[releaseState]}>{releaseState}</Tag>{release?.generation !== undefined && <Tag>依据第 {release.generation} 代状态</Tag>}</Space>
            <div className="release-stations">{inSection.map((s) => <Tag key={s.id} color={s.status === "正常" ? "green" : s.status === "封闭" ? "red" : s.status === "限流" ? "orange" : "blue"}>{s.name} · {s.status}</Tag>)}</div>
            {releaseState === "已作废" && release?.reason && <p style={{ color: "#e5484d", margin: "4px 0" }}>{release.reason}，需重新放行</p>}
            {releaseState === "已放行" && <p style={{ color: "#18a566", margin: "4px 0" }}>已于 {release.releasedAt ? format(new Date(release.releasedAt), "HH:mm:ss") : ""} 放行（{release.releasedBy}）</p>}
            {blockReason && <p style={{ color: "#b06a00", margin: "4px 0" }}>{blockReason}</p>}
            <Button size="small" type="primary" disabled={releaseState === "已放行" || !!blockReason || state.role === "客服主管"} onClick={() => { const r = state.releaseSection(section.id); if (!r.ok) messageApi.error(r.reason); else messageApi.success(`${section.name} 已放行`); }}>放行该区段</Button>
          </div> };
        })} />
      </Card>}
      {panel === "本地队列" && <Card title="本地队列与合并" extra={<Space><Tag>本机：{state.consoleId}</Tag><Button type="primary" onClick={() => state.syncOutbox()}>按编号合并</Button></Space>}>
        <Table rowKey="id" pagination={false} dataSource={state.outbox} columns={[
          { title: "编号", dataIndex: "id", render: (v: string) => <code>{v.slice(0, 8)}</code> },
          { title: "调度台", dataIndex: "consoleId" },
          { title: "操作", dataIndex: "action" },
          { title: "内容", dataIndex: "detail" },
          { title: "序号", dataIndex: "seq" },
          { title: "状态", dataIndex: "status", render: (v: OutboxStatus) => <Tag color={outboxColor[v]}>{v}</Tag> },
          { title: "失败原因", dataIndex: "error", render: (v?: string) => v ? <span style={{ color: "#e5484d" }}>{v}</span> : "—" },
          { title: "重试", dataIndex: "retries", render: (v: number, record) => <Space><span>{v} 次</span>{record.status === "合并失败" && <Button size="small" onClick={() => state.retryOutbox(record.id)}>重试</Button>}</Space> }
        ]} />
        {!state.outbox.length && <p style={{ color: "#8b95a6" }}>队列为空。弱网或多调度台协同时，操作会先记在本地，回网后按编号合并；合并失败会留住原因，可重试。</p>}
      </Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
