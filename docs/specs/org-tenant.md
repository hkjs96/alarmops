# 조직 · 테넌트 동작 명세

상태: 초안

- 출처: alert-hub(AH) 기준 커밋 49c83dc, aws-alert-manager(AAM) 기준 커밋 4eafce9. 두 저장소는 읽기만 했다.
- 표기: 코드로 확인하지 못하고 미루어 짐작한 내용은 **(추정)**으로 표시한다.

## 1. 모델

**R1-1. 조직은 엄격한 포함 트리다: Customer › Project › Service › AwsAccountMap.** 테넌트는 Project.customerId에서 한 번만 정하고, 다른 곳에서는 위로 거슬러 올라가 구한다. 담당은 이 테이블들의 컬럼으로 두지 않는다. 담당은 Assignment에 두고 네 단계 어디에나 붙일 수 있다. 상위를 지우면 하위도 함께 지운다(Cascade). 이름 유일성은 고객사 전체에서 이름, 고객사 안에서 프로젝트 이름, 프로젝트 안에서 서비스 이름이다.
근거: `AH prisma/schema.prisma:259-339`.

**R1-2. 내부 시스템은 `isInternal` 가짜 고객사 아래에 둔다.** 그래서 Project.customerId가 null이 될 일이 없다.
근거: `AH prisma/schema.prisma:268-270`.

**R1-3. AWS 계정은 서비스 하나에만 속한다(`accountId @unique`).** 계정에는 별칭과 환경(prd/stg/dev)을 둔다. 환경 값은 보강(enrichment)할 때 가장 먼저 참조하는 값이다. 여러 서비스가 함께 쓰는 계정은 나중에 리소스 패턴으로 나누기로 하고 미뤘다.
근거: `AH prisma/schema.prisma:339-350`.

**R1-4. Contact는 `customerId=null`이면 내부 인원, 값이 있으면 그 고객사 담당자다.** 고객사를 지우면 그 담당자도 함께 지운다. 예전에는 SetNull이어서 고객사 담당자가 내부 인원으로 둔갑했다.
근거: `AH prisma/schema.prisma:370-375`. 고친 커밋은 0979b6f.

**R1-5. 고객사에는 다음 설정이 붙는다.**
- `loginDomains`: 고객사 담당자가 로그인할 수 있는 도메인
- `portalGrants`: 포털에서 허용한 쓰기 권한
- `aiInsights`: AI 메모 외부 전송 허용 여부
- `awsExternalId`: 그래프용 교차 계정 역할의 ExternalId. 고객사마다 하나이고 유일하다
- `ingestToken`: 고객사 전용 수집 주소의 토큰. 유일하다

근거: `AH prisma/schema.prisma:271-286`.

## 2. 미매핑 계정

**R2-1. 매핑되지 않은 계정의 알람도 받는다.** 받은 알람에는 `customerId=null`이 붙고, 스냅샷도 담당도 없다. 아무에게도 페이징하지 않는다(에스컬레이션도 없음). 고객사 채널 대신 전사 기본 Slack 채널로 나가고, 메시지에 "계정 미매핑"이라고 표시한다 **(추정: 팬아웃 자체는 일어나고, targets가 비어 전사 기본으로 간다)**. 미매핑 알람은 새 계정을 매핑하는 입구로 쓰인다.
근거: `AH src/server/alerts.ts:101-105`, `AH src/lib/ingest-guard.ts:9-10`, `AH src/lib/notify/slack-format.ts:118-120`.

**R2-2. 미매핑 알람은 전체 범위(ADMIN이나 seeAll)를 가진 사람만 본다.** 대시보드에 "미매핑 AWS 계정 알람 N건" 배너가 뜨고, 그 행에서 바로 매핑할 수 있다(`/admin/map-account`).
근거: `AH src/lib/scope.ts:39-42`, `AH src/app/(app)/page.tsx:122, 172-174, 290-303`, `AH src/app/(app)/admin/map-account/page.tsx:9`.

## 3. 범위 규칙 (scope)

**R3-1. 볼 수 있는 고객사 집합은 다음 순서로 정한다.**
1. 고객사 담당자: 자기 고객사만. 배정이나 역할과 무관하다.
2. ADMIN이거나 `seeAll`: 전체.
3. 그 밖의 내부 인원: 직접 배정과 팀을 거친 배정이 걸린 고객사들. 배정이 어느 단계에 있든 고객사로 환산한다.
4. open 모드(SSO 꺼짐): 전체.
5. SSO 모드에서 세션이 없거나 ACTIVE가 아니면: 빈 집합.

근거: `AH src/lib/scope.ts:1-43`, `AH src/server/scope.ts:12-41`.

**R3-2. 단건 작업은 알람이 범위 밖이면 forbidden이다(`assertAlertInScope`).** Slack 버튼처럼 세션이 없는 경로는 contact를 기준으로 같은 판정을 한다(`scopeForContact`).
근거: `AH src/server/scope.ts:13-30, 43-52`, `AH src/app/api/slack/interactive/route.ts:98-102`.

