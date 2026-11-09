# 데이터 모델

상태: 4일차에 작성. 아래는 작성 범위와 먼저 정할 질문이다.

## 범위 (Postgres, Prisma)
- 테넌트·조직: Customer, Project, Service, AwsAccount(고객사별), IntegrationSource(Prometheus/Grafana 수신처, 토큰)
- 사람·온콜: User(콘솔 사용자, 역할·범위), Contact, Team, Schedule, Rotation, Override, EscalationPolicy, EscalationStep
- 알림·인시던트: Alert(지문 단위), AlertEvent(원본 이력, 추가만), Incident, IncidentAlert, Ack/Action 기록
- 노이즈: Silence(점검 창), SuppressionDecision(억제 판정 기록)
- 통지: NotifyChannel(검증 상태), Notification(채널, 공급자 메시지 ID, 상태)
- 임계치: ThresholdChange(변경 기록: 누가, 언제, 이전 값, 새 값, 출처). 정본은 고객 계정의 알람(D-08)
- 감사: AuditLog

## 먼저 정할 질문 (DECISIONS.md "아직 정하지 않은 것")
- Ack 단위: 인시던트인가 알림인가
- 지문 규칙: 소스별 정의를 `docs/specs/fingerprint.md`로 확정한 뒤 반영
- 기본 심각도(SEV-5 vs UNKNOWN), 사일런스 범위·보관 방식

## 원칙
- 모든 테이블에 customerId. 고객사 범위 밖 조회를 막는 검사는 앱 계층과 테스트로 강제(Supabase 전용 RLS 금지, D-09 원칙 1)
- 시간은 UTC 저장, 표시는 KST
- 스키마 변경은 `prisma migrate dev`, 배포는 `prisma migrate deploy`
