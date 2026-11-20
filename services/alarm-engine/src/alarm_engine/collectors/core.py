"""Collector plumbing: bounded throttle retry, pagination, per-call context (Reader session, tag:GetResources cache).

Every call goes through a client from `SessionFactory.client(account, "reader", ...)` — never a default boto3 client
(known-bugs 4-2). Throttling is retried a bounded number of times with jittered backoff; any other error propagates to
the group, which records it as that type's error (one failing type never aborts the account).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterator
from typing import Any

from alarm_engine import retry as _retry
from alarm_engine.aws import CloudAccount, SessionFactory
from alarm_engine.engine import DiscoveredResource
from alarm_engine.retry import MAX_ATTEMPTS, THROTTLE_CODES, error_code  # noqa: F401 — re-exported

logger = logging.getLogger(__name__)

MONITORING_KEY = "Monitoring"

_sleep: Callable[[float], None] = time.sleep     # tests replace this


def call(fn: Callable[..., Any], **kw: Any) -> Any:
    """One API call with at most MAX_ATTEMPTS tries on throttling errors (shared policy: `alarm_engine.retry`)."""
    return _retry.call(fn, _sleeper=lambda d: _sleep(d), **kw)


class PaginationError(Exception):
    """A list call did not terminate (token repeats or too many pages). Raised, never truncated: a partial list would
    look like "resources gone" to the engine."""


MAX_PAGES = 1000


def marker_pages(fn: Callable[..., Any], extract: Callable[[dict], tuple[list[Any], Any]], req: str, **kw: Any
                 ) -> list[Any]:
    """Generic paging loop. `extract(response)` → (items, next token or falsy). Bounded and repeat-safe."""
    out: list[Any] = []
    token: Any = None
    seen: set[str] = set()
    for _ in range(MAX_PAGES):
        r = call(fn, **kw, **({req: token} if token else {}))
        items, token = extract(r)
        out.extend(items)
        if not token:
            return out
        if str(token) in seen:
            raise PaginationError(f"pagination token repeated for {getattr(fn, '__name__', fn)}")
        seen.add(str(token))
    raise PaginationError(f"more than {MAX_PAGES} pages for {getattr(fn, '__name__', fn)}")


def pages(fn: Callable[..., Any], key: str, req: str = "NextToken", resp: str | None = None, **kw: Any) -> list[Any]:
    """Every item of `key` across all pages. Token request/response names differ per service."""
    rk = resp or req
    return marker_pages(fn, lambda r: (r.get(key) or [], r.get(rk)), req, **kw)


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
