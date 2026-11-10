/**
 * Mock data matching docs/ui/mockups/index.html (Incidents + Incident detail screens) and the
 * seven open incidents of docs/ui/mockups/scope-variants.html (variant E).
 * Clock is frozen at Mon Nov 9 2026 03:16:16 KST so ages match the mockup.
 */
import type {
  IncidentDetail, IncidentEvent, IncidentListItem, NotificationLogEntry, OncallNowEntry, Severity,
} from "../types";
import { orgOf } from "./scope-fixtures";

export const MOCK_NOW = "2026-11-08T18:16:16Z"; // 03:16:16 KST
const KST = (hhmmss: string, day = "2026-11-09") => {
  // KST wall time → ISO UTC
  const [h, m, s = "00"] = hhmmss.split(":");
  const d = new Date(`${day}T${h}:${m}:${s}+09:00`);
  return d.toISOString().replace(".000", "");
};

const MIRAE = "mirae";
const HANBIT = "hanbit";
const DAON = "daon";
const org = orgOf;

export const openIncidents: IncidentListItem[] = [
  {
    id: "inc-7f3a0c91b2d4-20261108181204", number: 5521, key: "INC-20261109-0312-7F3A",
    title: "payments-db-1 FreeStorageSpace below 10 GB", severity: "SEV_1", status: "TRIGGERED", escalated: false,
    org: org(MIRAE, "Core", "Payments API"), unmapped: false,
    awsAccountIds: ["827311046650"], resourceTypes: ["RDS"], source: "CLOUDWATCH", env: "prd", memberCount: 3,
    assignee: { contactId: "ct_haeun", name: "Haeun Kim", via: "on shift in MSP night desk" },
    assigneeNote: "next: call Yuna at 03:22",
    escalation: {
      step: 0, totalSteps: 3, repeat: 0, repeatCount: 1, nextAt: KST("03:22:04"), doneAt: null, baseAt: KST("03:12:04"),
      summary: "call Yuna at 03:22", nextLabel: "Step 2 · call Yuna Seo (Mirae Pay)",
    },
    triggeredAt: KST("03:12:04"), acknowledgedAt: null, resolvedAt: null, version: 4,
  },
  {
    id: "inc-a1b5e2c07d33-20261108180512", number: 5519, key: "INC-20261109-0305-A1B5",
    title: "api-alb 5XX rate above 2%", severity: "SEV_2", status: "TRIGGERED", escalated: true,
    org: org(HANBIT, "Tracking", "Public API"), unmapped: false,
    awsAccountIds: ["330188124407"], resourceTypes: ["ALB"], source: "CLOUDWATCH", env: "prd", memberCount: 2,
    assignee: { contactId: "ct_junho", name: "Junho Park", via: "on shift in Hanbit on-call" },
    assigneeNote: "on shift in Hanbit on-call · called 03:12",
    escalation: {
      step: 2, totalSteps: 4, repeat: 0, repeatCount: 1, nextAt: KST("03:17:04"), doneAt: null, baseAt: KST("03:12:04"),
      summary: "everyone in 1m", nextLabel: "Step 4 · call everyone in Responders (4) · Hanbit Logistics",
    },
    triggeredAt: KST("03:05:12"), acknowledgedAt: null, resolvedAt: null, version: 7,
  },
  {
    id: "inc-0d9c71f4e8a2-20261108181401", number: 5522, key: "INC-20261109-0314-0D9C",
    title: "node-exporter: KubeNodeNotReady on ip-10-2-14-77", severity: "SEV_2", status: "TRIGGERED", escalated: false,
    org: org(DAON, "Platform", "EKS prod"), unmapped: false,
    awsAccountIds: [], resourceTypes: ["Node"], source: "PROMETHEUS", memberCount: 1,
    assignee: { contactId: "ct_junho", name: "Junho, Minjae, Soyeon", via: "all at once" },
    assigneeNote: "all at once · next: call all 3 at 7 min",
    escalation: {
      step: 1, totalSteps: 3, repeat: 0, repeatCount: 1, nextAt: KST("03:21:01"), doneAt: null, baseAt: KST("03:14:01"),
      summary: "Slack + SMS sent",
    },
    triggeredAt: KST("03:14:01"), acknowledgedAt: null, resolvedAt: null, version: 2,
  },
  {
    id: "inc-55e0a7b19c4f-20261108175002", number: 5516, key: "INC-20261109-0250-55E0",
    title: "3 alarms from unmapped account", severity: "SEV_3", status: "TRIGGERED", escalated: false,
    org: org(null), unmapped: true, awsAccountIds: ["481220935017"], resourceTypes: ["EC2"], source: "CLOUDWATCH",
    memberCount: 3, assignee: null, escalation: null,
    triggeredAt: KST("02:50:02"), acknowledgedAt: null, resolvedAt: null, version: 3,
  },
  {
    id: "inc-c3e8d02f6a71-20261108175710", number: 5517, key: "INC-20261109-0257-C3E8",
    title: "batch-worker-3 CPUUtilization above 90%", severity: "SEV_3", status: "ACKNOWLEDGED", escalated: false,
    org: org(HANBIT, "Ops", "Batch"), unmapped: false,
    awsAccountIds: ["330188124407"], resourceTypes: ["EC2"], source: "CLOUDWATCH", env: "prd", memberCount: 1,
    assignee: { contactId: "ct_haeun", name: "Haeun Kim" }, assigneeNote: "ack'd 02:58",
    escalation: { step: 0, totalSteps: 3, repeat: 0, repeatCount: 1, nextAt: null, doneAt: KST("02:58:00"), summary: "stopped · re-notify 03:58" },
    triggeredAt: KST("02:57:10"), acknowledgedAt: KST("02:58:00"), resolvedAt: null, version: 5,
  },
  {
    id: "inc-9b2f4410ed58-20261108173802", number: 5514, key: "INC-20261109-0238-9B2F",
    title: "grafana: Checkout p95 latency above 800 ms", severity: "SEV_4", status: "ACKNOWLEDGED", escalated: false,
    org: org(DAON, "Commerce", "Checkout"), unmapped: false,
    awsAccountIds: [], resourceTypes: ["Service"], source: "GRAFANA", memberCount: 4,
    assignee: { contactId: "ct_minjae", name: "Minjae Lee" }, assigneeNote: "ack'd 02:41",
    escalation: { step: 0, totalSteps: 3, repeat: 0, repeatCount: 1, nextAt: null, doneAt: KST("02:41:00"), summary: "stopped" },
    triggeredAt: KST("02:38:02"), acknowledgedAt: KST("02:41:00"), resolvedAt: null, version: 6,
  },
  {
    id: "inc-4e1d90a3c7b6-20261108171940", number: 5511, key: "INC-20261109-0219-4E1D",
    title: "web-1 CPUUtilization above 80%", severity: "SEV_4", status: "ACKNOWLEDGED", escalated: false,
    org: org("bora", "Main", "Web"), unmapped: false,
    awsAccountIds: ["560914472281"], resourceTypes: ["EC2"], source: "CLOUDWATCH", env: "prd", memberCount: 1,
    assignee: { contactId: "ct_haeun", name: "Haeun Kim" }, assigneeNote: "ack'd 02:20",
    escalation: { step: 0, totalSteps: 4, repeat: 0, repeatCount: 1, nextAt: null, doneAt: KST("02:20:50"), summary: "stopped" },
    triggeredAt: KST("02:19:40"), acknowledgedAt: KST("02:20:50"), resolvedAt: null, version: 3,
  },
];

