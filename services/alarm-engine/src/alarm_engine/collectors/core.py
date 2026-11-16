"""Collector plumbing: bounded throttle retry, pagination, per-call context (Reader session, tag:GetResources cache).

Every call goes through a client from `SessionFactory.client(account, "reader", ...)` — never a default boto3 client
(known-bugs 4-2). Throttling is retried a bounded number of times with jittered backoff; any other error propagates to
the group, which records it as that type's error (one failing type never aborts the account).
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable, Iterator
from typing import Any

from botocore.exceptions import ClientError

from alarm_engine.aws import CloudAccount, SessionFactory
from alarm_engine.engine import DiscoveredResource

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
THROTTLE_CODES = frozenset({
    "Throttling", "ThrottlingException", "ThrottledException", "RequestLimitExceeded", "TooManyRequestsException",
    "ProvisionedThroughputExceededException", "RequestThrottled", "RequestThrottledException", "SlowDown",
    "PriorRequestNotComplete", "BandwidthLimitExceeded", "LimitExceededException",
})
MONITORING_KEY = "Monitoring"

_sleep: Callable[[float], None] = time.sleep     # tests replace this


def error_code(e: ClientError) -> str:
    return str(e.response.get("Error", {}).get("Code", ""))


def call(fn: Callable[..., Any], **kw: Any) -> Any:
    """One API call with at most MAX_ATTEMPTS tries on throttling errors (exponential backoff, jitter)."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            return fn(**kw)
        except ClientError as e:
            if error_code(e) not in THROTTLE_CODES or attempt == MAX_ATTEMPTS - 1:
                raise
            delay = min(8.0, 0.5 * 2 ** attempt) * (0.5 + random.random() / 2)  # noqa: S311 — jitter, not security
            logger.warning("throttled (%s), retry %d/%d in %.1fs", error_code(e), attempt + 1, MAX_ATTEMPTS - 1, delay)
            _sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def pages(fn: Callable[..., Any], key: str, req: str = "NextToken", resp: str | None = None, **kw: Any) -> list[Any]:
    """Every item of `key` across all pages. Token request/response names differ per service."""
    resp = resp or req
    out: list[Any] = []
    token: Any = None
    while True:
        r = call(fn, **kw, **({req: token} if token else {}))
        out.extend(r.get(key) or [])
        token = r.get(resp)
        if not token:
            return out


def chunks(items: list[Any], n: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), n):
        yield items[i:i + n]


def tag_dict(tags: list[dict] | None) -> dict[str, str]:
    return {str(t["Key"] if "Key" in t else t.get("key", "")): str(t["Value"] if "Value" in t else t.get("value", ""))
            for t in tags or []}


def partition_of(account: CloudAccount) -> str:
    parts = account.reader_role_arn.split(":")
    return parts[1] if len(parts) > 1 and parts[1] else "aws"


class Ctx:
    """One (account, region) discovery pass: client cache and a tag:GetResources cache shared by the groups."""

    def __init__(self, sessions: SessionFactory, account: CloudAccount, region: str):
        self.sessions, self.account, self.region = sessions, account, region
        self.partition = partition_of(account)
        self._clients: dict[tuple[str, str], Any] = {}
        self._rgt: dict[tuple[str, tuple[str, ...]], list[tuple[str, dict[str, str]]]] = {}

    def client(self, service: str, region: str | None = None) -> Any:
        r = region or self.region
        if (service, r) not in self._clients:
            self._clients[(service, r)] = self.sessions.client(self.account, "reader", service, r)
        return self._clients[(service, r)]

    def rgt(self, filters: tuple[str, ...], region: str | None = None) -> list[tuple[str, dict[str, str]]]:
        """(ARN, tags) of every resource of these types carrying a `Monitoring` tag key (any value: D-16 needs the
        state of `off`/removed values too)."""
        r = region or self.region
        k = (r, filters)
        if k not in self._rgt:
            rows = pages(self.client("resourcegroupstaggingapi", r).get_resources, "ResourceTagMappingList",
                         "PaginationToken", TagFilters=[{"Key": MONITORING_KEY}], ResourceTypeFilters=list(filters),
                         ResourcesPerPage=100)
            self._rgt[k] = [(m["ResourceARN"], tag_dict(m.get("Tags"))) for m in rows]
        return self._rgt[k]


def found(rtype: str, key: str, arn: str, region: str, tags: dict[str, str], **internal: str) -> DiscoveredResource:
    """Internal `_x` tags (dimension helpers, e.g. `_lb_arn`) live next to the user tags, as in the legacy collectors."""
    return DiscoveredResource(rtype, key, arn, region, {**tags, **internal})
