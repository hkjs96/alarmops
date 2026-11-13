# infra/customer-stack — 고객 연결 스택 (D-07)

`template.yaml` 하나가 고객 계정에 역할 5개와 EventBridge 규칙 2개를 만든다. 리전은 서울(ap-northeast-2). 고객이 직접 만든다(콘솔이 파라미터를 채운 링크/명령을 준다). 해지는 [OFFBOARDING.md](OFFBOARDING.md).

## 파라미터

| 이름 | 설명 |
|---|---|
| `CentralRoleArn` | 신뢰할 중앙 역할 하나의 ARN(`:role/`만 허용, 계정 root 불가) |
| `ExternalId` | 콘솔이 연결마다 발급, 16자 이상, 기본값 없음 |
| `CentralEventBusArn` | 중앙 버스 ARN(출력 `CentralBusArn`). 먼저 허용 목록에 계정이 추가돼 있어야 한다 |
| `EnableAlarmWriter`, `EnableTagWriter`, `EnableRemediator` | 기본 `false` |

## 역할별 권한 목록

모든 역할: 최대 세션 1시간(엔진은 15분으로 요청), 신뢰는 `CentralRoleArn` + `sts:ExternalId`(EventForwarder 제외, 아래).

| 역할 | 필수 | 허용 | 명시적 Deny / 제한 |
|---|---|---|---|
| `AlarmOps-Reader` | 예 | CloudWatch 조회(`DescribeAlarms*`, `ListMetrics`, `ListTagsForResource`, `GetMetricData`, `GetMetricStatistics`, `GetMetricWidgetImage`), `tag:GetResources/GetTagKeys/GetTagValues`, 자원 종류별 Describe/List(템플릿의 `ResourceInventoryAndTags`, 수집기 작성 때 29종에 맞춰 조정) | `secretsmanager:*`, `ssm:GetParameter(s)`·`GetParametersByPath`·`GetParameterHistory`, `s3:GetObject*`·`ListBucket*`, `kms:Decrypt`·`GenerateDataKey*`·`ReEncrypt*` |
| `AlarmOps-EventForwarder` | 예 | `events:PutEvents` on `CentralEventBusArn` 하나 | 신뢰 주체는 `events.amazonaws.com`, `aws:SourceAccount`=이 계정, `aws:SourceArn`=이 계정의 `rule/AlarmOps-*` |
| `AlarmOps-AlarmWriter` | 선택 | `DescribeAlarms`; 알람 ARN에 `ListTagsForResource`; 새 알람 `PutMetricAlarm`·`TagResource`는 `aws:RequestTag/ManagedBy=AlarmOps`일 때만; 기존 알람 `PutMetricAlarm`·`TagResource`·`UntagResource`·`DeleteAlarms`는 `aws:ResourceTag/ManagedBy=AlarmOps`일 때만 | `UntagResource`로 `ManagedBy` 제거 금지, 이미 `ManagedBy`가 있는 알람에 `TagResource`로 `ManagedBy` 변경 금지 |
| `AlarmOps-TagWriter` | 선택 | `tag:TagResources`와 서비스별 태그 API(`ec2:CreateTags`, `rds:AddTagsToResource`, `elasticloadbalancing:AddTags`, `lambda:TagResource`, `sqs:TagQueue`, `sns:TagResource`, `dynamodb:TagResource`, `elasticache:AddTagsToResource`, `ecs:TagResource`, `es:AddTags`, `kafka:TagResource`)는 `ForAllValues:StringEquals aws:TagKeys=[Monitoring]` 그리고 `aws:TagKeys` 존재일 때만 | S3·Route 53 태그 쓰기 없음. **서비스 목록은 잠정**: 29종 검증 과제(`docs/specs/alarm-rules.md`) 결과로 확정 |
| `AlarmOps-Remediator` | 선택 | `ec2:StopInstances`, `rds:StopDBInstance`, `rds:StopDBCluster`, `elasticloadbalancing:DeleteLoadBalancer`, 모두 `aws:ResourceTag/Monitoring=on`일 때만 | 그 밖의 쓰기 없음. 실제 호출은 Slack 사람 승인 뒤에만 일어나도록 백엔드가 보장한다(D-15) |

