-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "ConsoleRole" AS ENUM ('VIEWER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('INTERNAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('CUSTOMER', 'PROJECT', 'SERVICE');

-- CreateEnum
CREATE TYPE "AssignmentScope" AS ENUM ('CUSTOMER', 'PROJECT', 'SERVICE', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "ContactScopeRole" AS ENUM ('NOTIFY', 'APPROVER', 'PORTAL_USER');

-- CreateEnum
CREATE TYPE "ResponderRole" AS ENUM ('PAGEABLE', 'NOTIFY_ONLY');

-- CreateEnum
CREATE TYPE "ResponderSource" AS ENUM ('TEMPLATE', 'DIRECT');

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('PRD', 'STG', 'DEV');

-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('UNKNOWN', 'OK', 'DENIED', 'MISSING');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('CLOUDWATCH', 'PROMETHEUS', 'GRAFANA');

-- CreateEnum
CREATE TYPE "EventState" AS ENUM ('FIRING', 'RESOLVED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('FIRING', 'ACKNOWLEDGED', 'RESOLVED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('SEV_1', 'SEV_2', 'SEV_3', 'SEV_4', 'SEV_5');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('NOTIFY', 'SUPPRESS', 'DEFER');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('OPEN', 'CLOSED', 'FINALIZED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ResolvedVia" AS ENUM ('MANUAL', 'AUTO', 'RECONCILE');

-- CreateEnum
CREATE TYPE "IncidentEventKind" AS ENUM ('TRIGGERED', 'MERGED', 'ACKED', 'RESOLVED', 'ESCALATED', 'NOTIFIED', 'RENOTIFIED', 'SUPPRESSED', 'MUTED', 'REMEDIATION', 'NOTE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'CONTACT', 'SYSTEM', 'PROVIDER');

-- CreateEnum
CREATE TYPE "ResolutionVia" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "ResolutionKind" AS ENUM ('RESTART', 'CONFIG', 'AUTO', 'OTHER');

-- CreateEnum
CREATE TYPE "MaintenanceScope" AS ENUM ('CUSTOMER', 'PROJECT', 'SERVICE', 'ACCOUNT', 'RESOURCE_TYPE', 'ALERT');

-- CreateEnum
CREATE TYPE "MonitoringTag" AS ENUM ('ON', 'OFF', 'ABSENT');

-- CreateEnum
CREATE TYPE "MonitoringState" AS ENUM ('MONITORED', 'NEEDS_REVIEW', 'NOT_MONITORED', 'DELETED');

-- CreateEnum
CREATE TYPE "TagSetBy" AS ENUM ('CUSTOMER', 'CONSOLE');

-- CreateEnum
CREATE TYPE "DefaultLevel" AS ENUM ('MSP', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "Statistic" AS ENUM ('Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount');

-- CreateEnum
CREATE TYPE "ValueSource" AS ENUM ('CODE', 'MSP', 'CUSTOMER', 'CONSOLE', 'TAG');

-- CreateEnum
CREATE TYPE "AlarmState" AS ENUM ('OK', 'ALARM', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "DriftStatus" AS ENUM ('IN_SYNC', 'DRIFTED', 'MISSING', 'EXTERNAL_CHANGE');

-- CreateEnum
CREATE TYPE "ChangeTarget" AS ENUM ('ALARM', 'CUSTOMER_DEFAULT', 'MSP_DEFAULT', 'SEVERITY', 'MONITORING_TAG');

-- CreateEnum
CREATE TYPE "ChangeField" AS ENUM ('THRESHOLD', 'EVAL', 'OFF', 'SEVERITY', 'MONITORING');

-- CreateEnum
CREATE TYPE "ChangeActorType" AS ENUM ('USER', 'SYSTEM', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ApplyStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'SKIPPED_TAG_WINS');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('DAILY', 'TAG_RECONCILE', 'ON_DEMAND', 'CLOUDTRAIL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "RemediationMode" AS ENUM ('NOTIFY_ONLY', 'APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "RemediationAction" AS ENUM ('EC2_STOP', 'RDS_STOP', 'ELB_DELETE');

-- CreateEnum
CREATE TYPE "RemediationStatus" AS ENUM ('NOTIFIED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RotationScope" AS ENUM ('MSP', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "Cadence" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "OverrideKind" AS ENUM ('COVER', 'SWAP');

-- CreateEnum
CREATE TYPE "OverrideStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BulkChangeKind" AS ENUM ('LEAVE_REPLACE', 'ADD_STAFF', 'TEMPLATE_UPDATE');

-- CreateEnum
CREATE TYPE "PagingStyle" AS ENUM ('ALL_AT_ONCE', 'CUSTOMER_ROTATION', 'SHARED_ROTATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PagingPlan" AS ENUM ('STANDARD', 'URGENT', 'QUIET');

-- CreateEnum
CREATE TYPE "StepTargetType" AS ENUM ('PERSON', 'ROTATION', 'ALL_RESPONDERS');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('SLACK_BOT', 'SLACK_WEBHOOK', 'EMAIL');

-- CreateEnum
CREATE TYPE "VerifyChannel" AS ENUM ('EMAIL', 'SMS', 'SLACK');

-- CreateEnum
CREATE TYPE "NotificationPurpose" AS ENUM ('INITIAL', 'ESCALATION', 'RENOTIFY', 'RESOLVED', 'DIGEST', 'REMEDIATION_APPROVAL');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('SLACK_BOT', 'SLACK_WEBHOOK', 'SLACK_DM', 'EMAIL', 'SMS', 'VOICE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "SlackMessageKind" AS ENUM ('INCIDENT', 'DIGEST', 'DM', 'REMEDIATION');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'CONTACT', 'SYSTEM', 'SLACK');

-- CreateEnum
CREATE TYPE "TickStatus" AS ENUM ('OK', 'ERROR');

-- CreateTable
CREATE TABLE "MspOrg" (
    "id" TEXT NOT NULL DEFAULT 'msp',
    "name" TEXT NOT NULL,
    "defaultSlackChannelId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MspOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT,
    "role" "ConsoleRole" NOT NULL DEFAULT 'OPERATOR',
    "seeAll" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "customerId" TEXT,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "slackUserId" TEXT,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "phoneVerifiedAt" TIMESTAMPTZ(3),
    "slackVerifiedAt" TIMESTAMPTZ(3),
    "emailVerifiedVia" TEXT,
    "phoneVerifiedVia" TEXT,
    "slackVerifiedVia" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactScope" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "role" "ContactScopeRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Responder" (
    "customerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" "ResponderRole" NOT NULL DEFAULT 'PAGEABLE',
    "source" "ResponderSource" NOT NULL DEFAULT 'DIRECT',
    "templateId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Responder_pkey" PRIMARY KEY ("customerId","contactId")
);

-- CreateTable
CREATE TABLE "ResponderTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ResponderTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResponderTemplateMember" (
    "templateId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    CONSTRAINT "ResponderTemplateMember_pkey" PRIMARY KEY ("templateId","contactId")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "loginDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "portalGrants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultGroupWaitSec" INTEGER,
    "responderTemplateId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceId" TEXT,
    "awsAccountId" CHAR(12) NOT NULL,
    "alias" TEXT,
    "environment" "Environment",
    "regions" TEXT[] DEFAULT ARRAY['ap-northeast-2']::TEXT[],
    "externalId" TEXT NOT NULL,
    "readerRoleArn" TEXT NOT NULL,
    "eventForwarderRoleArn" TEXT NOT NULL,
    "alarmWriterRoleArn" TEXT,
    "tagWriterRoleArn" TEXT,
    "remediatorRoleArn" TEXT,
    "alarmWriterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tagWriterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "remediatorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "readerStatus" "RoleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "eventForwarderStatus" "RoleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "alarmWriterStatus" "RoleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "tagWriterStatus" "RoleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "remediatorStatus" "RoleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMPTZ(3),
    "firstEventAt" TIMESTAMPTZ(3),
    "lastEventAt" TIMESTAMPTZ(3),
    "stackVersion" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "scopeType" "AssignmentScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "namespace" TEXT,
    "metric" TEXT,
    "resource" TEXT,
    "severities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceId" TEXT,
    "pagingConfigId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSource" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT,
    "tokenPrefix" CHAR(4),
    "tokenRotatedAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastReceivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "IntegrationSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestRejection" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "sourceId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "awsAccountId" TEXT,
    "topicArn" TEXT,
    "title" TEXT,

    CONSTRAINT "IngestRejection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEvent" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "customerId" TEXT,
    "sourceId" TEXT,
    "source" "SourceKind" NOT NULL,
    "awsAccountId" TEXT,
    "region" TEXT,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL,
    "state" "EventState" NOT NULL,
    "previousState" TEXT,
    "severity" "Severity" NOT NULL,
    "severityRaw" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "decision" "Decision",
    "decisionReason" TEXT,
    "finalAction" "Decision",
    "finalReason" TEXT,
    "finalizedAt" TIMESTAMPTZ(3),
    "groupId" TEXT,
    "alertId" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "parseError" TEXT,

    CONSTRAINT "RawEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL,
    "customerId" TEXT,
    "sourceId" TEXT,
    "source" "SourceKind" NOT NULL,
    "awsAccountId" TEXT,
    "region" TEXT,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "metricKey" TEXT,
    "namespace" TEXT,
    "title" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "severity" "Severity" NOT NULL,
    "severityRaw" TEXT,
    "value" DECIMAL(65,30),
    "threshold" DECIMAL(65,30),
    "comparison" TEXT,
    "lastNotifiedAt" TIMESTAMPTZ(3),
    "episodeOpen" BOOLEAN NOT NULL DEFAULT false,
    "episodeStartedAt" TIMESTAMPTZ(3),
    "episodeNotified" BOOLEAN NOT NULL DEFAULT false,
    "recentEpisodes" TIMESTAMPTZ(3)[] DEFAULT ARRAY[]::TIMESTAMPTZ(3)[],
    "quarantinedUntil" TIMESTAMPTZ(3),
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastEventAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertGroup" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "customerId" TEXT,
    "severity" "Severity" NOT NULL,
    "status" "GroupStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "groupWaitSec" INTEGER NOT NULL,
    "closeAt" TIMESTAMPTZ(3) NOT NULL,
    "pauseUntil" TIMESTAMPTZ(3),
    "staleAfter" TIMESTAMPTZ(3) NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),
    "sweptReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AlertGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "customerId" TEXT,
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'TRIGGERED',
    "triggeredAt" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "acknowledgedBy" TEXT,
    "resolvedBy" TEXT,
    "resolvedVia" "ResolvedVia",
    "mttaSec" INTEGER,
    "mttrSec" INTEGER,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resourceTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignmentSnapshot" JSONB,
    "pagingConfigId" TEXT,
    "escalationStep" INTEGER NOT NULL DEFAULT 0,
    "escalationRepeat" INTEGER NOT NULL DEFAULT 0,
    "escalationBaseAt" TIMESTAMPTZ(3),
    "escalationDoneAt" TIMESTAMPTZ(3),
    "renotifiedAt" TIMESTAMPTZ(3),
    "rcaPlaceholder" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "isMergeTarget" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAlert" (
    "incidentId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "customerId" TEXT,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "IncidentAlert_pkey" PRIMARY KEY ("incidentId","alertId")
);

-- CreateTable
CREATE TABLE "IncidentEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "customerId" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "IncidentEventKind" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "incidentId" TEXT NOT NULL,
    "alertId" TEXT,
    "via" "ResolutionVia" NOT NULL,
    "kind" "ResolutionKind",
    "note" TEXT,
    "serviceId" TEXT,
    "metricKey" TEXT,
    "resourceId" TEXT,
    "durationSec" INTEGER NOT NULL,
    "escalationStep" INTEGER NOT NULL,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(3) NOT NULL,
    "recurredAt" TIMESTAMPTZ(3),

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionPolicy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "repeatIntervalSec" INTEGER NOT NULL DEFAULT 900,
    "flappingPerDay" INTEGER NOT NULL DEFAULT 3,
    "flappingWindowDays" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "flappingQuarantineSec" INTEGER NOT NULL DEFAULT 3600,
    "groupWaitSec" INTEGER NOT NULL DEFAULT 30,
    "autoPauseSec" JSONB NOT NULL DEFAULT '{}',
    "renotifyAfterSec" INTEGER NOT NULL DEFAULT 3600,
    "incidentMergeMaxSec" INTEGER NOT NULL DEFAULT 21600,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SuppressionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "scopeType" "MaintenanceScope" NOT NULL,
    "scopeId" TEXT,
    "resourceType" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeverityMapping" (
    "id" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SeverityMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cloudAccountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceArn" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "name" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "monitoringTag" "MonitoringTag" NOT NULL DEFAULT 'ABSENT',
    "monitoringState" "MonitoringState" NOT NULL DEFAULT 'NOT_MONITORED',
    "needsReviewSince" TIMESTAMPTZ(3),
    "needsReviewReason" TEXT,
    "monitoringTagSetBy" "TagSetBy",
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "discoveryRunId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThresholdDefault" (
    "id" TEXT NOT NULL,
    "level" "DefaultLevel" NOT NULL,
    "customerId" TEXT,
    "resourceType" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "threshold" DECIMAL(65,30),
    "off" BOOLEAN NOT NULL DEFAULT false,
    "periodSec" INTEGER,
    "statistic" "Statistic",
    "evalM" INTEGER,
    "evalN" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ThresholdDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedAlarm" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "cloudAccountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "alarmName" TEXT NOT NULL,
    "alarmArn" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "severityManual" BOOLEAN NOT NULL DEFAULT false,
    "threshold" DECIMAL(65,30) NOT NULL,
    "thresholdSource" "ValueSource" NOT NULL,
    "consoleThreshold" DECIMAL(65,30),
    "evalM" INTEGER NOT NULL,
    "evalN" INTEGER NOT NULL,
    "evalSource" "ValueSource" NOT NULL,
    "comparison" TEXT NOT NULL,
    "statistic" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "treatMissingData" TEXT NOT NULL,
    "state" "AlarmState",
    "driftStatus" "DriftStatus" NOT NULL DEFAULT 'IN_SYNC',
    "driftDetail" JSONB,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ManagedAlarm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThresholdChange" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT NOT NULL,
    "target" "ChangeTarget" NOT NULL,
    "managedAlarmId" TEXT,
    "resourceId" TEXT,
    "resourceType" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "field" "ChangeField" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "oldSource" TEXT,
    "newSource" TEXT,
    "actorType" "ChangeActorType" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "applyStatus" "ApplyStatus" NOT NULL DEFAULT 'PENDING',
    "commandId" TEXT,
    "error" TEXT,

    CONSTRAINT "ThresholdChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarmSyncRun" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cloudAccountId" TEXT NOT NULL,
    "mode" "SyncMode" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "AlarmSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemediationPolicy" (
    "customerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "RemediationMode" NOT NULL DEFAULT 'NOTIFY_ONLY',
    "actions" "RemediationAction"[] DEFAULT ARRAY[]::"RemediationAction"[],
    "approverRole" "ConsoleRole" NOT NULL DEFAULT 'ADMIN',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RemediationPolicy_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "RemediationRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cloudAccountId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "trigger" JSONB NOT NULL,
    "action" "RemediationAction" NOT NULL,
    "status" "RemediationStatus" NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionVia" TEXT,
    "executedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "slackMessageId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RemediationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rotation" (
    "id" TEXT NOT NULL,
    "scope" "RotationScope" NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "cadence" "Cadence" NOT NULL,
    "handoverDow" SMALLINT NOT NULL,
    "handoverMin" SMALLINT NOT NULL,
    "anchorAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',

    CONSTRAINT "Rotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotationMember" (
    "rotationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "RotationMember_pkey" PRIMARY KEY ("rotationId","contactId")
);

-- CreateTable
CREATE TABLE "Override" (
    "id" TEXT NOT NULL,
    "rotationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "kind" "OverrideKind" NOT NULL,
    "status" "OverrideStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leave" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "replacementId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),
    "bulkChangeId" TEXT,

    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkChange" (
    "id" TEXT NOT NULL,
    "kind" "BulkChangeKind" NOT NULL,
    "actorId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "previewHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagingConfig" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "style" "PagingStyle" NOT NULL,
    "plan" "PagingPlan" NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "repeatCount" INTEGER NOT NULL DEFAULT 1,
    "renotifyAfterAckSec" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PagingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationStep" (
    "id" TEXT NOT NULL,
    "pagingConfigId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "atMin" INTEGER NOT NULL,
    "targetType" "StepTargetType" NOT NULL,
    "targetId" TEXT,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "advanceOnAllFail" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EscalationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "slackChannelId" TEXT,
    "webhookSecretRef" TEXT,
    "conditions" JSONB,
    "verifiedAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelVerification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "contactId" TEXT NOT NULL,
    "channel" "VerifyChannel" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "via" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "ChannelVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationJob" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerId" TEXT,
    "incidentId" TEXT NOT NULL,
    "purpose" "NotificationPurpose" NOT NULL,
    "channel" "NotificationChannelType" NOT NULL,
    "targetRef" TEXT NOT NULL,
    "groupKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "NotificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "incidentId" TEXT NOT NULL,
    "jobId" TEXT,
    "channel" "NotificationChannelType" NOT NULL,
    "status" "LogStatus" NOT NULL,
    "targetSummary" TEXT NOT NULL,
    "escalationStep" INTEGER,
    "providerMessageId" TEXT,
    "error" TEXT,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackMessage" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "incidentId" TEXT NOT NULL,
    "alertId" TEXT,
    "channelId" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "threadTs" TEXT,
    "kind" "SlackMessageKind" NOT NULL,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "firingEpochAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickHeartbeat" (
    "name" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMPTZ(3),
    "lastFinishedAt" TIMESTAMPTZ(3),
    "lastStatus" "TickStatus",
    "lastDurationMs" INTEGER,
    "lastStats" JSONB,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastScheduledAt" TIMESTAMPTZ(3),

    CONSTRAINT "TickHeartbeat_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_customerId_idx" ON "User"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_userId_key" ON "Contact"("userId");

-- CreateIndex
CREATE INDEX "Contact_customerId_idx" ON "Contact"("customerId");

-- CreateIndex
CREATE INDEX "Contact_kind_idx" ON "Contact"("kind");

-- CreateIndex
CREATE INDEX "ContactScope_customerId_scopeType_scopeId_idx" ON "ContactScope"("customerId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactScope_contactId_scopeType_scopeId_role_key" ON "ContactScope"("contactId", "scopeType", "scopeId", "role");

-- CreateIndex
CREATE INDEX "Responder_contactId_idx" ON "Responder"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ResponderTemplate_name_key" ON "ResponderTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_name_key" ON "Customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_customerId_name_key" ON "Project"("customerId", "name");

-- CreateIndex
CREATE INDEX "Service_customerId_idx" ON "Service"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_projectId_name_key" ON "Service"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CloudAccount_awsAccountId_key" ON "CloudAccount"("awsAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudAccount_externalId_key" ON "CloudAccount"("externalId");

-- CreateIndex
CREATE INDEX "CloudAccount_customerId_idx" ON "CloudAccount"("customerId");

-- CreateIndex
CREATE INDEX "Assignment_customerId_idx" ON "Assignment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_scopeType_scopeId_contactId_key" ON "Assignment"("scopeType", "scopeId", "contactId");

-- CreateIndex
CREATE INDEX "RoutingRule_customerId_priority_idx" ON "RoutingRule"("customerId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSource_tokenHash_key" ON "IntegrationSource"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSource_customerId_name_key" ON "IntegrationSource"("customerId", "name");

-- CreateIndex
CREATE INDEX "IngestRejection_receivedAt_idx" ON "IngestRejection"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_dedupKey_key" ON "RawEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "RawEvent_customerId_occurredAt_idx" ON "RawEvent"("customerId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "RawEvent_alertId_occurredAt_idx" ON "RawEvent"("alertId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "RawEvent_groupId_idx" ON "RawEvent"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_fingerprint_key" ON "Alert"("fingerprint");

-- CreateIndex
CREATE INDEX "Alert_customerId_status_idx" ON "Alert"("customerId", "status");

-- CreateIndex
CREATE INDEX "Alert_customerId_lastEventAt_idx" ON "Alert"("customerId", "lastEventAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_awsAccountId_idx" ON "Alert"("awsAccountId");

-- CreateIndex
CREATE INDEX "AlertGroup_status_closeAt_idx" ON "AlertGroup"("status", "closeAt");

-- CreateIndex
CREATE INDEX "Incident_customerId_status_triggeredAt_idx" ON "Incident"("customerId", "status", "triggeredAt" DESC);

-- CreateIndex
CREATE INDEX "Incident_status_escalationBaseAt_idx" ON "Incident"("status", "escalationBaseAt");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_number_key" ON "Incident"("number");

-- CreateIndex
CREATE INDEX "IncidentAlert_alertId_idx" ON "IncidentAlert"("alertId");

-- CreateIndex
CREATE INDEX "IncidentEvent_incidentId_at_idx" ON "IncidentEvent"("incidentId", "at");

-- CreateIndex
CREATE INDEX "Resolution_customerId_serviceId_metricKey_resolvedAt_idx" ON "Resolution"("customerId", "serviceId", "metricKey", "resolvedAt" DESC);

-- CreateIndex
CREATE INDEX "MaintenanceWindow_customerId_endsAt_idx" ON "MaintenanceWindow"("customerId", "endsAt");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_scopeType_scopeId_idx" ON "MaintenanceWindow"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "SeverityMapping_matchValue_key" ON "SeverityMapping"("matchValue");

-- CreateIndex
CREATE INDEX "Resource_customerId_resourceType_monitoringState_idx" ON "Resource"("customerId", "resourceType", "monitoringState");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_cloudAccountId_region_resourceType_resourceKey_key" ON "Resource"("cloudAccountId", "region", "resourceType", "resourceKey");

-- CreateIndex
CREATE INDEX "ManagedAlarm_customerId_driftStatus_idx" ON "ManagedAlarm"("customerId", "driftStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedAlarm_cloudAccountId_region_alarmName_key" ON "ManagedAlarm"("cloudAccountId", "region", "alarmName");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedAlarm_resourceId_metricKey_key" ON "ManagedAlarm"("resourceId", "metricKey");

-- CreateIndex
CREATE INDEX "ThresholdChange_customerId_at_idx" ON "ThresholdChange"("customerId", "at" DESC);

-- CreateIndex
CREATE INDEX "ThresholdChange_managedAlarmId_at_idx" ON "ThresholdChange"("managedAlarmId", "at" DESC);

-- CreateIndex
CREATE INDEX "AlarmSyncRun_cloudAccountId_startedAt_idx" ON "AlarmSyncRun"("cloudAccountId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AlarmSyncRun_status_heartbeatAt_idx" ON "AlarmSyncRun"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "RemediationRequest_customerId_requestedAt_idx" ON "RemediationRequest"("customerId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "Override_rotationId_startAt_idx" ON "Override"("rotationId", "startAt");

-- CreateIndex
CREATE INDEX "Leave_contactId_startDate_idx" ON "Leave"("contactId", "startDate");

-- CreateIndex
CREATE INDEX "PagingConfig_customerId_idx" ON "PagingConfig"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PagingConfig_scopeType_scopeId_key" ON "PagingConfig"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "EscalationStep_pagingConfigId_index_key" ON "EscalationStep"("pagingConfigId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_scopeType_scopeId_kind_slackChannelId_key" ON "NotificationChannel"("scopeType", "scopeId", "kind", "slackChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelVerification_tokenHash_key" ON "ChannelVerification"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationJob_idempotencyKey_key" ON "NotificationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationJob_status_nextAttemptAt_idx" ON "NotificationJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationLog_incidentId_at_idx" ON "NotificationLog"("incidentId", "at");

-- CreateIndex
CREATE INDEX "SlackMessage_incidentId_createdAt_idx" ON "SlackMessage"("incidentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlackMessage_channelId_ts_key" ON "SlackMessage"("channelId", "ts");

-- CreateIndex
CREATE INDEX "AuditLog_customerId_at_idx" ON "AuditLog"("customerId", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactScope" ADD CONSTRAINT "ContactScope_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactScope" ADD CONSTRAINT "ContactScope_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Responder" ADD CONSTRAINT "Responder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Responder" ADD CONSTRAINT "Responder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Responder" ADD CONSTRAINT "Responder_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ResponderTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponderTemplateMember" ADD CONSTRAINT "ResponderTemplateMember_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ResponderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponderTemplateMember" ADD CONSTRAINT "ResponderTemplateMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_responderTemplateId_fkey" FOREIGN KEY ("responderTemplateId") REFERENCES "ResponderTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_pagingConfigId_fkey" FOREIGN KEY ("pagingConfigId") REFERENCES "PagingConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSource" ADD CONSTRAINT "IntegrationSource_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntegrationSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AlertGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_pagingConfigId_fkey" FOREIGN KEY ("pagingConfigId") REFERENCES "PagingConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAlert" ADD CONSTRAINT "IncidentAlert_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAlert" ADD CONSTRAINT "IncidentAlert_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThresholdDefault" ADD CONSTRAINT "ThresholdDefault_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedAlarm" ADD CONSTRAINT "ManagedAlarm_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedAlarm" ADD CONSTRAINT "ManagedAlarm_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedAlarm" ADD CONSTRAINT "ManagedAlarm_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThresholdChange" ADD CONSTRAINT "ThresholdChange_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThresholdChange" ADD CONSTRAINT "ThresholdChange_managedAlarmId_fkey" FOREIGN KEY ("managedAlarmId") REFERENCES "ManagedAlarm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSyncRun" ADD CONSTRAINT "AlarmSyncRun_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSyncRun" ADD CONSTRAINT "AlarmSyncRun_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationPolicy" ADD CONSTRAINT "RemediationPolicy_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationRequest" ADD CONSTRAINT "RemediationRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationRequest" ADD CONSTRAINT "RemediationRequest_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationRequest" ADD CONSTRAINT "RemediationRequest_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rotation" ADD CONSTRAINT "Rotation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotationMember" ADD CONSTRAINT "RotationMember_rotationId_fkey" FOREIGN KEY ("rotationId") REFERENCES "Rotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotationMember" ADD CONSTRAINT "RotationMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Override" ADD CONSTRAINT "Override_rotationId_fkey" FOREIGN KEY ("rotationId") REFERENCES "Rotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Override" ADD CONSTRAINT "Override_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_bulkChangeId_fkey" FOREIGN KEY ("bulkChangeId") REFERENCES "BulkChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkChange" ADD CONSTRAINT "BulkChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagingConfig" ADD CONSTRAINT "PagingConfig_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationStep" ADD CONSTRAINT "EscalationStep_pagingConfigId_fkey" FOREIGN KEY ("pagingConfigId") REFERENCES "PagingConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelVerification" ADD CONSTRAINT "ChannelVerification_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationJob" ADD CONSTRAINT "NotificationJob_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "NotificationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints Prisma schema language cannot express (DATA-MODEL.md). Hand-written,
-- standard PostgreSQL 15+ only (NULLS NOT DISTINCT). Keep in sync with schema.prisma comments.
-- ─────────────────────────────────────────────────────────────────────────────

-- Contact: INTERNAL ⇒ customerId null, CUSTOMER ⇒ customerId required (DATA-MODEL §1 Contact)
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_kind_customer_chk"
  CHECK (("kind" = 'INTERNAL' AND "customerId" IS NULL) OR ("kind" = 'CUSTOMER' AND "customerId" IS NOT NULL));
-- UQ(slackUserId) where not null
CREATE UNIQUE INDEX "Contact_slackUserId_key" ON "Contact"("slackUserId") WHERE "slackUserId" IS NOT NULL;

-- AlertGroup: one OPEN group per axis (grouping G-3)
CREATE UNIQUE INDEX "AlertGroup_groupKey_open_key" ON "AlertGroup"("groupKey") WHERE "status" = 'OPEN';

-- Incident: one merge target per axis (grouping I-3)
CREATE UNIQUE INDEX "Incident_axis_mergeTarget_key" ON "Incident"("axis") WHERE "isMergeTarget";

-- ThresholdDefault: UQ(level, customerId, resourceType, metricKey) with MSP rows customerId null
CREATE UNIQUE INDEX "ThresholdDefault_scope_key" ON "ThresholdDefault"("level", "customerId", "resourceType", "metricKey") NULLS NOT DISTINCT;
ALTER TABLE "ThresholdDefault" ADD CONSTRAINT "ThresholdDefault_level_customer_chk"
  CHECK (("level" = 'MSP' AND "customerId" IS NULL) OR ("level" = 'CUSTOMER' AND "customerId" IS NOT NULL));
ALTER TABLE "ThresholdDefault" ADD CONSTRAINT "ThresholdDefault_eval_chk"
  CHECK ("evalM" IS NULL OR "evalN" IS NULL OR (1 <= "evalM" AND "evalM" <= "evalN" AND "evalN" <= 10));

-- Rotation: CUSTOMER scope requires customerId; UQ(customerId, name)
ALTER TABLE "Rotation" ADD CONSTRAINT "Rotation_scope_customer_chk"
  CHECK (("scope" = 'MSP' AND "customerId" IS NULL) OR ("scope" = 'CUSTOMER' AND "customerId" IS NOT NULL));
CREATE UNIQUE INDEX "Rotation_customerId_name_key" ON "Rotation"("customerId", "name") NULLS NOT DISTINCT;

-- RemediationRequest: one active request per resource+action (D-15)
CREATE UNIQUE INDEX "RemediationRequest_active_key" ON "RemediationRequest"("customerId", "resourceId", "action")
  WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED', 'EXECUTING');

-- MaintenanceWindow: ends after start (suppression S-5)
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_range_chk" CHECK ("endsAt" > "startsAt");

-- Leave: inclusive date range
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_range_chk" CHECK ("endDate" >= "startDate");

-- SuppressionPolicy ranges (suppression S-11)
ALTER TABLE "SuppressionPolicy" ADD CONSTRAINT "SuppressionPolicy_ranges_chk" CHECK (
  "repeatIntervalSec" BETWEEN 0 AND 86400 AND "flappingPerDay" BETWEEN 1 AND 1000
  AND "flappingWindowDays" >= (1.0/24) AND "flappingWindowDays" <= 30
  AND "flappingQuarantineSec" BETWEEN 0 AND 86400 AND "groupWaitSec" BETWEEN 0 AND 300
  AND "renotifyAfterSec" BETWEEN 0 AND 86400);