/** 17 resolved in the last 24h: 9 auto, 8 manual (tile "9 auto · 8 manual"). */
const RESOLVED_TITLES: [string, Severity, string, string, string][] = [
  ["orders-api-1 CPUUtilization above 85%", "SEV_3", HANBIT, "Ops", "EC2"],
  ["checkout-redis CurrConnections above 5k", "SEV_3", DAON, "Commerce", "ElastiCache"],
  ["ledger-aurora-r1 ReplicaLag above 30s", "SEV_2", MIRAE, "Core", "RDS"],
  ["tracking-queue ApproximateAgeOfOldestMessage", "SEV_3", HANBIT, "Tracking", "SQS"],
  ["grafana: Search p99 latency above 1.2 s", "SEV_4", DAON, "Commerce", "Grafana"],
  ["payments-lambda Errors above 5", "SEV_2", MIRAE, "Core", "Lambda"],
  ["batch-worker-1 StatusCheckFailed", "SEV_1", HANBIT, "Ops", "EC2"],
  ["node-exporter: KubeletDown on ip-10-2-11-9", "SEV_2", DAON, "Commerce", "Prometheus"],
  ["api-alb TargetResponseTime above 2 s", "SEV_3", HANBIT, "Tracking", "ALB"],
  ["payments-db-1 CPUUtilization above 80%", "SEV_3", MIRAE, "Core", "RDS"],
  ["checkout-api 5XX above 1%", "SEV_2", DAON, "Commerce", "ALB"],
  ["batch-worker-2 mem_used_percent above 80%", "SEV_4", HANBIT, "Ops", "EC2"],
  ["ledger-aurora-r1 FreeableMemory below 1 GB", "SEV_3", MIRAE, "Core", "RDS"],
  ["grafana: Cart error ratio above 2%", "SEV_4", DAON, "Commerce", "Grafana"],
  ["tracking-api Disk_root above 85%", "SEV_3", HANBIT, "Tracking", "EC2"],
  ["payments-cache Evictions above 100", "SEV_5", MIRAE, "Core", "ElastiCache"],
  ["node-exporter: NodeFilesystemAlmostFull", "SEV_3", DAON, "Commerce", "Prometheus"],
];

