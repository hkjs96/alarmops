"""`AwsDiscovery`: the engine's `Discovery` port over the collector groups.

- `list_monitored`: every group, per region; a group that fails is recorded (`take_errors`) and the others still run.
  If *every* group fails in a pass (e.g. AssumeRole denied) it raises, so the run FAILS instead of looking like "0
  resources" (alarm-sync 4-9).
- Global types (CloudFront, Route53) are listed once per account (first region), against us-east-1.
- `read_tags`: tag:GetResources by ARN. Internal `_x` helper tags of the stored row are kept.
- `alive`: per-type existence probe; True / False / None (unknown → the engine changes nothing).
"""

from __future__ import annotations

import logging

from alarm_engine.aws import CloudAccount, SessionFactory
from alarm_engine.collectors.core import Ctx, call
from alarm_engine.collectors.groups import GROUP_OF, GROUPS, Group
from alarm_engine.engine import DiscoveredResource, DiscoveryError
from alarm_engine.repository import ResourceRow

logger = logging.getLogger(__name__)


class AwsDiscovery:
    def __init__(self, sessions: SessionFactory, groups: tuple[Group, ...] = GROUPS):
        self.sessions = sessions
        self.groups = groups
        self._errors: dict[tuple[str, str], str] = {}

    def take_errors(self) -> dict[tuple[str, str], str]:
        """(region, resource type) → error of the groups that failed since the last call (and clear)."""
        e, self._errors = self._errors, {}
        return e

    def list_monitored(self, account: CloudAccount, region: str) -> list[DiscoveredResource]:
        out: list[DiscoveredResource] = []
        failed = 0
        ran = 0
        first_error = ""
        ctxs: dict[str, Ctx] = {}
        for g in self.groups:
            if g.global_region and region != account.regions[0]:
                continue                         # global types: once per account
            r = g.global_region or region
            ctx = ctxs.setdefault(r, Ctx(self.sessions, account, r))
            ran += 1
            try:
                out += g.collect(ctx)
            except Exception as e:  # noqa: BLE001 — per-type failure must not abort the account
                failed += 1
                msg = f"{type(e).__name__}: {e}"[:300]
                first_error = first_error or msg
                logger.warning("collector %s failed in %s: %s", g.name, r, msg)
                for t in g.types:
                    self._errors[(r, t)] = msg
        if ran and failed == ran:
            raise DiscoveryError(f"all collectors failed in {region}: {first_error}")
        return out

    def read_tags(self, account: CloudAccount, row: ResourceRow) -> dict[str, str] | None:
        try:
            ctx = Ctx(self.sessions, account, row.region)
            r = call(ctx.client("resourcegroupstaggingapi").get_resources, ResourceARNList=[row.resource_arn])
        except Exception as e:  # noqa: BLE001
            logger.warning("read_tags %s failed: %s", row.resource_arn, e)
            return None
        tags: dict[str, str] = {}
        for m in r.get("ResourceTagMappingList", []):
            if m.get("ResourceARN") == row.resource_arn:
                tags = {t["Key"]: t["Value"] for t in m.get("Tags", [])}
        internal = {k: v for k, v in row.tags.items() if k.startswith("_")}
        return {**tags, **internal}

    def alive(self, account: CloudAccount, region: str, resource_type: str, keys: list[str]) -> dict[str, bool | None]:
        g = GROUP_OF.get(resource_type)
        if g is None or g.exists is None:
            return {k: None for k in keys}
        try:
            return g.exists(Ctx(self.sessions, account, region), keys)
        except Exception as e:  # noqa: BLE001
            logger.warning("alive %s failed: %s", resource_type, e)
            return {k: None for k in keys}
