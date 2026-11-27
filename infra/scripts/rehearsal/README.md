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

- `replica-check.sh`(#159)는 순서 밖에서 B 계정 리허설 때 한 번 돌린다. 원본 `AlarmOps-AlarmWriter`의 정책·경계를 복사한 임시 역할 `AlarmOpsRehearsal-WriterReplica`를 본인 SSO 역할로 assume 해서, 태그 조건과 이름 범위(D-63: 생성 허용은 `[`로 시작하는 알람 이름만)가 실제로 먹는지 6개((a)~(f))를 보고, 정보 행 (g)(이름이 `[`로 시작하는 태그 없는 알람 덮어쓰기는 가능, 알려진 한계)를 덧붙인다. 시험 알람 이름: `[AlarmOpsRehearsal] replica-test`, `AlarmOpsRehearsal-replica-unmanaged`, `[AlarmOpsRehearsal] replica-unmanaged-bracket`. 옛 템플릿의 스택이면 (f)가 FAIL이므로 먼저 `install.sh`로 스택을 갱신한다. 끝나면 스스로 지운다. 자세한 것은 `docs/GO-LIVE.md` 4단계.

```
aws sso login --profile rehearsal-b
bash infra/scripts/rehearsal/replica-check.sh --profile rehearsal-b --confirm-account <12자리> [--cleanup-only] [--probe-resource-tag-deny]
```
  - 선택 인자 `--probe-resource-tag-deny`: (a)~(f) 대신 원본 정책 복사본에 명시적 Deny(`DenyOverwriteUnmanaged`)를 `Null`·`StringNotEquals` 두 변형으로 붙이고(별도 인라인 정책 `probe-deny`, 끝나면 지움) `| 변형 | p1 새 알람 생성 | p2 태그없는 알람 덮어쓰기 | p3 관리 알람 수정 | p4 관리 알람 삭제 | 판정 |` 표를 낸다. 측정이라 종료 코드는 판정과 무관하게 0(중단 1, 거부 2 이상). `REHEARSAL_PROBE_WAIT`(기본 20초)로 정책 전파 대기를 조절한다. 변형마다 Deny 없는 상태·Deny 적용 상태의 카나리를 보고 p2 를 두 번 재서 `불안정`이면 판정을 "재측정"으로 낸다. 시작할 때 전용 접두어 `[AlarmOpsRehearsal] probe-` 알람(변형 2 × new·unmanaged·canary·other)을 지우고 정리 때도 지운다. 셀 값의 뜻은 `docs/GO-LIVE.md` 4단계. 자세한 것은 `docs/GO-LIVE.md` 4단계.
  - SSO 프로필이 아니면(종료 코드 4) 중단한다. 신뢰 정책은 `iam get-role`로 얻은 본인 SSO 역할의 정확한 ARN 하나(`StringEquals aws:PrincipalArn`)다. `AWS_ENDPOINT_URL*`·`AWS_CONFIG_FILE`·`AWS_SHARED_CREDENTIALS_FILE`·`AWS_CA_BUNDLE`가 있으면 거부한다(이 스크립트만). 표가 나오기 전 종료 코드 1~5는 `verify.sh`의 2(SKIP 있음)와 뜻이 다르다(GO-LIVE 4단계). `cleanup.sh`는 임시 역할이 남았으면 경고만 하고 `--cleanup-only`를 안내한다. 임시 역할이 이미 있으면 덮어쓰지 않고 멈춘다(`--cleanup-only` 안내). 임시 자격증명은 호출마다 서브셸에서만 쓰고 출력·로그에 남기지 않는다. 로그는 `rehearsal-logs/<profile>/replica-check.md`. 환경변수 `REHEARSAL_ASSUME_RETRIES`(기본 12), `REHEARSAL_ASSUME_INTERVAL`(기본 5초)로 IAM 전파 대기를 조절한다.
- 계정 12자리는 매번 직접 입력한다. 계정 표, 실제 `sts get-caller-identity` 결과와 모두 같아야 한다.
- preflight는 읽기만 한다. 끝에 사람 관문(7-1 콘솔 등록, 7-4 연결 확인)을 묻는다.
- verify는 허용 목록 추가 **전**에 시작한다. (가) 후 스크립트가 멈추면 중앙에서 `bus-allowlist` `action=add` 를 실행하고 y 로 계속한다. 입력이 없으면 해당 항목은 SKIP 이고, SKIP 이 하나라도 있으면 종료 코드 2 로 끝난다(결과표에 "SKIP 있음").
- (다)에서 태그를 뗀 뒤 스크립트는 알람이 그대로 남는지 `REHEARSAL_WAIT_SECONDS`(기본 900초) 동안 지켜본다. 이 동안 콘솔에서 Stop monitoring 을 누르지 않는다. 누르면 알람이 지워져 D-16 위반 FAIL 로 잘못 판정된다. Needs review 표시는 지금 봐도 되고, Stop 은 스크립트가 "(다) 대기 끝"이라고 물을 때 누른다.
- 결과표 값: PASS(됐다) / FAIL(안 됐다) / FAIL(TIMEOUT, 원인 미상) / SKIP. (라)는 정책 시뮬레이션이라 실측이 아니다.
- 로그는 `rehearsal-logs/<profile>/<runId>.md`(권한 600). 올리지 않는다.
- cleanup은 그 runId 로그에 있는 큐와, 그 큐를 차원으로 가진 `ManagedBy=AlarmOps` 알람만 지운다. `--stack` 은 스택 이름이 `alarmops-customer` 이고 스택 태그 `AlarmOpsRehearsal=true` 일 때만 지운다. 끝에 사람 몫(연결을 끊을 때만: 콘솔 고객사 화면의 Suspend/Terminate, `bus-allowlist` `action=remove`, 스택 삭제)을 출력한다. 계정을 계속 쓰면 하지 않는다.

## 환경변수

`REHEARSAL_ACCOUNTS_FILE`, `REHEARSAL_LOG_DIR`, `REHEARSAL_POLL_INTERVAL`(기본 30초), `REHEARSAL_WAIT_SECONDS`(기본 900초). 자세한 계약은 `infra/test/REHEARSAL-CONTRACT.md`.