export const resolvedIncidents: IncidentListItem[] = RESOLVED_TITLES.map(([title, severity, cus, project, rtype], i) => {
  const h = 2 + Math.floor(i * 1.3);
  const trig = new Date(new Date(MOCK_NOW).getTime() - h * 3600_000).toISOString().replace(".000", "");
  const res = new Date(new Date(trig).getTime() + (12 + i) * 60_000).toISOString().replace(".000", "");
  const auto = i % 2 === 0; // 9 auto, 8 manual
  return {
    id: `inc-r${String(i).padStart(2, "0")}`, number: 5490 + i, key: `INC-R-${5490 + i}`, title, severity,
    status: "RESOLVED", escalated: false,
    org: org(cus, project), unmapped: false,
    awsAccountIds: [], resourceTypes: [rtype],
    source: rtype === "Prometheus" ? "PROMETHEUS" : rtype === "Grafana" ? "GRAFANA" : "CLOUDWATCH",
    memberCount: 1 + (i % 3),
    assignee: auto ? null : { contactId: "ct_haeun", name: "Haeun Kim" },
    assigneeNote: auto ? "resolved automatically" : "resolved by Haeun Kim",
    escalation: null, triggeredAt: trig, acknowledgedAt: auto ? null : trig, resolvedAt: res, version: 3,
    resolvedVia: auto ? "AUTO" : "MANUAL",
  };
});

/** Alerts muted by maintenance windows (tile "Muted 5 · 2 maintenance windows"). */
export const mutedAlerts: { customerId: string; severity: Severity; windowId: string }[] = [
  { customerId: "cus_hanbit", severity: "SEV_3", windowId: "mw_1" },
  { customerId: "cus_hanbit", severity: "SEV_3", windowId: "mw_1" },
  { customerId: "cus_hanbit", severity: "SEV_4", windowId: "mw_1" },
  { customerId: "cus_daon", severity: "SEV_2", windowId: "mw_2" },
  { customerId: "cus_daon", severity: "SEV_5", windowId: "mw_2" },
];

export const unmappedAccounts = [{ awsAccountId: "481220935017", alertCount: 3 }];

