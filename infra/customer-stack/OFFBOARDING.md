# 연결 해제 (오프보딩) 안내

계약이 끝나거나 연결을 끊고 싶을 때의 절차. 순서가 중요하다: **알람 정리 → 스택 삭제 → 확인**.

## 고객이 하는 일

1. (MSP가 먼저 처리) AlarmOps가 만든 알람(태그 `ManagedBy=AlarmOps`)은 MSP가 정리한다. AlarmWriter를 켜지 않은 계정은 목록을 받아 직접 지운다. 목록 확인:

   ```bash
   aws cloudwatch describe-alarms --region ap-northeast-2 --query "MetricAlarms[].AlarmArn" --output text
   aws cloudwatch list-tags-for-resource --region ap-northeast-2 --resource-arn <알람 ARN>
   ```

   `ManagedBy` 태그가 `AlarmOps`인 알람만 AlarmOps 것이다. 다른 알람은 고객 것이므로 건드리지 않는다. 글로벌 자원(CloudFront 등)의 알람은 us-east-1에도 있다.

2. 연결 스택을 삭제한다. 콘솔에서 하거나 아래 명령을 쓴다(스택 이름은 만들 때 정한 이름).

   ```bash
   aws cloudformation delete-stack --region ap-northeast-2 --stack-name <스택 이름>
   aws cloudformation wait stack-delete-complete --region ap-northeast-2 --stack-name <스택 이름>
   ```

   삭제되면 역할 5개와 규칙 2개가 모두 사라진다. 스택이 만들지 않은 것(고객이 붙인 `Monitoring` 태그, 고객의 알람과 자원)은 그대로 남는다. `Monitoring=on` 태그를 지우고 싶으면 고객이 직접 지운다.

3. 삭제 완료를 MSP에 알린다.

## MSP가 확인하는 일

콘솔의 해지 체크리스트(D-43)에서 `ALARMS_DELETED`, `CUSTOMER_STACK_REMOVED`, `ACCOUNTS_DISABLED`, `BUS_ALLOWLIST_REMOVED` 순으로 닫는다. 단계마다 사람이 근거를 보고 완료로 표시한다.

1. **연결 확인이 실패해야 한다.** 콘솔의 해당 계정에서 연결 확인(`CHECK_CONNECTION`)을 실행한다. 스택이 지워졌다면 모든 역할이 `DENIED`(역할이 없어 AssumeRole 거부)여야 한다. 하나라도 `OK`이면 아직 스택이 남아 있다. 고객에게 되묻는다. 해지 고객은 ACCOUNTS_DISABLED가 되어 연결 확인이 `CAPABILITY_DISABLED`/`MISSING`으로 끝나기도 한다. 둘 다 "연결이 끊겼다"는 뜻이며, 확인 시점이 비활성 처리 전이면 `DENIED`가 근거다.

2. **고객 쪽 이벤트가 더 이상 오지 않아야 한다.** 스택 삭제 뒤 이벤트 규칙이 없으므로 새 이벤트가 없다. 확인은 콘솔의 "정리 필요" 표시와 수집 지표로 한다. 삭제 확인 후 1~2일 동안 해당 계정의 수신이 0건이면 정상이다. 오면 규칙이 남은 것이다(고객이 스택 대신 규칙을 따로 만든 경우 등).

3. **중앙 버스 허용 목록에서 제거한다.** 사람이 GitHub Actions `bus-allowlist`를 `action=remove`로 실행한다(절차는 `infra/aws/README.md`). 성공하면 `BUS_ALLOWLIST_REMOVED`를 완료로 표시한다. 이후에는 고객이 규칙을 되살려도 버스가 거절한다.

4. 마지막으로 CloudAccount가 비활성인지, 호출이 멈췄는지 확인한다. DB 기록은 D-45 보관 기간에 따라 지운다(연결 정보는 오프보딩 완료 즉시).

## 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| 스택 삭제 실패 | 고객이 역할에 정책을 따로 붙였다 | 붙인 정책을 분리한 뒤 다시 삭제 |
| 연결 확인이 계속 `OK` | 스택 또는 다른 리전에 같은 스택이 남음 | 스택 목록에서 `AlarmOps-*` 역할을 찾는다 |
| 삭제 후에도 이벤트 수신 | 규칙을 따로 만들었거나 아직 허용 목록에 있음 | 규칙 삭제, `bus-allowlist` 실행 |
| 고객 알람이 지워졌다고 문의 | 태그 `ManagedBy=AlarmOps`만 삭제 대상 | 삭제 기록(`OFFBOARD_ACCOUNT` 결과의 계정별 `deleted`)으로 확인 |

연결을 다시 쓰려면 새 연결(새 ExternalId)로 처음부터 한다. 해지는 되돌리지 않는다.
