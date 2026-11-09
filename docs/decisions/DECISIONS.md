# 확정된 결정 (AlarmOps PoC)

계획서: AlarmOps PoC 계획서 v3 (https://claude.ai/artifact/3Kvfvq3tHmGBiDp3WhVxf4). 결정이 바뀌면 이 파일과 계획서를 같이 고친다.

| ID | 결정 | 이유 | 확정일 |
|---|---|---|---|
| D-01 | 콘솔 언어는 영어 | aws-alert-manager가 이미 영어로 전환, 사용자 확정 | 11/8 |
| D-02 | PoC 최우선, 최대한 빨리 출시 | 사용자 목표 | 11/9 |
| D-03 | 새 저장소에서 재구축. 기존 두 저장소는 고치지 않고 동작 규칙과 과거 수정 사례만 명세로 가져온다 | 두 저장소의 데이터 모델·인증·배포가 모두 달라 합치는 비용이 큼 | 11/9 |
| D-04 | UI는 alert-hub 디자인 시스템으로 새로, 인시던트 중심, 두 앱 기능 통합 + 개선 | 사용자 판단(디자인), 페르소나 검토에서 인시던트 화면 부재가 최대 결함 | 11/9 |
| D-05 | 8주 PoC, 2주차 말 속도 점검, 알람 엔진(29종)은 재설계 없이 이식 | 알람 엔진이 가장 큰 덩어리이고 이미 검증됨 | 11/9 |
| D-06 | 비CloudWatch 고객 예시는 Prometheus/Grafana | 사용자 지정 | 11/9 |
| D-07 | 고객 IAM 역할 목적별 분리, 스택 하나: Reader·EventForwarder(필수), AlarmWriter·TagWriter·Remediator(선택). TagWriter는 `Monitoring` 키만, S3·Route53 제외. ExternalId 필수, 특정 중앙 역할만 신뢰 | 고객 보안 심사, RCA 에이전트는 읽기 전용이어야 함, 선택 기능은 고객이 고름 | 11/9 (11/9 Q-02로 TagWriter 추가) |
| D-08 | 임계치: 리소스 태그(Threshold_*)는 읽기만(최우선). 콘솔 변경은 우리가 만든 알람에 저장. 중앙 DB는 변경 기록. 알람 이름에는 임계치를 넣지 않음(리소스 + 지표로 고정, 변경은 제자리 수정) | 고객 IaC(Terraform) 관리 주체와 무관하게 영향 최소화, 값이 고객 계정에 남아 유실 대비 | 11/9 |
| D-09 | 중앙 핵심(콘솔, Postgres, 에스컬레이션)은 Vercel + Supabase(서울). AWS에서만 가능한 것(고객 이벤트 수집, 알람 엔진, IAM 연동)은 AWS. 모든 알림은 AWS 수집 + SQS 경유 | PoC 속도, 관계형 데이터 적합. 나중에 전부 AWS로 옮길 때 고객 쪽 변경 없음 | 11/9 |
| D-10 | 운영 조건: Vercel Pro, Supabase Pro + PITR, 1분 에스컬레이션 + heartbeat, SQS DLQ 알림, prisma migrate | 기존 alert-hub의 하루 1회 cron, db push 결함 재발 방지 | 11/9 |
| D-11 | 온콜은 자체 구축(Postgres + pg_cron) + Slack + 국내 문자·음성 업체 + 이메일 | AWS Incident Manager 신규 중단, AWS 문자는 한국 발신번호 불가 | 11/9 |
| D-12 | 개발은 회사 Windows PC에서 허브 + 역할 에이전트(동시 2개), 배포는 GitHub Actions OIDC | 실고객 접근이 회사 PC에서만 가능, 1인 개발 | 11/9 |
| D-13 | 실고객 계정 작업은 사람이 회사 PC에서 SSO·MFA로. 에이전트는 실고객 자격증명을 쓰지 않음 | 회사 정책 | 11/9 |
| D-14 | RCA 에이전트(HolmesGPT 기반, AgentCore)는 PoC 이후. 인시던트 상세에 자리만 확보 | PoC 범위 | 11/9 |
| D-15 | 자동 조치(무단 변경 시 EC2·RDS 중지, ELB 삭제) 포함. 고객사별 선택(기본 꺼짐), 처음엔 알림만 모드, 실제 실행은 Slack에서 사람 승인. 권한은 Remediator 역할에만 | 기존 기능 유지, 과격한 동작이라 안전장치 필수 | 11/9 (Q-01) |
| D-16 | `Monitoring=on` 태그는 고객이 붙이거나 TagWriter로 콘솔이 붙임. 태그가 밖에서 사라져도 알람을 지우지 않고 "확인 필요"로 표시 | Terraform 등이 태그를 지워 알람이 삭제되는 사고 방지 | 11/9 (Q-02) |
| D-17 | 점검 창 규칙은 모든 소스에 하나: SEV-1은 점검 창 중에도 울림, SEV-2 이하는 묵음 | 규칙 통일 | 11/9 (Q-04) |
| D-18 | 외부 심각도는 표준 매핑표 하나로 SEV-1~5에 매핑(소스별·고객사별 예외 없음, PoC) | 규칙 통일 | 11/9 (Q-05) |
| D-19 | 임계치 기본값 계층은 4단계: 코드 기본값 < MSP 전체 기본값(콘솔) < 고객사 기본값 < 리소스별 값(콘솔 또는 고객 태그, 태그 우선). 환경변수 기본값 계층 없음. 모든 값의 출처를 콘솔에 표시 | 재배포 없이 바꾸고 출처가 보이게 | 11/9 (Q-06) |
| D-20 | 에스컬레이션 반복 횟수는 정책별 설정, 기본 1회 반복 | 마지막 단계에서 멈추는 문제 | 11/9 (Q-07) |
| D-21 | 제품 이름은 AlarmOps(PoC용, 바뀔 수 있음) | 기능이 드러나는 이름 | 11/9 |
| D-22 | SQS 큐는 2개: 들어온 알림(alert-events), 알람 작업(alarm-commands). 각각 DLQ | "SQS만 쓴다"는 기술 한정이지 개수 제한이 아님 | Q-API-01 |
| D-23 | 1분 틱은 PoC에서 Supabase pg_cron(+pg_net)으로 엔드포인트 호출. AWS 이전 때 EventBridge Scheduler로 교체 | PoC 속도 우선, 교체 범위는 호출 1곳 | Q-API-02 |
| D-24 | Ack는 인시던트 단위만. 한 번 누르면 묶인 알림 전체가 확인되고 에스컬레이션이 멈춤. 알림 단위 Ack는 PoC에서 제공하지 않음 | 담당자는 사건을 보고 대응함, 버튼 하나가 단순 | Q-DM-05 |
| D-25 | Prometheus/Grafana `critical`은 SEV-2. SEV-1은 고객이 명시적으로 지정한 경우만 | SEV-1은 점검 창도 통과(D-17)하므로 남용 방지 | Q-DM-08 |
| D-26 | 상단 메뉴는 Incidents / Monitoring / On-call / Customers / Settings. Monitoring은 독립 메뉴(고객사 횡단 알람·임계치·"Needs review" 리소스), 고객사 상세에는 같은 Monitoring 화면을 그 고객사로 필터해 보여 준다 | 알람 운영자(민재)는 고객사를 가로질러 일하고, 고객사 관점은 필터로 충분. 화면 하나만 유지 | 11/9 (사용자 승인) |
| D-28 | ~~On-call은 팀당 한 화면: 로테이션 순서 하나(현재 당번이 맨 앞, 팀 기본 순서·별도 스냅샷 개념 노출 없음), 에스컬레이션은 프리셋(Standard/Urgent/Quiet) 선택 + 실명 문장, 단계 편집기는 Advanced에 접어 둠, 대체·교환은 상대 수락 후 반영. 온보딩 On-call 단계는 팀·프리셋 2문항~~ **일부 대체(D-30·D-31 개정, 11/9): "팀당 한 화면"·"팀·프리셋 2문항"은 폐기. 대체·교환 상대 수락, 실명 문장 미리보기, 프리셋은 유지** | 사용자 검토: PagerDuty식 개념이 3~5명 팀에 과함, 순서가 세 곳에서 정의됨, 모바일 당번 작업이 묻힘 | UI 검토 11/9 |
| D-29 | ~~연락처 분리: MSP 직원은 On-call › Contacts에 팀별로, 고객 담당자는 Customer › People에서 고객/프로젝트/서비스 범위로 붙이고 알림만(역할 Notify only·Approver·Portal user), 로테이션에 절대 넣지 않음. Contact.kind INTERNAL\|CUSTOMER + ContactScope~~ **일부 대체(D-31 개정): 고객 담당자도 Pageable 역할이면 호출·로테이션 가능. 직원/고객 목록 분리와 Contact.kind는 유지, 고객 담당자는 Customer › Responders에서 관리** | 사용자 검토: 직원·고객이 섞인 한 목록은 사람이 늘면 검색해야 하는 긴 목록이 됨 | UI 검토 11/9 |
| D-30 | **(개정)** 고객사마다 자기 **Responders**(MSP 직원 + 그 고객 사람)와 **페이징 단계**를 가진다. 단계 대상은 셋: 특정 사람(PERSON, 직원·고객 모두), 로테이션 당번(ROTATION, 고객 로테이션 또는 공용 MSP 로테이션), Responders 전원(ALL_RESPONDERS, 순서 없음). 순서 방식은 고객마다 다름: All at once / Customer rotation / Shared MSP rotation / Custom steps(혼합, 예: MSP 야간 데스크 → 10분 고객 담당자 전화). Standard/Urgent/Quiet는 고객 단계를 만드는 시작 템플릿일 뿐(공유 계획 아님, 고치면 "edited"). 서비스·프로젝트별 덮어쓰기 선택, 해석은 service › project › customer 첫 번째. 화면 문장은 실명. <br>~~구 D-30: 에스컬레이션 타이밍: 알림 계획(Standard/Urgent/Quiet)은 팀 소유. 고객은 계획 하나를 고르고, 필요하면 고객 단위 타이밍(계획 단계 복사본을 고친 것)을 둔다. 고객 맥락에서 고치면 그 고객만, 팀 계획을 고치면 그 계획을 쓰는 고객 중 자기 타이밍이 없는 고객에게만 적용("applies to N … except X"). 배지 "Mirae Pay · Urgent (customized)". 다른 팀을 쓰는 서비스에는 고객 타이밍이 적용되지 않음~~ (대체됨) | 사용자 지적: 팀 공유 모델이 실제 운영(고객마다 사람·순서가 다름)과 다름 | 사용자 지시 11/9 (개정) |
| D-31 | **(개정)** "팀" 개념을 없앤다(UI·문서·데이터). 30+ 고객 운영은 ① On-call › People: 직원별 담당 고객·지금 당번·다음 당번, ② 일괄 작업: 휴가 대체("Junho 11/20–24 → Minjae", 영향 고객·단계·시프트 미리보기 후 적용, 감사 기록), 직원을 여러 고객에 추가, ③ Responder 템플릿(MSP 직원 묶음, 예 "Infra core") — 고객에 적용, 템플릿 변경 시 영향 고객 미리보기. 공용 MSP 로테이션은 On-call › Rotations, 고객 로테이션은 고객 상세. On-call 메뉴 = Now · Rotations · People · Templates · Maintenance. 고객 사람 역할: Pageable / Notify only (+ Auto-fix approver, Portal). <br>~~구 D-31: 팀은 MSP 직원 당번 그룹(몇 개)이며 고객마다 만들지 않는다. 여러 고객이 한 팀을 쓰고, 고객 담당자는 연락처(D-29)이지 팀이 아니다. 화면: Teams 목록 표+검색, Customers 목록 "On-call team" 열, 온보딩 "기존 팀을 고른다" 안내~~ (대체됨) | 직원은 여러 고객에 겹침(준호 12곳), 고객별 화면만으로는 휴가·인원 변경이 고객 수만큼 반복됨 | 사용자 지시 11/9 (개정) |
| D-27 | 알람 판단 방식은 지표마다 따로: 임계치, 통계(Average 등), 주기(1·5·15·60분), M of N. 기본은 등급 정책(SEV-1 1/1, SEV-2·3 2/3, SEV-4·5 3/5). 주기·통계·M/N도 임계치와 같은 우선순위와 출처 표시(D-19), 같은 알람 제자리 수정(D-08) | 사용자 지적: 지표별 평가 기간·주기 설정 필요 | UI 검토 |

## 이전을 쉽게 만드는 개발 원칙 (D-09에 딸림)
1. Postgres 표준 기능만. Supabase Auth·Realtime·Storage·Edge Functions, `auth.uid()` 기반 권한 규칙 금지. 로그인은 앱에서 Google SSO.
2. 큐는 SQS 하나. pg_cron은 1분 틱 엔드포인트 호출에만.
3. Vercel 전용 저장소(KV, Blob, Edge Config)와 Vercel cron 금지.
4. 설정은 환경변수, AWS 부분은 처음부터 IaC(SAM).
5. 리전은 서울.
6. DB 접근은 Prisma 한 경로, 스키마 변경은 prisma migrate로만.

## 아직 정하지 않은 것 (1주차)
- ~~메뉴 구성~~(D-26), 콘솔 사용자 권한(역할·범위·토글), 지문 규칙(소스별), Ack 단위(인시던트/알림), 기본 심각도·사일런스 규칙, Claude 계정 종류와 요금제

### 명세 추출(11/9)에서 나온 Q-01~Q-07
모두 결정됨 → D-15~D-20, D-08(Q-03: 알람 이름에서 임계치 제외).