export const oncallNow: OncallNowEntry[] = [
  { contactId: "ct_haeun", name: "Haeun Kim", initials: "HK", rotation: "MSP night desk", detail: "6 customers · until Mon 9 09:00", openCount: 2 },
  { contactId: "ct_taemin", name: "Taemin Jung", initials: "TJ", rotation: "Data desk", detail: "Mirae Pay · until Mon 9 09:00", openCount: 0 },
  { contactId: "ct_junho", name: "Junho Park", initials: "JP", rotation: "Hanbit on-call", detail: "Hanbit Logistics · until Mon 9 10:00", openCount: 1 },
  { contactId: "ct_kyungmin", name: "Kyungmin Oh", initials: "KO", rotation: "Lumen on-call", detail: "Lumen Bank · until Mon 9 10:00", openCount: 0 },
  { contactId: null, name: "All at once", initials: "All", rotation: "", detail: "Daon Retail · Cheong Media · Eden Mobility · Jeil Insure · Kumho Clinic", openCount: 2 },
  { contactId: null, name: "No owner", initials: "–", rotation: "", detail: "Unmapped account 481220935017", openCount: 1 },
];

/* ---------------- Incident detail: payments-db-1 ---------------- */

const PAY_ID = openIncidents[0]!.id;

export const paymentsDetailExtra: Omit<IncidentDetail, keyof IncidentListItem> = {
  region: "ap-northeast-2",
  alerts: [
    { id: "al_1", fingerprint: "cloudwatch:827311046650:827311046650#payments-db-1#FreeStorageSpace", title: "payments-db-1 FreeStorageSpace below 10 GB", status: "FIRING", severity: "SEV_1", metricKey: "FreeStorageSpace", resourceId: "res_paydb1", value: 7.94e9, threshold: 1e10, eventCount: 3, lastEventAt: KST("03:15:00") },
    { id: "al_2", fingerprint: "cloudwatch:827311046650:827311046650#payments-db-1#WriteLatency", title: "payments-db-1 WriteLatency above 50 ms", status: "FIRING", severity: "SEV_2", metricKey: "WriteLatency", resourceId: "res_paydb1", value: 0.071, threshold: 0.05, eventCount: 2, lastEventAt: KST("03:14:00") },
    { id: "al_3", fingerprint: "cloudwatch:827311046650:827311046650#payments-db-1#DiskQueueDepth", title: "payments-db-1 DiskQueueDepth above 20", status: "FIRING", severity: "SEV_3", metricKey: "DiskQueueDepth", resourceId: "res_paydb1", value: 31, threshold: 20, eventCount: 1, lastEventAt: KST("03:12:00") },
  ],
  assignmentSnapshot: {
    capturedAt: KST("03:12:04"), pagingConfigId: "pc_mirae", planLabel: "Custom steps · Urgent (edited)", level: "CUSTOMER", repeatCount: 1,
    steps: [
      { index: 0, atMin: 0, targetType: "ROTATION", targetId: "rot_night", resolved: [{ contactId: "ct_haeun", name: "Haeun Kim", via: "on shift in MSP night desk" }], channels: ["SLACK_BOT", "VOICE"] },
      { index: 1, atMin: 10, targetType: "PERSON", targetId: "ct_yuna", resolved: [{ contactId: "ct_yuna", name: "Yuna Seo", via: "Mirae Pay" }], channels: ["VOICE"] },
      { index: 2, atMin: 15, targetType: "ALL_RESPONDERS", resolved: [], channels: ["VOICE"], label: "everyone in Responders (5)" },
    ],
  },
  why: {
    metricKey: "FreeStorageSpace", statistic: "Minimum", periodLabel: "5m", current: "7.4 GB", threshold: "< 10 GB",
    thresholdSource: "CONSOLE", thresholdSourceNote: "set by Minjae Lee · Nov 4",
    evaluation: "1 / 1", evaluationSource: "CODE", evaluationNote: "SEV-1 is locked",
    reason: "Threshold Crossed: 1 datapoint [7.94E9 (09/11/26 03:11:00)] was less than the threshold (1.0E10).",
    series: [12.6, 12.5, 12.4, 12.3, 12.2, 12.0, 11.9, 11.6, 11.2, 10.8, 10.2, 9.6, 9.2, 7.4],
    seriesThreshold: 10, seriesLabels: ["00:15", "01:45", "03:15"], resourceId: "res_paydb1",
  },
  suppression: [
    { at: KST("03:12:05"), alertId: "al_1", reason: "Duplicate", detail: "payments-db-1 FreeStorageSpace repeated within 5m dedup window" },
  ],
  remediation: {
    id: "REQ-5521", mode: "APPROVAL", action: "Stop RDS instance", target: "payments-db-1",
    trigger: "ModifyDBInstance PubliclyAccessible=true by arn:aws:iam::827311046650:user/ci-deploy at 03:09",
    stage: "PENDING_APPROVAL", notifiedAt: KST("03:09:00"), expiresAt: KST("03:42:00"),
    approvers: ["Yuna Seo (Mirae Pay)"], slackThreadUrl: "https://slack.com/app_redirect?channel=mirae-ops", slackChannel: "#mirae-ops",
  },
  rcaPlaceholder: { availableAfterPoc: true },
  details: {
    source: "CloudWatch", resource: "payments-db-1", alarm: "[RDS] payments-db-1 FreeStorageSpace (TagName: payments-db-1)",
    runbookUrl: "https://runbooks.example.com/rds-storage-full", runbookLabel: "RDS storage full", lastTime: "Oct 21 · resolved by Haeun · CONFIG",
  },
  paged: [
    { label: "Slack + call Haeun", at: KST("03:12:06"), done: true },
    { label: "call Yuna", at: KST("03:22:04"), done: false },
    { label: "call everyone in Responders (5)", at: KST("03:27:04"), done: false },
  ],
  notificationCount: 6,
};

