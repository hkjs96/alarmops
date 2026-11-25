# 권한 리허설 하네스 (#122)

시험 계정(B·C)에서 고객 연결 스택의 권한을 실제로 확인하는 스크립트다. 사람이 별도 터미널에서 SSO로 실행한다. 에이전트는 실행하지 않는다(`CLAUDECODE` 등이 있으면 스스로 거부한다). 중앙 계정(A)은 대상이 아니다.

## 준비

1. 프로필 이름은 `rehearsal-<이름>` 형식이다. 계정 표를 만든다. 저장소에 올라가지 않는다(`.gitignore`).

   `infra/scripts/rehearsal/accounts.local.json`
   ```json
   {"centralAccountId": "…", "devAccountId": "…", "denyAccounts": ["…"],
    "centralRoleArn": "arn:aws:iam::<중앙>:role/…",
    "centralEventBusArn": "arn:aws:events:ap-northeast-2:<중앙>:event-bus/…",
    "profiles": {"rehearsal-b": "<B 계정 12자리>", "rehearsal-c": "<C 계정 12자리>"}}
   ```
2. `AWS_*` 자격증명·`AWS_PROFILE` 환경변수는 비운다. 프로필은 `--profile` 로만 준다.
3. ExternalId는 콘솔이 발급한 값을 환경변수 `REHEARSAL_EXTERNAL_ID` 로만 준다(인자·파일 저장 금지). 출력·로그에는 `****` 로 가려진다.

## 순서

```
bash infra/scripts/rehearsal/preflight.sh --profile rehearsal-b
REHEARSAL_EXTERNAL_ID=... bash infra/scripts/rehearsal/install.sh --profile rehearsal-b --confirm-account <12자리>
bash infra/scripts/rehearsal/verify.sh   --profile rehearsal-b --confirm-account <12자리> --run-id <이름>
bash infra/scripts/rehearsal/cleanup.sh  --profile rehearsal-b --confirm-account <12자리> --run-id <이름> [--stack]
```

- 계정 12자리는 매번 직접 입력한다. 계정 표, 실제 `sts get-caller-identity` 결과와 모두 같아야 한다.
- preflight는 읽기만 한다. 끝에 사람 관문(7-1 콘솔 등록, 7-4 연결 확인)을 묻는다.
- verify는 허용 목록 추가 **전**에 시작한다. (가) 후 스크립트가 멈추면 중앙에서 `bus-allowlist` `action=add` 를 실행하고 y 로 계속한다. 입력이 없으면 해당 항목은 SKIP 이다.
- 결과표 값: PASS(됐다) / FAIL(안 됐다) / FAIL(TIMEOUT, 원인 미상) / SKIP. (라)는 정책 시뮬레이션이라 실측이 아니다.
- 로그는 `rehearsal-logs/<profile>/<runId>.md`(권한 600). 올리지 않는다.
- cleanup은 그 runId 로그에 있는 큐와, 그 큐를 차원으로 가진 `ManagedBy=AlarmOps` 알람만 지운다. `--stack` 은 스택 이름이 `alarmops-customer` 이고 스택 태그 `AlarmOpsRehearsal=true` 일 때만 지운다. 끝에 사람 몫(콘솔 계정 비활성화, `bus-allowlist` `action=remove`)을 출력한다.

## 환경변수

`REHEARSAL_ACCOUNTS_FILE`, `REHEARSAL_LOG_DIR`, `REHEARSAL_POLL_INTERVAL`(기본 30초), `REHEARSAL_WAIT_SECONDS`(기본 900초). 자세한 계약은 `infra/test/REHEARSAL-CONTRACT.md`.
