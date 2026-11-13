# infra/customer-stack — 고객 연결 스택 (D-07)

`template.yaml` 하나가 고객 계정에 역할 5개와 EventBridge 규칙 2개를 만든다. 리전은 서울(ap-northeast-2). 고객이 직접 만든다(콘솔이 파라미터를 채운 링크/명령을 준다). 해지는 [OFFBOARDING.md](OFFBOARDING.md).

## 파라미터

| 이름 | 설명 |
|---|---|
| `CentralRoleArn` | 신뢰할 중앙 역할 하나의 ARN(`:role/`만 허용, 계정 root 불가) |
| `RemediatorCallerRoleArn` | `EnableRemediator=true`일 때 필수. 승인된 조치를 실행하는 **별도** 중앙 역할 ARN. Remediator는 `CentralRoleArn`을 신뢰하지 않는다 |
| `ExternalId` | 콘솔이 연결마다 발급, 16자 이상, 기본값 없음 |
| `CentralEventBusArn` | 중앙 버스 ARN(출력 `CentralBusArn`). 먼저 허용 목록에 계정이 추가돼 있어야 한다 |
| `EnableAlarmWriter`, `EnableTagWriter`, `EnableRemediator` | 기본 `false` |

## 역할별 권한 목록

모든 역할: 최대 세션 1시간(엔진은 15분으로 요청), 신뢰는 `CentralRoleArn` + `sts:ExternalId`(EventForwarder 제외, 아래).

| 역할 | 필수 | 허용 | 명시적 Deny / 제한 |
|---|---|---|---|
| `AlarmOps-Reader` | 예 | CloudWatch 조회(`DescribeAlarms*`, `ListMetrics`, `ListTagsForResource`, `GetMetricData`, `GetMetricStatistics`, `GetMetricWidgetImage`), `tag:GetResources/GetTagKeys/GetTagValues`, 자원 종류별 Describe/List. **Lambda는 `ListFunctions`·`GetFunction*`를 주지 않는다**(환경 변수에 비밀값이 있을 수 있음): 발견은 `tag:GetResources`(ARN·태그만)와 `cloudwatch:ListMetrics`로 한다. 이 목록은 (템플릿의 `ResourceInventoryAndTags`, 수집기 작성 때 29종에 맞춰 조정) | `secretsmanager:*`, `ssm:GetParameter(s)`·`GetParametersByPath`·`GetParameterHistory`, `s3:GetObject*`·`ListBucket*`, `kms:Decrypt`·`GenerateDataKey*`·`ReEncrypt*` |
| `AlarmOps-EventForwarder` | 예 | `events:PutEvents` on `CentralEventBusArn` 하나 | 신뢰 주체는 `events.amazonaws.com`, `aws:SourceAccount`=이 계정, `aws:SourceArn`=이 계정의 `rule/AlarmOps-*` |
| `AlarmOps-AlarmWriter` | 선택 | `DescribeAlarms`; 알람 ARN에 `ListTagsForResource`; **생성**은 `PutMetricAlarm` 한 번에 `Tags`로 `ManagedBy=AlarmOps`를 실을 때만(`aws:RequestTag`); 기존 알람의 `PutMetricAlarm`·`TagResource`·`UntagResource`·`DeleteAlarms`는 `aws:ResourceTag/ManagedBy=AlarmOps`일 때만 | `TagResource`·`UntagResource`는 `aws:TagKeys`에 `ManagedBy`가 있으면 항상 거부(생성 뒤 추가·변경·제거 불가). 이미 있는 알람에 `ManagedBy`를 붙이는 권한은 없다 |
| `AlarmOps-TagWriter` | 선택 | `tag:TagResources`와 서비스별 태그 API(`ec2:CreateTags`, `rds:AddTagsToResource`, `elasticloadbalancing:AddTags`, `lambda:TagResource`, `sqs:TagQueue`, `sns:TagResource`, `dynamodb:TagResource`, `elasticache:AddTagsToResource`, `ecs:TagResource`, `es:AddTags`, `kafka:TagResource`)는 `ForAllValues:StringEquals aws:TagKeys=[Monitoring]`, `aws:TagKeys` 존재, `aws:RequestTag/Monitoring=on`일 때만 | S3·Route 53 태그 쓰기 없음. **서비스 목록은 잠정**: 29종 검증 과제(`docs/specs/alarm-rules.md`) 결과로 확정 |
| `AlarmOps-Remediator` | 선택 | `ec2:StopInstances`, `rds:StopDBInstance`, `rds:StopDBCluster`, `elasticloadbalancing:DeleteLoadBalancer`, 모두 `aws:ResourceTag/Monitoring=on`일 때만 | 그 밖의 쓰기 없음. 실제 호출은 Slack 사람 승인 뒤에만 일어나도록 백엔드가 보장한다(D-15) |

### Remediator를 쓰려면

`EnableRemediator=true`와 함께 `RemediatorCallerRoleArn`(승인 실행 전용 중앙 역할)을 준다. 조치 대상은 `Monitoring=on` 태그가 붙은 자원뿐이므로, **TagWriter를 같이 켜면 콘솔이 붙인 태그가 조치 대상을 넓힌다**는 점을 고객에게 알린다. 켜기 전에 중요한 ELB에는 삭제 방지(`deletion_protection.enabled`)를 켜 둘 것을 권한다(삭제 방지가 켜진 ELB는 `DeleteLoadBalancer`가 실패한다). EC2는 `DisableApiStop`으로 막을 수 있다.