export const timelines: Record<string, IncidentEvent[]> = {
  [PAY_ID]: [
    { id: "ev4", at: KST("03:12:07"), kind: "NOTIFIED", actorType: "SYSTEM", actorId: null, message: "Email to Mirae Pay people (notify only): Seojun Bae, Hana Noh, Hyejin Lim", detail: "Notified for Core or all of Mirae Pay" },
    { id: "ev3", at: KST("03:12:06"), kind: "NOTIFIED", actorType: "SYSTEM", actorId: null, message: "Slack + call to #mirae-ops and Haeun Kim (on shift in MSP night desk)", detail: "Step 1 of 3 · Custom steps" },
    { id: "ev2", at: KST("03:12:05"), kind: "SUPPRESSED", actorType: "SYSTEM", actorId: null, message: "1 alert suppressed as duplicate", detail: "payments-db-1 FreeStorageSpace repeated within 5m dedup window" },
    { id: "ev1", at: KST("03:12:04"), kind: "TRIGGERED", actorType: "SYSTEM", actorId: null, message: "Triggered — group of 3 alerts (Mirae Pay · SEV-1) closed after 30s", detail: "Paging steps at open: Haeun → Yuna → everyone in Responders (5)" },
  ],
};

export const notifications: Record<string, NotificationLogEntry[]> = {
  [PAY_ID]: [
    { id: "nl6", at: KST("03:12:07"), channel: "EMAIL", status: "SENT", targetSummary: "Hyejin Lim", escalationStep: 0, error: null },
    { id: "nl5", at: KST("03:12:07"), channel: "EMAIL", status: "SENT", targetSummary: "Hana Noh", escalationStep: 0, error: null },
    { id: "nl4", at: KST("03:12:07"), channel: "EMAIL", status: "SENT", targetSummary: "Seojun Bae", escalationStep: 0, error: null },
    { id: "nl3", at: KST("03:12:06"), channel: "VOICE", status: "SENT", targetSummary: "Haeun Kim", escalationStep: 0, error: null },
    { id: "nl2", at: KST("03:12:06"), channel: "SLACK_DM", status: "SENT", targetSummary: "Haeun Kim", escalationStep: 0, error: null },
    { id: "nl1", at: KST("03:12:06"), channel: "SLACK_BOT", status: "SENT", targetSummary: "#mirae-ops", escalationStep: 0, error: null },
  ],
};
