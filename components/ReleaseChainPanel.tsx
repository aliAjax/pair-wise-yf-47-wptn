"use client";

import { useState } from "react";
import { App as AntApp, Alert, Button, Card, Empty, List, Popconfirm, Select, Space, Steps, Table, Tag } from "antd";
import { format } from "date-fns";
import type { ColumnsType } from "antd/es/table";
import { derivePlanGate, deriveSectionChain, describeOp, mergeOrder, type Op, type QueuedOp, type SectionGate } from "../lib/releaseChain";
import { useIncidentStore, type ShuttlePlan } from "../store/incident";

const opTypeLabel: Record<Op["type"], string> = {
  "station.restore": "恢复车站",
  "station.status": "变更状态",
  "section.release": "区段放行",
  "shuttle.withdraw": "安排收车"
};

const gateColor: Record<SectionGate, string> = { 已放行: "green", 可放行: "processing", 待恢复: "error", 待前段放行: "default" };
const gateStepStatus: Record<SectionGate, "finish" | "process" | "error" | "wait"> = { 已放行: "finish", 可放行: "process", 待恢复: "error", 待前段放行: "wait" };

const stationTagColor = (status: string) => (status === "正常" ? "green" : status === "恢复中" ? "blue" : status === "限流" ? "orange" : "red");

const time = (value: string) => format(new Date(value), "HH:mm:ss");

