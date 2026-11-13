# infra/aws — 중앙 계정 인프라

배포는 사람이 시작하는 GitHub Actions(OIDC)로만 한다. 에이전트는 배포 명령을 실행하지 않는다. 이 폴더의 템플릿은 `cfn-lint`와 `infra/test`(구조 테스트)로 오프라인 검증한다.

## 중앙 이벤트 버스와 허용 목록 (B1, D-07, D-43)

`central-bus.yaml`: 이벤트 버스 `alarmops-central`과 버스 리소스 정책. 정책의 Principal은 파라미터 `AllowedAccountIds`(쉼표로 구분한 12자리 계정 ID)이며, 비어 있으면 정책이 만들어지지 않아 고객 계정은 아무도 넣지 못한다. 고객 연결 스택의 `CentralEventBusArn` 파라미터에는 이 스택의 출력 `CentralBusArn`을 준다.

### 목록을 어디에 두는가 — 결정: CloudFormation 스택 파라미터, 변경은 워크플로 한 곳

| 선택지 | 판단 |
|---|---|
| 저장소에 파일로 체크인 | 고객 계정 ID와 고객의 대응이 저장소 기록에 남고, 해지 때 기록에서 지워지지 않는다. 반려 |
| DB 내보내기를 배포 때 읽기 | Actions에 운영 DB 자격증명이 필요하다. D-40·보안 방침과 충돌. 반려 |
| SSM 파라미터 목록 | 정책으로 바꾸는 단계가 하나 더 생기고, 목록과 실제 정책이 어긋날 수 있다. 반려 |
| **스택 파라미터** | 목록이 곧 정책이라 어긋날 수 없고, 스택 이력(CloudTrail)이 변경 기록이 된다. 채택 |

DB가 연결 정보의 원본이고(`CloudAccount`), 버스의 목록은 그 사본이다. 사본을 바꾸는 일은 `.github/workflows/bus-allowlist.yml` 하나만 한다. 계정 하나를 `add`/`remove`로 바꾸며(전체 덮어쓰기 없음), 현재 값을 스택에서 읽어 `.github/scripts/bus-allowlist.mjs`로 새 목록을 계산하고(멱등: 없는 계정 제거도 성공), 이전 템플릿을 그대로 쓰는 `update-stack`으로 이 파라미터만 바꾼다. 끝나면 `describe-event-bus`로 정책에 계정이 없는지(제거) 또는 있는지(추가) 확인한다.

### 연결 때 (add)

고객이 스택을 만들기 전에 사람이 `bus-allowlist`를 `action=add`로 실행한다. 허용 전에 보낸 이벤트는 버스가 거절하고 고객 쪽 규칙은 실패로 재시도하다 버린다(평소 알람 상태 변화는 허용 뒤 다음 변화부터 들어온다).

### 해지 때 (remove, D-43 단계 `BUS_ALLOWLIST_REMOVED`)

1. 콘솔에서 고객이 `TERMINATED`가 되고 `ALARMS_DELETED`, `CUSTOMER_STACK_REMOVED`, `ACCOUNTS_DISABLED`가 끝난다.
2. 사람이 Actions에서 `bus-allowlist`를 실행한다. `action=remove`, `account_id`(계정마다 한 번), `reference`=offboardingId, `confirm`=계정 ID 다시 입력. `central` 환경의 승인자가 승인해야 돈다.
3. 워크플로가 성공하면(정책에서 계정이 사라진 것을 확인) 사람이 콘솔 체크리스트의 `BUS_ALLOWLIST_REMOVED`를 완료로 표시한다. 자동 표시는 하지 않는다. 이 단계는 `MANUAL`이다.
4. 그 뒤에도 해당 계정에서 이벤트가 오면 목록에서 빠진 것이므로 버스가 거절한다(백엔드에는 닿지 않음). 이미 허용된 상태에서 온 이벤트는 D-43대로 "정리 필요"로 처리된다.

