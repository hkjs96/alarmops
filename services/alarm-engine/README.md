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
| `manual_change.py` | CloudTrail routing rule (source not wired) |
| `migration.py` | D-08 legacy-name → new-name dry-run report |
| `repository.py`, `pg_repository.py` | in-memory and psycopg repositories |

Run (from repo root): `npm run test:engine`, `npm run lint:engine` (needs `pip install -r services/alarm-engine/requirements-dev.txt`).
Tests never call AWS (fakes, botocore Stubber, moto). Postgres tests run only with `ALARM_ENGINE_TEST_PG_URL`
(see `tests/test_pg_repository.py`).

Not in this package yet: the 29 resource collectors (discovery is an interface; `wiring.py` fails clearly), the
CloudTrail event source, SAM template.