### 알려진 한계 (보안 검토 때 확인)

- **ManagedBy 값은 `AlarmOps`** (엔진 `naming.MANAGED_BY`). 기존 도구의 `AlarmManager` 값은 이 역할로 지울 수 없다(옛 알람 이전은 별도 절차, D-08).
- **`DeleteAlarms`의 `aws:ResourceTag` 지원** 은 AWS 문서의 CloudWatch 작업·조건 키 표(`DeleteAlarms` 행의 alarm 리소스 유형)로 사람이 한 번 확인해야 한다. 지원하지 않으면 IAM은 삭제를 막지 못하고 엔진의 재확인(`offboard.py`·`sync.py`가 삭제 직전에 태그를 다시 읽음)이 유일한 방어가 된다. 이 환경에서는 문서를 조회하지 못해 **미확인**이다.
- **같은 이름의 고객 알람 덮어쓰기**: `PutMetricAlarm`에 `ManagedBy=AlarmOps` 태그를 실어 보내면 IAM만으로는 같은 이름의 기존 고객 알람(태그 없음) 덮어쓰기를 구분하지 못한다("기존 알람에 태그가 없음"을 조건으로 쓸 수 없다). 엔진이 생성 전에 `DescribeAlarms`로 이름 충돌을 확인한다.
- `UntagResource`는 `AlarmOps:Console:*` 같은 콘솔 태그를 지우기 위해 소유 알람에 허용된다(엔진 `engine.py`). `ManagedBy`만 Deny로 보호한다.
- `tag:TagResources` 자체의 `aws:TagKeys` 지원과 서비스별 태그 API의 조건 키 지원은 검증 과제에서 유형별로 확인한다. 지원하지 않는 유형은 이 역할에서 뺀다.

### EventForwarder와 ExternalId

EventBridge 규칙은 `events.amazonaws.com`이 역할을 맡아 중앙 버스로 보낸다. 서비스 주체는 ExternalId를 보내지 않으므로 `sts:ExternalId` 조건을 걸 수 없다. 대신 혼동된 대리인 방어(`aws:SourceAccount`, `aws:SourceArn`)로 이 계정의 `AlarmOps-*` 규칙만 이 역할을 쓸 수 있게 했고, 중앙 계정은 이 역할을 맡지 않는다(엔진 `check_connection`도 맡지 않는다). "모든 역할에 ExternalId"를 문자 그대로 요구하는 D-07과의 차이이므로 사용자 확인이 필요하다.

### 전달하는 이벤트

- `AlarmOps-AlarmStateChange`: `aws.cloudwatch` / `CloudWatch Alarm State Change`
- `AlarmOps-TagChange`: CloudTrail 관리 이벤트 중 태그 추가·삭제 API(`CreateTags`, `DeleteTags`, `AddTagsToResource`, `RemoveTagsFromResource`, `AddTags`, `RemoveTags`, `TagResource`, `UntagResource`, `TagResources`, `UntagResources`, `TagQueue`, `UntagQueue`). 전역 서비스(IAM, CloudFront, Route 53)의 이벤트는 us-east-1에서 나오므로 서울 스택으로는 오지 않는다.

## 오프라인 검증

```bash
pip install "cfn-lint>=1,<2"
cfn-lint infra/customer-stack/template.yaml infra/aws/central-bus.yaml
python -m unittest discover -s infra/test -v
```

`sam validate`는 SAM 변환이 없는 순수 CloudFormation이라 해당이 없고(이 템플릿에 `Transform`이 없다), 이 환경에는 SAM CLI도 없다. 중앙 계정의 SAM 템플릿이 생기면 그쪽에 `sam validate --lint`를 단다.
