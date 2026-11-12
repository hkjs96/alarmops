"""Auto-remediation (D-15) — disabled by default, proposal only.

Legacy (`remediation_handler` MODIFY path) stopped EC2/RDS/Aurora/DocDB and deleted ALB/NLB immediately with the Lambda's
own session. Here:

1. `propose()` turns an unauthorised-change event into a `RemediationRequest` row — **no AWS call**. Nothing happens
   unless the customer's policy is `enabled` (default False) and lists the action. Mode NOTIFY_ONLY (default) creates a
   NOTIFIED request; APPROVAL_REQUIRED creates PENDING_APPROVAL. There is no automatic mode.
2. Approval happens in Slack (outside this service) and sets APPROVED with decidedBy/decidedAt.
3. `execute()` (EXECUTE_REMEDIATION command) is the **only** code path that can call stop/delete. It requires all of:
   process flag `ALARMOPS_REMEDIATION_EXECUTION` == "true" (default off), policy enabled + APPROVAL_REQUIRED + action
   allowed, request APPROVED with a decider and not expired, conditional APPROVED→EXECUTING claim won, Remediator role
   enabled on the account.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from alarm_engine.aws import CapabilityDisabled, CloudAccount, SessionFactory, assert_arn_in_account
from alarm_engine.repository import RemediationRequestRow, Repository, ResourceRow, new_id, now

ACTION_BY_TYPE = {"EC2": "EC2_STOP", "RDS": "RDS_STOP", "AuroraRDS": "RDS_STOP", "DocDB": "RDS_STOP",
                  "ALB": "ELB_DELETE", "NLB": "ELB_DELETE"}


def execution_enabled() -> bool:
    return os.environ.get("ALARMOPS_REMEDIATION_EXECUTION", "").strip().lower() == "true"


def propose(repo: Repository, account: CloudAccount, resource: ResourceRow, trigger: dict) -> RemediationRequestRow | None:
    if resource.monitoring_state != "MONITORED":
        return None
    action = ACTION_BY_TYPE.get(resource.resource_type)
    if action is None:
        return None
    policy = repo.get_remediation_policy(resource.customer_id)
    if not policy.enabled or action not in policy.actions:
        return None
    status = "PENDING_APPROVAL" if policy.mode == "APPROVAL_REQUIRED" else "NOTIFIED"
    return repo.create_remediation_request(RemediationRequestRow(
        id=new_id("rem"), customer_id=resource.customer_id, cloud_account_id=account.id, resource_id=resource.id,
        action=action, status=status, trigger=trigger,
    ))


@dataclass(frozen=True)
class ExecuteResult:
    status: str     # SUCCEEDED | FAILED | REFUSED
    reason: str = ""


def execute(repo: Repository, sessions: SessionFactory, request_id: str, *,
            customer_id: str | None = None) -> ExecuteResult:
    if not execution_enabled():
        return ExecuteResult("REFUSED", "execution disabled (ALARMOPS_REMEDIATION_EXECUTION)")
    req = repo.get_remediation_request(customer_id, request_id)
    if req is None or (customer_id is not None and req.customer_id != customer_id):
        return ExecuteResult("REFUSED", "not found")
    if req.status != "APPROVED" or not req.decided_by or req.decided_at is None:
        return ExecuteResult("REFUSED", f"not approved ({req.status})")
    if req.expires_at is not None and req.expires_at < now():
        return ExecuteResult("REFUSED", "expired")
    policy = repo.get_remediation_policy(req.customer_id)
    if not policy.enabled or policy.mode != "APPROVAL_REQUIRED" or req.action not in policy.actions:
        return ExecuteResult("REFUSED", "policy does not allow")
    resource = repo.get_resource(req.customer_id, req.resource_id)
    if resource is None:
        return ExecuteResult("REFUSED", "resource not found")
    if resource.cloud_account_id != req.cloud_account_id:
        return ExecuteResult("REFUSED", "resource not in request account")
    if resource.monitoring_state != "MONITORED":
        return ExecuteResult("REFUSED", f"resource not monitored ({resource.monitoring_state})")
    try:
        account = repo.get_account(req.cloud_account_id)
    except LookupError:
        return ExecuteResult("REFUSED", "account not found")
    if account.customer_id != req.customer_id:
        return ExecuteResult("REFUSED", "tenant mismatch")
    try:
        assert_arn_in_account(resource.resource_arn, account, resource.region)
    except PermissionError as e:
        return ExecuteResult("REFUSED", str(e))
    try:
        account.role_arn("remediator")
    except CapabilityDisabled:
        return ExecuteResult("REFUSED", "CAPABILITY_DISABLED")
    if not repo.transition_remediation(req.customer_id, req.id, "APPROVED", "EXECUTING"):
        return ExecuteResult("REFUSED", "lost claim")
    try:
        result = _run(sessions, account, resource, req.action)
    except Exception as e:  # noqa: BLE001
        repo.transition_remediation(req.customer_id, req.id, "EXECUTING", "FAILED", {"error": str(e)[:500]})
        return ExecuteResult("FAILED", str(e))
    repo.transition_remediation(req.customer_id, req.id, "EXECUTING", "SUCCEEDED", result)
    return ExecuteResult("SUCCEEDED")


def _run(sessions: SessionFactory, account: CloudAccount, r: ResourceRow, action: str) -> dict[str, Any]:
    if action == "EC2_STOP":
        sessions.client(account, "remediator", "ec2", r.region).stop_instances(InstanceIds=[r.resource_key])
    elif action == "RDS_STOP":
        rds = sessions.client(account, "remediator", "rds" if r.resource_type != "DocDB" else "docdb", r.region)
        if r.resource_type == "DocDB":
            rds.stop_db_cluster(DBClusterIdentifier=r.resource_key)
        else:
            rds.stop_db_instance(DBInstanceIdentifier=r.resource_key)
    elif action == "ELB_DELETE":
        assert_arn_in_account(r.resource_arn, account, r.region)   # re-check right before the destructive call
        sessions.client(account, "remediator", "elbv2", r.region).delete_load_balancer(LoadBalancerArn=r.resource_arn)
    else:
        raise ValueError(action)
    return {"action": action, "resourceKey": r.resource_key}
