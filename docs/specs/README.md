# 동작 명세 (기존 두 저장소에서 추출)

이 문서는 기존 두 저장소에서 동작 명세를 뽑는 방법, 만들 명세 10개와 그 출처, 현재 상태를 정한다.

재구축에서 가장 중요한 문서다.

- 기존 코드가 실제로 어떻게 동작하는지, 그리고 과거에 어떤 버그를 고쳤는지를 여기에 옮긴다.
- 이것이 빠지면 같은 버그를 다시 만든다.

## 추출 방법 (2~3일차)
1. 기존 저장소는 읽기 전용으로 클론한다. 수정하지 않는다.
   - `../legacy/aws-alert-manager` (기준 커밋 4eafce9)
   - `../legacy/alert-hub` (기준 커밋 49c83dc)
2. 명세 하나당 에이전트 하나가 코드·테스트·git log를 읽고 초안을 쓴다. 사람이 검토해 확정한다.
3. 각 명세는 같은 형식으로 쓴다:
   - 규칙(번호)
   - 근거(파일:줄, 커밋)
   - 과거 수정 사례
   - 새 구현에서 바꿀 점(있으면 결정 ID와 함께)

## 만들 명세

아래 "주 출처"의 AAM은 aws-alert-manager, AH는 alert-hub다.

| 파일 | 한 줄 |
|---|---|
| `suppression.md` | 억제 판정 |
| `grouping-incident.md` | 그룹·인시던트 |
| `fingerprint.md` | 소스별 지문 |
| `severity.md` | 심각도 |
| `alarm-rules.md` | 리소스별 알람 규칙 |
| `alarm-sync.md` | 알람 생성·동기화 |
| `oncall-escalation.md` | 담당 순서·에스컬레이션 |
| `notification.md` | 통지 |
| `org-tenant.md` | 조직·테넌트 |
| `known-bugs.md` | 고친 버그 목록 |

각 명세의 내용과 주 출처:

- **`suppression.md`**
  - 내용: 억제 판정 순서(SEV-1 면제, 점검 창, flapping, 중복, auto-pause), 시간 창
  - 주 출처: AAM `common/alert_suppression.py`, `docs/specs/alert-pipeline/`
- **`grouping-incident.md`**
  - 내용: 그룹 키, group_wait·grace, 인시던트 상태와 병합·종료 규칙, stale 그룹 처리
  - 주 출처: AAM `alert_group_worker`, `common/incident.py`, 리뷰 F4·F8
- **`fingerprint.md`**
  - 내용: 소스별 지문(CloudWatch series_id, Prometheus fingerprint, Grafana), 중복 판정
  - 주 출처: AAM `alert_ingestor`, AH `src/lib/normalize.ts`, `src/lib/providers/*`
- **`severity.md`**
  - 내용: SEV-1~5 정의, 알람 설명·태그에서 읽는 규칙, 소스별 매핑
  - 주 출처: AAM `ALARM-RULES.md`, AH `badges.tsx`
- **`alarm-rules.md`**
  - 내용: 리소스 29종별 기본 지표·임계치·M/N, 태그 계약(Monitoring, Threshold_*)
  - 주 출처: AAM `resource_types/`, `docs/ALARM-RULES.md`, `monitoring-tag-contract`
- **`alarm-sync.md`**
  - 내용: 생성·동기화·드리프트·재생성 규칙, 수동 등급 우선
  - 주 출처: AAM `alarm_builder.py`, `alarm_sync.py`, 리뷰 F3·F8·F9
- **`oncall-escalation.md`**
  - 내용: 담당 순서 상속, 시간대 온콜·대체 근무, 에스컬레이션 시각 계산, 해결 기록
  - 주 출처: AH `src/lib/routing.ts`, `oncall.ts`, `escalation.ts`, `docs/oncall-paging.md`
- **`notification.md`**
  - 내용: Slack 메시지·버튼·스레드 동기화, 묶음 통지, 재발화 스로틀, 그래프 첨부
  - 주 출처: AH `src/lib/notify/*`, AAM `notification_adapters.py`
- **`org-tenant.md`**
  - 내용: 고객사·프로젝트·서비스·계정 매핑, 미매핑 처리, 고객사 범위 규칙
  - 주 출처: AH `prisma/schema.prisma`, `docs/org-model.md`, `scope.ts`, AAM `authz.py`
- **`known-bugs.md`**
  - 내용: 두 저장소에서 고친 버그 목록과 재발 방지 테스트 아이디어
  - 주 출처: 두 저장소 git log의 `fix:` 커밋, 리뷰 문서

## 현재 상태 (11/9)
- 10개 명세 모두 초안 작성 완료. 사람 검토 후 확정.
- Q-01~Q-07은 모두 결정됨(D-15~D-20, D-08).
- 각 명세의 '새 구현에서 바꿀 점'에 해당 결정 ID를 반영한다.

## 확정 표시
- 각 파일 맨 위에 `상태: 초안 | 검토 중 | 확정`을 적는다.

> **참고** 구현 에이전트는 확정된 명세만 기준으로 삼는다.