필요한 GitHub 설정(사람이 한 번): `central` 환경(브랜치 `main`만, 필수 승인자), 변수 `CENTRAL_BUS_DEPLOY_ROLE_ARN`(OIDC로 맡는 배포 역할; 버스 스택의 `DescribeStacks`/`UpdateStack`과 `events:DescribeEventBus` 정도만 허용). 스택 이름은 `alarmops-central-bus`로 가정한다.

## 콘솔 배포 전 환경 검사

배포 워크플로는 아직 없다. 만들 때 **배포 단계보다 앞서** 다음 단계를 넣어야 한다(실패하면 배포하지 않는다).

```yaml
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 20 }
      - name: Check the console deploy environment
        env:
          CONSOLE_ORIGIN: ${{ vars.CONSOLE_ORIGIN }}
          TRUSTED_PROXY: ${{ vars.TRUSTED_PROXY }}
          # MOCK_API and E2E_ALLOW_MOCK are deliberately NOT listed: they must not exist.
        run: node .github/scripts/check-console-deploy-env.mjs
```

- 규칙: `CONSOLE_ORIGIN`이 설정돼 있고 `https://host[:port]` 형태(경로·끝 슬래시·자격증명 없음), `TRUSTED_PROXY`가 정확히 `1`, `MOCK_API`와 `E2E_ALLOW_MOCK`은 값이 비어 있어도 **존재하면 실패**.
- 이 스크립트는 단계의 `env:`만 본다. 런타임 설정(ECS 작업 정의, Lambda 환경 변수 등)을 `KEY=VALUE` 파일로 만들어 배포한다면 같은 스크립트를 파일 인자로 한 번 더 부른다: `node .github/scripts/check-console-deploy-env.mjs <파일>`. 이때는 파일만 검사한다. 미래의 배포 작업은 **실제로 배포하는 설정**을 검사해야 한다(검사한 값과 배포한 값이 달라지면 의미가 없다).
- 단계의 `env:`에 `MOCK_API: ${{ vars.MOCK_API }}`처럼 적으면 변수가 비어 있어도 키가 생겨 실패한다. 적지 않는다.
- 테스트: `node --test .github/scripts/check-console-deploy-env.test.mjs` (CI `db`·`infra` 작업이 실행).

## CDN: HTML은 캐시하지 않는다 (nonce CSP)

콘솔은 요청마다 새 nonce를 넣은 CSP를 응답 헤더로 보내고(`apps/console/src/lib/csp.ts`, `middleware.ts`), 같은 nonce가 HTML 안의 `<script nonce=...>`에 들어간다. CDN이나 로드 밸런서가 HTML을 캐시하면 다른 사용자에게 **이전 요청의 nonce가 든 HTML**이 나가고 헤더의 nonce와 어긋나 화면이 깨지며, 캐시된 nonce를 알면 스크립트 주입 방어가 약해진다. 요구 사항:

- HTML 문서(`text/html`, 즉 `/_next/static/` 이외 모든 경로, 특히 `/`, 로그인, `/auth/*`)는 CDN에서 **캐시 안 함**: 캐시 정책은 Caching disabled(TTL 0) 또는 오리진의 `Cache-Control: no-store`를 존중. 오리진이 보내는 `Content-Security-Policy` 헤더는 CDN이 지우거나 덮어쓰지 않는다.
- 캐시해도 되는 것은 파일 이름에 해시가 있는 `/_next/static/*`(불변)과 공개 정적 자원뿐이다. `/api/*`도 캐시하지 않는다.
- CloudFront라면 기본 동작(`*`)에 `CachingDisabled` 관리형 정책 + `AllViewer` 오리진 요청 정책(Host·`X-Forwarded-*`·쿠키 전달), `/_next/static/*` 동작에만 `CachingOptimized`. `TRUSTED_PROXY=1`이므로 오리진 앞의 프록시가 `X-Forwarded-Host`를 **덮어쓰는** 구성이어야 한다(apps/console/README.md).
- 배포 뒤 확인(사람): `curl -sI https://<콘솔>/ | grep -i -E "cache-control|x-cache|age"`에서 `Age`가 없고 `X-Cache`가 `Miss`/`Bypass`, 두 번 요청한 응답의 CSP nonce가 서로 달라야 한다.