export function ReleaseChainPanel() {
  const state = useIncidentStore();
  const { message } = AntApp.useApp();
  const [peerStation, setPeerStation] = useState<string>();

  const chain = deriveSectionChain(state.sections, state.stations, state.releases, state.stationRevision);
  const queue = mergeOrder(state.pendingOps);
  const executedPlans = state.plans.filter((plan) => plan.status === "已执行");

  const report = (result: { ok: boolean; reason?: string; queued?: boolean }, okText: string) => {
    if (!result.ok) message.error(result.reason);
    else if (result.queued) message.info("弱网：已记入本地队列，回网后按编号合并");
    else message.success(okText);
  };

  const mergeNow = () => {
    state.syncQueue();
    const failed = useIncidentStore.getState().pendingOps.filter((op) => op.state === "失败").length;
    if (failed) message.warning(`合并完成，${failed} 条未通过校验，原因已保留，可重试`);
    else message.success("已按编号合并，全部生效");
  };

  const retry = (id: string) => {
    state.retryOp(id);
    const op = useIncidentStore.getState().pendingOps.find((item) => item.id === id);
    if (op?.state === "失败") message.error(`重试仍未通过：${op.error}`);
    else message.success("重试已生效");
  };

  const queueColumns: ColumnsType<QueuedOp> = [
    { title: "编号", render: (_, record) => <span>#{record.seq} · {record.consoleId}</span> },
    { title: "类型", render: (_, record) => opTypeLabel[record.type] },
    { title: "内容", render: (_, record) => describeOp(record, state.stations, state.sections) },
    { title: "状态", dataIndex: "state", render: (value: QueuedOp["state"]) => <Tag color={value === "失败" ? "red" : "orange"}>{value}</Tag> },
    { title: "失败原因", dataIndex: "error", render: (value?: string) => value ?? "—" },
    {
      title: "操作",
      render: (_, record) => (
        <Button size="small" disabled={record.state !== "失败" || !state.online} onClick={() => retry(record.id)}>
          重试
        </Button>
      )
    }
  ];

  return (
    <section>
      <Alert
        className="chain-note"
        type="info"
        showIcon
        message="放行链规则"
        description="区段按顺序放行：本区段车站全部恢复正常且前序区段已放行，才能放行本区段；接驳车覆盖的车站全部正常才可安排收车；车站状态一变，放行结论与收车安排立即作废。"
      />
      <div className="chain-grid">
        <Card title="区段放行链">
          <Steps
            direction="vertical"
            current={-1}
            items={chain.map((view) => ({
              status: gateStepStatus[view.gate],
              title: (
                <Space>
                  {view.section.name}
                  <Tag color={gateColor[view.gate]}>{view.gate}</Tag>
                </Space>
              ),
              description: (
                <div className="chain-step">
                  <Space wrap size={4}>
                    {view.stations.map((station) => (
                      <Tag key={station.id} color={stationTagColor(station.status)}>
                        {station.name}·{station.status}
                      </Tag>
                    ))}
                  </Space>
                  {view.gate === "待恢复" && <p>未恢复正常：{view.blocking.map((station) => station.name).join("、")}，本站区段及后续区段等待</p>}
                  {view.gate === "待前段放行" && <p>车站已全部恢复正常，等待前序区段先行放行</p>}
                  {view.release && <small>放行于 {time(view.release.releasedAt)} · {view.release.by}</small>}
                  {view.gate === "可放行" && (
                    <p>
                      <Button size="small" type="primary" disabled={state.role !== "调度员"} onClick={() => report(state.releaseSection(view.section.id), `区段 ${view.section.name} 已放行`)}>
                        放行本区段
                      </Button>
                      {state.role !== "调度员" && <small> 仅调度员可放行</small>}
                    </p>
                  )}
                </div>
              )
            }))}
          />
        </Card>
        <Card title="接驳收车联动">
          {executedPlans.length === 0 && <Empty description="暂无执行中的接驳计划" />}
          <List
            dataSource={executedPlans}
            renderItem={(plan: ShuttlePlan) => {
              const view = derivePlanGate(plan, state.stations, state.withdrawals, state.stationRevision);
              return (
                <List.Item
                  actions={[
                    view.gate === "可收车" && !view.withdrawal ? (
                      <Button key="arrange" size="small" type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => report(state.planWithdrawal(plan.id), "已安排收车")}>
                        安排收车
                      </Button>
                    ) : null,
                    view.withdrawal?.status === "待收车" ? (
                      <Popconfirm key="confirm" title="确认接驳车收车？" onConfirm={() => report(state.confirmWithdrawal(plan.id), "接驳车已收车")}>
                        <Button size="small" type="primary">确认收车</Button>
                      </Popconfirm>
                    ) : null
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        {plan.stations.join(" → ")}
                        <Tag color={view.gate === "已收车" ? "green" : view.gate === "可收车" ? "processing" : "orange"}>{view.gate}</Tag>
                        {view.withdrawal?.status === "待收车" && <Tag color="blue">待收车</Tag>}
                      </Space>
                    }
                    description={
                      view.gate === "服务中"
                        ? `覆盖车站未全部恢复：${view.blocking.map((station) => `${station.name}（${station.status}）`).join("、")}，接驳车继续服务`
                        : view.gate === "可收车"
                          ? "覆盖车站已全部恢复正常，可以安排收车"
                          : view.gate === "已收车"
                            ? "接驳车已收车，运力撤回"
                            : "计划未执行"
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>
      </div>
      <div className="chain-grid-2">
        <Card
          title="本地操作队列"
          extra={
            <Space>
              <Select
                size="small"
                placeholder="对端恢复车站"
                style={{ width: 140 }}
                value={peerStation}
                onChange={setPeerStation}
                options={state.stations.filter((station) => station.status !== "正常").map((station) => ({ value: station.id, label: station.name }))}
              />
              <Button
                size="small"
                disabled={!peerStation}
                onClick={() => {
                  if (!peerStation) return;
                  state.injectPeerRestore(peerStation);
                  setPeerStation(undefined);
                  message.info("对端调度台-B 已提交恢复，按编号合并，先到先生效");
                }}
              >
                模拟对端提交
              </Button>
              <Button size="small" type="primary" disabled={!state.online || (!state.pendingOps.length && !state.remoteInbox.length)} onClick={mergeNow}>
                回网合并
              </Button>
            </Space>
          }
        >
          {queue.length === 0 && state.remoteInbox.length === 0 ? (
            <Empty description="本地队列为空" />
          ) : (
            <Table rowKey="id" size="small" pagination={false} dataSource={queue} columns={queueColumns} />
          )}
          {state.remoteInbox.length > 0 && <p>对端待合并 {state.remoteInbox.length} 条，回网后按编号一起合并。</p>}
        </Card>
        <Card title={`待协调（${state.coordination.length}）`}>
          {state.coordination.length === 0 ? (
            <Empty description="暂无落选待协调操作" />
          ) : (
            <List
              dataSource={state.coordination}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button key="resubmit" size="small" onClick={() => state.resubmitCoordination(item.id)}>重新提交</Button>,
                    <Button key="dismiss" size="small" danger onClick={() => state.dismissCoordination(item.id)}>撤销</Button>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag>{item.op.consoleId}</Tag>
                        {describeOp(item.op, state.stations, state.sections)}
                      </Space>
                    }
                    description={`${item.reason} · ${time(item.time)}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
        <Card title="作废记录">
          {state.voidLog.length === 0 ? (
            <Empty description="暂无作废记录" />
          ) : (
            <List
              dataSource={state.voidLog}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={<Tag color={item.kind === "放行作废" ? "volcano" : "gold"}>{item.kind}</Tag>}
                    description={`${item.detail} · ${time(item.time)}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
    </section>
  );
}