**R3-3. AAM은 다음과 같다.**
- `ADMIN_EMAILS`에 든 사람은 전체를 본다.
- 일반 사용자는 고객사 `managers` 목록에 자기 이메일이 있는 고객사와 그 고객사의 계정만 본다.
- `ADMIN_EMAILS`가 비어 있으면 제한이 없다.
- 이메일이 없거나 범위 조회가 실패하면 닫는 쪽으로 처리한다(아무것도 보이지 않음).
- 항목 판정은 customer_id로 하고, 없으면 account_id로 한다. 둘 다 없으면 관리자만 본다.
- 작업(job)은 대상이 **모두** 범위 안이어야 볼 수 있다.
- 범위 밖 단건 요청에는 404를 돌려준다.

근거: `AAM backend/api_handler/authz.py:1-98`. 고친 커밋은 cb9410d(job 상태 조회에도 같은 범위를 적용).

## 4. 역할과 포털

**R4-1. 내부 인원의 역할은 세 가지다.** 순위는 VIEWER < OPERATOR < ADMIN이다.
- ADMIN: 등록 관리 전체, 가입 승인, 알람 처리
- OPERATOR: Ack/Resolve, 점검 창, 자기 프로필
- VIEWER: 조회만

기본값은 OPERATOR다.
근거: `AH src/lib/auth/roles.ts:1-40`, `AH prisma/schema.prisma:397-399, 610-614`.

**R4-2. 가입 흐름.** SSO로 처음 들어온 사람은 PENDING이 되고, 관리자가 승인하면 ACTIVE가 된다. 관리자가 화면에서 미리 등록한 사람은 처음부터 ACTIVE다. `AUTH_BOOTSTRAP_ADMINS`에 있는 이메일은 바로 ADMIN이자 ACTIVE가 된다. 비활성(active=false)인 사람은 로그인이 거부된다.
근거: `AH prisma/schema.prisma:400-403`, `AH src/server/auth.ts:57-95, 194-253`. 처음 넣은 커밋은 c73816b.

**R4-3. 고객사 담당자의 로그인.** 고객사의 `loginDomains`에 있는 도메인으로 SSO하면 그 고객사 소속 계정이 된다. 고객사 담당자의 역할은 **항상 VIEWER로 강제**하고, seeAll은 false다. loginDomains가 비어 있으면 그 고객사 사람은 로그인할 수 없다. 고객사 담당자는 Slack 버튼으로도 알람을 처리할 수 없다.
근거: `AH src/server/auth.ts:81-94, 181-186`, `AH src/app/api/slack/interactive/route.ts:73-76`.

**R4-4. MSP가 고객사마다 켜 주는 쓰기 권한(portalGrants)은 contacts, silences, channels 세 가지다.** 기본값은 비어 있고, 비어 있으면 읽기 전용이다. 모든 포털 작업은 첫 줄에서 `requirePortal(grant)`을 부른다. 이 검사는 고객사 계정인지와 그 권한이 켜져 있는지를 함께 본다. 폼으로 넘어온 customerId는 읽지 않고 세션의 customerId만 믿는다. 대상 id의 소유는 DB에서 다시 확인한다(`assertOwnedContact`, `assertOwnedSilence`, `assertOwnedChannel`). 변경은 AuditLog에 남긴다.
근거: `AH src/lib/portal.ts:6-37`, `AH src/server/portal.ts:9-90`. 처음 넣은 커밋은 0979b6f.

## 5. 수집 인증과 계정 위조 방지 (ingest-guard)

**R5-1. 수집 토큰은 두 종류다.** 공용 토큰(`INGEST_TOKEN`)과 고객사 전용 토큰(`Customer.ingestToken`, `in_` 접두사에 무작위 20바이트 hex)이다. 토큰은 `x-webhook-token` 헤더나 `?token=`으로 받는다. SNS와 PagerDuty는 헤더를 붙일 수 없기 때문이다. 비교는 constant-time으로 한다. 고객사 토큰을 다시 발급하면 이전 주소는 바로 무효가 된다. **`INGEST_TOKEN`이 설정되지 않았으면 토큰 검사 자체가 없다**: 조건이 `token && !tokenCustomer && !safeEqual`이라 공용 토큰이 없으면 통과한다.
근거: `AH src/app/api/webhooks/[provider]/route.ts:78-88`, `AH src/lib/ingest-guard.ts:62-65`, `AH prisma/schema.prisma:284-286`. 처음 넣은 커밋은 02d191a.

**R5-2. SNS 봉투(`Type`과 `TopicArn`이 있는 본문)는 먼저 서명을 확인한다.** `SNS_VERIFY=false`이면 확인을 끈다. SubscribeURL은 `https://sns.<region>.amazonaws.com`일 때만 가져온다(SSRF 방지). 본문이 1MB를 넘으면 413을 돌려준다.
근거: `AH src/app/api/webhooks/[provider]/route.ts:90-160`. 고친 커밋은 02d191a.