### 알려진 한계 (보안 검토 때 확인)

- **알람 이름 접두사**: 엔진의 알람 이름은 `[{resourceType}] ...`로 시작해 고정 접두사가 없다(`naming.alarm_name`). 그래서 `Resource`를 `alarm:AlarmOps-*`로 좁힐 수 없고 `alarm:*`이다. 소유 판정은 `ManagedBy` 태그가 한다.
- **생성 시 `cloudwatch:TagResource` 필요 여부(미확인)**: 태그를 실어 알람을 만들 때 CloudWatch가 `TagResource` 권한도 요구하면 생성이 거부된다. 그 경우 대안은 생성 문에 `TagResource`를 `aws:RequestTag/ManagedBy`로 허용하는 것인데, 그러면 태그 없는 고객 알람에 `ManagedBy`를 붙일 수 있게 된다. 개발 계정에서 실제 생성으로 확인하고, 필요하면 사용자에게 다시 묻는다.

- **ManagedBy 값은 `AlarmOps`** (엔진 `naming.MANAGED_BY`). 기존 도구의 `AlarmManager` 값은 이 역할로 지울 수 없다(옛 알람 이전은 별도 절차, D-08).
- **`DeleteAlarms`의 `aws:ResourceTag` 지원** 은 AWS 문서의 CloudWatch 작업·조건 키 표(`DeleteAlarms` 행의 alarm 리소스 유형)로 사람이 한 번 확인해야 한다. 지원하지 않으면 IAM은 삭제를 막지 못하고 엔진의 재확인(`offboard.py`·`sync.py`가 삭제 직전에 태그를 다시 읽음)이 유일한 방어가 된다. 이 환경에서는 문서를 조회하지 못해 **미확인**이다.
- **같은 이름의 고객 알람 덮어쓰기**: 생성 문은 `PutMetricAlarm`에 `ManagedBy=AlarmOps` 태그만 있으면 허용하므로 IAM만으로는 같은 이름의 기존 고객 알람(태그 없음) 덮어쓰기를 구분하지 못한다("기존 알람에 태그가 없음"을 조건으로 쓸 수 없다). 엔진이 생성 전에 `DescribeAlarms`로 이름 충돌을 확인한다.
- `UntagResource`는 `AlarmOps:Console:*` 같은 콘솔 태그를 지우기 위해 소유 알람에 허용된다(엔진 `engine.py`). `ManagedBy` 키는 Deny로 보호한다.
- `tag:TagResources` 자체의 `aws:TagKeys` 지원과 서비스별 태그 API의 조건 키 지원은 검증 과제에서 유형별로 확인한다. 지원하지 않는 유형은 이 역할에서 뺀다.

### EventForwarder와 ExternalId

EventBridge 규칙은 `events.amazonaws.com`이 역할을 맡아 중앙 버스로 보낸다. 서비스 주체는 ExternalId를 보내지 않으므로 `sts:ExternalId` 조건을 걸 수 없다. 대신 혼동된 대리인 방어(`aws:SourceAccount`, `aws:SourceArn`)로 이 계정의 `AlarmOps-*` 규칙만 이 역할을 쓸 수 있게 했고, 중앙 계정은 이 역할을 맡지 않는다(엔진 `check_connection`도 맡지 않는다). "모든 역할에 ExternalId"를 문자 그대로 요구하는 D-07과의 차이이므로 사용자 확인이 필요하다.

### 전달하는 이벤트

- `AlarmOps-AlarmStateChange`: `aws.cloudwatch` / `CloudWatch Alarm State Change`
- `AlarmOps-TagChange`: CloudTrail 관리 이벤트 중 태그 추가·삭제 API(`CreateTags`, `DeleteTags`, `AddTagsToResource`, `RemoveTagsFromResource`, `AddTags`, `RemoveTags`, `TagResource`, `UntagResource`, `TagResources`, `UntagResources`, `TagQueue`, `UntagQueue`). 전역 서비스(IAM, CloudFront, Route 53)의 이벤트는 us-east-1에서 나오므로 서울 스택으로는 오지 않는다.

## 오프라인 검증

```bash
pip install "cfn-lint==1.60.1"
cfn-lint infra/customer-stack/template.yaml infra/aws/central-bus.yaml infra/aws/alarm-commands-queue.yaml
python -m unittest discover -s infra/test -v
```

`sam validate`는 SAM 변환이 없는 순수 CloudFormation이라 해당이 없고(이 템플릿에 `Transform`이 없다), 이 환경에는 SAM CLI도 없다. 중앙 계정의 SAM 템플릿이 생기면 그쪽에 `sam validate --lint`를 단다.

## 엔진이 맞춰야 할 것 (AlarmWriter)

1. **생성**: `put_metric_alarm(..., Tags=[{ManagedBy: AlarmOps}, {Severity: ...}, ...extra])` 한 번. 생성 뒤 `tag_resource`로 `ManagedBy`를 붙이지 않는다.
2. **갱신**: 기존 소유 알람에는 `Tags` 없이 `put_metric_alarm`. `tag_resource`·`untag_resource`의 키에 `ManagedBy`를 넣지 않는다(Severity, `AlarmOps:Console:*`만).
3. 생성과 갱신을 가르려면 호출 전에 `describe_alarms`로 존재를 확인한다(같은 이름의 고객 알람이면 중단).
