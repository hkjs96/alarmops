# alarm-engine (Python 3.12, Lambda)

Port of aws-alert-manager's alarm rules (D-05) with the AlarmOps decisions applied:
D-08 (name = resource + metric, changes in place), D-16 (tag removed → NEEDS_REVIEW), D-19/D-27 (layered values with
source), D-15 (remediation proposal only, execution behind approval), D-07 (role per purpose, ExternalId).

| Module | What |
|---|---|
| `resource_types/` | the 29 type specs, copied from AAM `backend/common/resource_types` @4eafce9 (imports renamed only) |
| `registry.py` | AAM `alarm_registry.py` verbatim: M-of-N policy, severity table, derived maps |
| `tags.py` | tag contract (legacy names, `off`, `_Eval`, disk suffix, dynamic tags/KI-005). No env layer |
| `thresholds.py` | TAG > CONSOLE > CUSTOMER > MSP > CODE per field (threshold/off, statistic, period, M/N) |
| `naming.py` | new alarm name, description JSON (matches `packages/core` normalizer), ownership |
| `dimensions.py`, `desired.py` | desired alarm definitions per resource |
| `sync.py` | desired vs actual → CREATE / UPDATE (in place) / REFRESH / DELETE, external-change hold |
| `engine.py` | discovery → D-16 states → orphans → sync → DB (API-CONTRACT §7) |
| `handler.py` | SQS `alarm-commands` consumer (API-CONTRACT §6), partial batch failures |
| `remediation.py` | D-15: `propose()` writes a request; `execute()` only for APPROVED + flag |
| `collectors/` | the 29 resource collectors (Reader role, tag-first, paginated, bounded throttle retry); `AwsDiscovery` |
| `events.py` | CloudTrail tag-change event (EventBridge envelope, top-level `account` only) → resync of the resource |
| `manual_change.py` | CloudTrail routing rule (pure) |
| `migration.py` | D-08 legacy-name → new-name dry-run report |
| `repository.py`, `pg_repository.py` | in-memory and psycopg repositories |

Run (from repo root): `npm run test:engine`, `npm run lint:engine` (needs `pip install -r services/alarm-engine/requirements-dev.txt`).
Tests never call AWS (fakes, botocore Stubber, moto). Postgres tests run only with `ALARM_ENGINE_TEST_PG_URL`
(see `tests/test_pg_repository.py`).

## Collectors (`collectors/`)

`wiring.build_engine()` uses `AwsDiscovery`. Per account and region every collector group runs; a group that fails is
recorded in `counts.typeErrors` and the others continue (all failing = failed run, never "0 resources").
Listing is tag-first: `tag:GetResources` (key `Monitoring`, any value, so D-16 sees `off`/removed too) gives ARN + tags;
Describe/List calls add what dimensions need (Aurora writer/serverless, TG's LB, ECS cluster, MQ instances, SageMaker
variant, API type). EC2/NAT/VPN use the server-side `tag-key` filter. CloudFront and Route53 are global: listed once per
account against us-east-1 (row `region` = us-east-1). Throttling: up to 5 attempts, jittered backoff, then the group's
error. `alive()` = existence probe per type (True/False/None); None changes nothing. Lambda has no Describe at all
(`lambda:List*` is deliberately not in the Reader role), so it is found through `tag:GetResources` only.

Reader permissions the collectors need beyond `infra/customer-stack/template.yaml` today:

| Type | Needs | Without it |
|---|---|---|
| APIGW | `apigateway:GET` on Resource `arn:${Partition}:apigateway:*::/restapis` and `arn:${Partition}:apigateway:*::/apis` **exactly** (the list calls `get_rest_apis` / `get_apis`), plus an explicit Deny of `apigateway:GET` on `/apikeys*`, `/usageplans/*/keys*` and `/restapis/*/*` (API keys, stage variables, integrations) | type error each run |
| MQ | `mq:ListBrokers` (summary: `BrokerState`, `DeploymentMode`). `DescribeBroker` is **not** requested: it returns user lists | type error each run |
| SageMaker | `sagemaker:DescribeEndpoint` on `endpoint/*` | type error each run |
| DX | `directconnect:DescribeConnections` | type error each run |

The code makes no ACM, Backup, WAF or EFS Describe/List calls, so none is requested. For those types, Lambda, APIGW, MQ,
DX and SageMaker, `alive()` is unknown (None): a deleted resource stays MONITORED (its alarms stay) until another
signal. Stored `counts.typeErrors` hold only the AWS error code; the full message stays in the server log. All list
loops are bounded (1000 pages, repeated token detection) and raise instead of returning a truncated list.

Tag events: the same-account `TAG_RECONCILE` run is debounced (`TAG_EVENT_RECONCILE_DEBOUNCE_MINUTES`, default 10, by
the newest AlarmSyncRun of the account), a repeated event for one resource within `TAG_EVENT_RESOURCE_DEDUPE_SECONDS`
(default 60, by the resource row's `lastSeenAt`, so it holds across Lambda instances) is dropped, events with
`detail.errorCode` or a `source` not starting with `aws.` are ignored, and disabled / purged accounts are not looked up.

Other APIs used are already in the Reader role (`ec2:Describe*`, `rds:DescribeDB*`, `elasticloadbalancing:Describe*`,
`elasticache:DescribeCacheClusters`, `ecs:List*/DescribeServices`, `es:DescribeDomain`, `kafka:ListClustersV2`,
`dynamodb:DescribeTable`, `sqs:ListQueues`, `sns:ListTopics`, `s3:ListAllMyBuckets`, `cloudfront:ListDistributions`,
`route53:ListHealthChecks`, `tag:GetResources`). Note `elasticloadbalancing:DescribeTargetGroups` is also needed for TG
rows (present).

Event input: besides `alarm-commands` JSON, `handler.handle_batch` accepts the forwarded CloudTrail envelope on the same
queue (`events.py`). The central-bus rule that delivers it to the queue belongs to infra.

Not in this package yet: SAM template.
