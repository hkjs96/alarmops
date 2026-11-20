"""Bounded throttle retry and error classification shared by collectors and the CloudWatch adapter (issue #88).

Throttling that outlasts the retries, AccessDenied and SCP denials mean "state unknown", never "zero results": callers
must not delete anything in that scope (known-bugs 4-9). Only the error *code* is logged, never the message or request.

`call` keeps the collector contract (the final ClientError propagates, so discovery can record the code per type).
`guarded_call` is for the alarm adapter: unknown-state errors become `AwsStateUnknown`.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from typing import Any

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
THROTTLE_CODES = frozenset({
    "Throttling", "ThrottlingException", "ThrottledException", "RequestLimitExceeded", "TooManyRequestsException",
    "ProvisionedThroughputExceededException", "RequestThrottled", "RequestThrottledException", "SlowDown",
    "PriorRequestNotComplete", "BandwidthLimitExceeded",
})
# Access denied (SCPs also surface as AccessDenied) and credential problems: the scope's state is unknown.
# LimitExceededException is deliberately not a throttle code: for CloudWatch it means a quota is exhausted.
DENIED_CODES = frozenset({
    "AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthFailure", "UnauthorizedAccess",
    "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException",
    "InvalidSignatureException", "OptInRequired",
})

_sleep: Callable[[float], None] = time.sleep     # tests replace this


class AwsStateUnknown(Exception):
    """The remote state could not be determined (throttled past the retry budget, or access denied / SCP). The scope's
    alarms must be left alone. The message carries the error code only."""

    def __init__(self, code: str, op: str = ""):
        super().__init__(f"STATE_UNKNOWN: {code}" + (f" ({op})" if op else ""))
        self.code = code


def safe_error(e: BaseException) -> str:
    """Log-safe description: exception type plus a short code (SQLSTATE / AWS error code). Never the message, ARNs or
    account ids: a driver or AWS error can carry the DB host, a connection string or customer identifiers."""
    code = getattr(e, "sqlstate", None)
    if code is None:
        resp = getattr(e, "response", None)
        if isinstance(resp, dict):
            code = (resp.get("Error") or {}).get("Code")
        else:
            code = getattr(e, "code", None)
    code_s = str(code) if isinstance(code, str) and code.replace("_", "").isalnum() and len(code) <= 64 else None
    return f"{type(e).__name__}" + (f" code={code_s}" if code_s else "")


def is_unknown_state(e: BaseException) -> bool:
    return isinstance(e, AwsStateUnknown) or (
        isinstance(e, ClientError) and (error_code(e) in THROTTLE_CODES or error_code(e) in DENIED_CODES))


def error_code(e: ClientError) -> str:
    return str(e.response.get("Error", {}).get("Code", ""))


def call(fn: Callable[..., Any], _sleeper: Callable[[float], None] | None = None, **kw: Any) -> Any:
    """One API call with at most MAX_ATTEMPTS tries on throttling errors (exponential backoff, jitter)."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            return fn(**kw)
        except ClientError as e:
            if error_code(e) not in THROTTLE_CODES or attempt == MAX_ATTEMPTS - 1:
                if error_code(e) in THROTTLE_CODES:
                    logger.warning("throttled (%s) on %s: retries exhausted", error_code(e), getattr(fn, "__name__", "call"))
                raise
            delay = min(8.0, 0.5 * 2 ** attempt) * (0.5 + random.random() / 2)  # noqa: S311 — jitter, not security
            logger.warning("throttled (%s), retry %d/%d in %.1fs", error_code(e), attempt + 1, MAX_ATTEMPTS - 1, delay)
            (_sleeper or _sleep)(delay)
    raise AssertionError("unreachable")  # pragma: no cover


def guarded_call(fn: Callable[..., Any], **kw: Any) -> Any:
    """`call`, but throttling past the budget and AccessDenied/SCP raise `AwsStateUnknown` (code only in the log)."""
    op = getattr(fn, "__name__", "call")
    try:
        return call(fn, **kw)
    except ClientError as e:
        code = error_code(e)
        if code in THROTTLE_CODES or code in DENIED_CODES:
            logger.warning("state unknown on %s: %s", op, code)
            raise AwsStateUnknown(code, op) from None
        raise