**R5-3. 알람 판정 규칙(`checkAlert`)은 두 가지다.**
1. 고객사 전용 주소로 온 알람의 계정이 다른 고객사에 매핑돼 있으면 거부한다.
2. 등록된 고객사 계정을 내세운 알람이 **SNS로 왔다면**, 서명된 TopicArn의 계정도 같은 고객사에 매핑돼 있어야 한다. 알람 본문의 계정(AlarmArn)은 보낸 쪽이 적는 값이라 믿을 수 없고, TopicArn은 SNS가 서명한 값이라 믿을 수 있다.

미매핑 계정의 알람은 통과시킨다. 거부한 알람은 IngestRejection(kind, reason, account, topicArn, title, customerId)에 남기고, 나머지는 계속 받는다.
근거: `AH src/lib/ingest-guard.ts:1-46`, `AH src/server/ingest-guard.ts:26-78`.

**R5-4. 구독 확인(`checkSubscription`).** 고객사 전용 주소라면 주제의 계정이 그 고객사에 매핑돼 있어야 받는다. 공용 주소는 받는다. 미매핑 알람은 페이징하지 않으므로 위험이 작다고 보았다.
근거: `AH src/lib/ingest-guard.ts:48-60`.

**R5-5. 알려진 공백: TopicArn 없이 직접 POST한 요청은 규칙 2를 건너뛴다.** 판정이 `fromSns`일 때만 주제 계정을 확인하고, `fromSns`는 본문에 `Type`과 `TopicArn`이 있을 때만 true다. 그래서 **공용 토큰을 아는 사람(또는 공용 토큰이 설정되지 않은 환경의 누구나)이 SNS 봉투 없이 CloudWatch 형식 JSON에 남의 등록 계정 ID를 적어 보내면, 그 알람이 통과해 해당 고객사 담당자를 페이징한다.** 고객사 전용 토큰으로 보내면 규칙 1이 자기 고객사 계정만 허용하므로, 다른 고객사를 겨냥한 위조는 막힌다. 다만 자기 고객사 안에서 계정을 바꿔 적는 것까지 막지는 않는다.
근거: `AH src/lib/ingest-guard.ts:37`(`i.fromSns &&`), `AH src/server/ingest-guard.ts:58`, `AH src/app/api/webhooks/[provider]/route.ts:120-127, 197-201`.

## 6. AAM 고객사 · 계정

- 고객사 테이블과 계정 테이블(계정에 customer_id가 있음)은 DynamoDB다. 계정 수(account_count)는 목록을 조회할 때 계정 테이블을 스캔해 다시 계산한다. 스캔이 실패해도 목록은 돌려준다.
  근거: `AAM backend/api_handler/routes/customers.py:22-45`.
- 고객사의 `managers`(이메일 목록)가 범위의 근거다(R3-3). 소문자로 바꾸고 공백과 중복을 없앤다.
  근거: `AAM backend/api_handler/authz.py:22-31`.

## 과거 수정 사례

| 커밋 | 내용 |
|---|---|
| AH 0979b6f | Contact.customer가 SetNull이어서 고객사를 지우면 그 담당자가 내부 인원으로 둔갑했다. Cascade로 바꿨다. 포털 쓰기 권한, 위조 요청 3중 방어(세션 customerId만 신뢰, 대상 소유 재확인, 권한 확인)도 이 커밋에서 넣었다 |
| AH 02d191a | SubscribeURL SSRF, query 토큰, constant-time 비교, 본문 상한 |
| AH 4bb47b8 | AI 메모가 고객사의 외부 전송 거부를 우회했다 |
| AH c20e6f0 | 조직 편집의 동시성 문제와 유니크 제약 누락 |
| AAM cb9410d | job 상태 조회가 고객사 범위를 따르지 않았다 |

## 새 구현에서 바꿀 점

1. **위조 방지 공백(R5-5)을 막는다.** 등록된 고객사 계정을 내세우는 알람은 신뢰할 수 있는 출처 증거가 있을 때만 받는다. 증거는 SNS 서명과 같은 고객사의 TopicArn, 또는 그 고객사 전용 토큰 중 하나다. 공용 토큰으로 직접 POST한 알람은 미매핑으로 강등하거나 거부한다. 공용 토큰이 설정되지 않았으면 서버가 시작하지 않게 한다(fail-closed). 이 규칙은 security 검토의 [차단] 항목으로 둔다.
2. **범위 판정은 백엔드 한 곳에서 한다.** D-09 원칙에 따라 `auth.uid()`나 RLS를 쓰지 않고, 앱 계층에서 고객사 id 집합을 구해 모든 질의에 적용한다. 미매핑 알람은 전체 범위만 본다는 규칙은 그대로 둔다. 범위 조회가 실패하면 닫는 쪽(AAM)을 따른다.
3. **역할 3종, 고객사 담당자 VIEWER 강제, portalGrants 항목별 허용, 세션 customerId만 신뢰, 소유 재확인은 그대로 옮긴다.**
4. **SSO가 꺼진 open 모드는 PoC에서도 운영 환경에 두지 않는다.** open 모드는 전체 범위를 주기 때문이다.
5. **(D-11) 온콜 대상 Contact의 연락처 확인 상태를 조직 화면에서 보이게 한다**(notification.md R9).
