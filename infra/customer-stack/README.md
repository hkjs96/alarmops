# infra/customer-stack — 고객 연결 스택 (D-07)

`template.yaml` 하나가 고객 계정에 역할 5개와 EventBridge 규칙 2개를 만든다. 리전은 서울(ap-northeast-2). 고객이 직접 만든다(콘솔이 파라미터를 채운 링크/명령을 준다). 해지는 [OFFBOARDING.md](OFFBOARDING.md).

## 파라미터

| 이름 | 설명 |
|---|---|
| `CentralRoleArn` | 신뢰할 중앙 역할 하나의 ARN(`:role/`만 허용, 계정 root 불가) |
| `RemediatorCallerRoleArn` | `EnableRemediator=true`일 때 필수. 승인된 조치를 실행하는 **별도** 중앙 역할 ARN. Remediator는 `CentralRoleArn`을 신뢰하지 않는다 |
| `ExternalId` | 콘솔이 연결마다 발급, 16자 이상, 기본값 없음 |
| `CentralEventBusArn` | 중앙 버스 ARN(출력 `CentralBusArn`). 먼저 허용 목록에 계정이 추가돼 있어야 한다 |
| `PermissionsBoundaryArn` | 선택, 기본 빈값. 값이 있으면 역할 5개 모두에 권한 경계로 붙는다. 비면 붙이지 않는다(`AWS::NoValue`) |
| `EnableAlarmWriter`, `EnableTagWriter`, `EnableRemediator` | 기본 `false` |

## 기존 스택 갱신 (D-63 이전 템플릿으로 설치한 고객)

템플릿이 바뀌어도 고객 스택은 자동으로 바뀌지 않는다. D-63(AlarmWriter 생성 허용을 `[`로 시작하는 이름으로 좁힘)을 적용하려면 고객이 스택을 갱신한다. 바뀌는 것은 AlarmWriter 인라인 정책의 `Resource`와 역할 설명뿐이고 역할은 교체되지 않는다.

1. CloudFormation 콘솔(서울) → 스택 `alarmops-customer` → 업데이트.
2. `Replace existing template`(기존 템플릿을 새 파일로 바꾸는 선택지. 한국어 콘솔 표기는 다를 수 있다) → 새 `template.yaml` 올리기.
3. 파라미터는 이전 값을 그대로 둔다(특히 `ExternalId`).
4. `CAPABILITY_NAMED_IAM` 승인에 체크하고 제출한다. "No updates are to be performed"가 나오면 이미 최신이다.

고객 안내: 이름이 `[`로 시작하는 알람은 AlarmOps/MSP용으로 예약된다. 그런 이름의 알람은 AlarmOps가 설정을 덮어쓸 수 있다.

## 고객 조직이 권한 경계나 SCP를 요구할 때 (D-58)

실고객 조직은 SCP나 권한 경계가 없으면 `iam:CreateRole`을 막는 경우가 있다. 이때 스택 생성이 `CreateRole`에서 실패한다.

- **권한 경계**: 고객이 지정한 경계 정책 ARN을 `PermissionsBoundaryArn`에 준다. 경계는 권한을 더하지 못하고 줄이기만 하므로, 경계 정책이 켠 역할의 동작(위 표)을 허용해야 한다. 특히 `sts:AssumeRole` 신뢰는 경계와 무관하지만 Reader의 `cloudwatch:*`·`tag:*` 조회, AlarmWriter의 `cloudwatch:PutMetricAlarm`, EventForwarder의 `events:PutEvents`가 경계에 막히면 해당 기능이 AccessDenied가 된다.
- **경로**: 역할 경로는 지원하지 않는다(중앙·백엔드가 경로 없는 ARN을 가정). 필요하면 별도 이슈. 역할은 항상 기본 경로 `/`에 `AlarmOps-*` 이름으로 만들어진다.
- **CloudFormation 실행 주체**: 스택을 만드는 사람의 권한에도 `iam:CreateRole`, `iam:PutRolePolicy`(경계가 있으면 `iam:PermissionsBoundary` 조건)가 필요하다. 이는 고객 쪽 조직이 정한다.

> **역할 경로 미지원**: 백엔드(`packages/api/src/onboardingApi.ts`의 `roleArn()`)는 역할 ARN을 `arn:aws:iam::<계정>:role/AlarmOps-<역할>`로 조립하고 중앙 `infra/aws/central.yaml`도 `role/AlarmOps-*`만 가정한다. 그래서 `RolePath` 파라미터는 두지 않았다. 필요하면 db(`rolePath`), `packages/api`, 중앙 정책 확장을 묶은 별도 이슈로 다룬다.
> 파티션: 템플릿 패턴과 정책은 `aws`, `aws-cn`, `aws-us-gov`를 받는다. 백엔드 `roleArn()`은 `AWS_PARTITION`(기본 `aws`)을 따르지만 콘솔이 아직 넘기지 않아 실제로는 `aws`다(#97).

### Organizations·Control Tower 의존 점검

`template.yaml`을 점검한 결과(테스트 `CustomerStackBoundary.test_no_organizations_or_stackset_dependency`가 CI에서 확인):

- `aws:PrincipalOrgID`, `aws:PrincipalOrgPaths`, `organizations:*` 사용 없음. 신뢰는 `CentralRoleArn` 한 개와 ExternalId뿐이다.
- StackSets·Control Tower 자원 없음. 일반 스택(`CreateStack`) 하나로 CT 관리 계정, CT 멤버 계정, 일반 계정 어디서나 만든다.
- 하드코딩된 파티션 없음(정책 ARN은 `${AWS::Partition}`, 파라미터 패턴은 `arn:aws[a-z-]*:`).
- 남은 외부 의존: `CentralEventBusArn`은 서울 리전으로 고정(`ap-northeast-2`). 중앙 버스의 계정 허용 목록은 `infra/aws`의 별도 절차다. SCP가 리전이나 `events:PutEvents`를 막는 조직은 이 두 가지를 직접 확인해야 한다.
- 실제 SCP·경계 하에서의 `CreateStack` 성공은 이 환경에서 검증하지 못했다(미확인).

## 역할별 권한 목록

모든 역할: 최대 세션 1시간(엔진은 15분으로 요청), 신뢰는 `CentralRoleArn` + `sts:ExternalId`(EventForwarder 제외, 아래).

| 역할 | 필수 | 허용 | 명시적 Deny / 제한 |
|---|---|---|---|
| `AlarmOps-Reader` | 예 | CloudWatch 조회(`DescribeAlarms*`, `ListMetrics`, `ListTagsForResource`, `GetMetricData`, `GetMetricStatistics`, `GetMetricWidgetImage`), `tag:GetResources/GetTagKeys/GetTagValues`, 자원 종류별 Describe/List(수집기 추가분: `apigateway:GET`은 `/restapis`·`/apis` 두 경로만, `mq:ListBrokers`(DescribeBroker 없음), `sagemaker:DescribeEndpoint`(`endpoint/*`), `directconnect:DescribeConnections`). **Lambda는 `ListFunctions`·`GetFunction*`를 주지 않는다**(환경 변수에 비밀값이 있을 수 있음): 발견은 `tag:GetResources`(ARN·태그만)와 `cloudwatch:ListMetrics`로 한다. 이 목록은 (템플릿의 `ResourceInventoryAndTags`, 수집기 작성 때 29종에 맞춰 조정) | `secretsmanager:*`, `ssm:GetParameter(s)`·`GetParametersByPath`·`GetParameterHistory`, `s3:GetObject*`·`ListBucket*`, `kms:Decrypt`·`GenerateDataKey*`·`ReEncrypt*`, `apigateway:GET`의 `/apikeys*`·`/usageplans/*/keys*`·`/restapis/*/*` |
| `AlarmOps-EventForwarder` | 예 | `events:PutEvents` on `CentralEventBusArn` 하나 | 신뢰 주체는 `events.amazonaws.com`, `aws:SourceAccount`=이 계정, `aws:SourceArn`=이 계정의 `rule/AlarmOps-*` |
| `AlarmOps-AlarmWriter` | 선택 | `DescribeAlarms`; 알람 ARN에 `ListTagsForResource`; **생성**은 `PutMetricAlarm` 한 번에 `Tags`로 `ManagedBy=AlarmOps`를 실을 때만(`aws:RequestTag`), 그리고 알람 이름이 `[`로 시작할 때만(`Resource`=`alarm:[*`, D-63); 기존 알람의 `PutMetricAlarm`·`TagResource`·`UntagResource`·`DeleteAlarms`는 `aws:ResourceTag/ManagedBy=AlarmOps`일 때만 | `TagResource`·`UntagResource`는 `aws:TagKeys`에 `ManagedBy`가 있으면 항상 거부(생성 뒤 추가·변경·제거 불가). 이미 있는 알람에 `ManagedBy`를 붙이는 권한은 없다 |
| `AlarmOps-TagWriter` | 선택 | `tag:TagResources`와 서비스별 태그 API(`ec2:CreateTags`, `rds:AddTagsToResource`, `elasticloadbalancing:AddTags`, `lambda:TagResource`, `sqs:TagQueue`, `sns:TagResource`, `dynamodb:TagResource`, `elasticache:AddTagsToResource`, `ecs:TagResource`, `es:AddTags`, `kafka:TagResource`)는 `ForAllValues:StringEquals aws:TagKeys=[Monitoring]`, `aws:TagKeys` 존재, `aws:RequestTag/Monitoring=on`일 때만 | S3·Route 53 태그 쓰기 없음. **서비스 목록은 잠정**: 29종 검증 과제(`docs/specs/alarm-rules.md`) 결과로 확정 |
| `AlarmOps-Remediator` | 선택 | `ec2:StopInstances`, `rds:StopDBInstance`, `rds:StopDBCluster`, `elasticloadbalancing:DeleteLoadBalancer`, 모두 `aws:ResourceTag/Monitoring=on`일 때만 | 그 밖의 쓰기 없음. 실제 호출은 Slack 사람 승인 뒤에만 일어나도록 백엔드가 보장한다(D-15) |

### Remediator를 쓰려면

`EnableRemediator=true`와 함께 `RemediatorCallerRoleArn`(승인 실행 전용 중앙 역할)을 준다. 조치 대상은 `Monitoring=on` 태그가 붙은 자원뿐이므로, **TagWriter를 같이 켜면 콘솔이 붙인 태그가 조치 대상을 넓힌다**는 점을 고객에게 알린다. 켜기 전에 중요한 ELB에는 삭제 방지(`deletion_protection.enabled`)를 켜 둘 것을 권한다(삭제 방지가 켜진 ELB는 `DeleteLoadBalancer`가 실패한다). EC2는 `DisableApiStop`으로 막을 수 있다.

### 알려진 한계 (보안 검토 때 확인)

- **알람 이름 접두사(D-63)**: 엔진의 알람 이름은 항상 `[{resourceType}] ...`로 시작한다(`naming.alarm_name`). 그래서 생성 허용(`CreateAlarmWithManagedByTag`)의 `Resource`를 `alarm:[*`로 좁혔다(IAM `Resource`에서 `[`는 글자 그대로이고 와일드카드는 `*`·`?`뿐이다). 기존 알람의 수정·태그·삭제(`ChangeOwnAlarms`)는 `alarm:*`에 `ManagedBy` 태그 조건이다. **이름이 `[`로 시작하는 알람은 AlarmOps/MSP용으로 예약된다고 고객에게 안내한다.** 소유 판정은 `ManagedBy` 태그가 한다.
- **생성 시 `cloudwatch:TagResource` 필요 여부(미확인)**: 태그를 실어 알람을 만들 때 CloudWatch가 `TagResource` 권한도 요구하면 생성이 거부된다. 그 경우 대안은 생성 문에 `TagResource`를 `aws:RequestTag/ManagedBy`로 허용하는 것인데, 그러면 태그 없는 고객 알람에 `ManagedBy`를 붙일 수 있게 된다. 개발 계정에서 실제 생성으로 확인하고, 필요하면 사용자에게 다시 묻는다.

- **ManagedBy 값은 `AlarmOps`** (엔진 `naming.MANAGED_BY`). 기존 도구의 `AlarmManager` 값은 이 역할로 지울 수 없다(옛 알람 이전은 별도 절차, D-08).
- **`DeleteAlarms`의 `aws:ResourceTag` 지원** 은 AWS 문서의 CloudWatch 작업·조건 키 표(`DeleteAlarms` 행의 alarm 리소스 유형)로 사람이 한 번 확인해야 한다. 지원하지 않으면 IAM은 삭제를 막지 못하고 엔진의 재확인(`offboard.py`·`sync.py`가 삭제 직전에 태그를 다시 읽음)이 유일한 방어가 된다. 이 환경에서는 문서를 조회하지 못해 **미확인**이다.
- **같은 이름의 고객 알람 덮어쓰기(D-63)**: `PutMetricAlarm`은 기존 알람을 갱신할 때 요청 태그를 무시하므로, 요청 태그 조건(`aws:RequestTag`)만으로는 같은 이름의 태그 없는 고객 알람 덮어쓰기를 막지 못한다(11/26-27 실측: 임계값 1→2 변경). `aws:ResourceTag/ManagedBy`가 없을 때 막는 명시적 Deny는 새 알람 생성도 막아 쓸 수 없다(CloudWatch가 생성 때 리소스 태그를 빈 값으로 본다). 그래서 생성 허용을 `[`로 시작하는 이름으로 좁혔다. **남는 위험**: 이름이 `[`로 시작하는 태그 없는 알람(기존 alert-manager 알람은 같은 모양이다)은 여전히 덮어쓸 수 있고, 보호는 엔진이 쓰기 전에 하는 `DescribeAlarms`·`ManagedBy` 확인(`NotOwned`)뿐이다. `NotOwned`는 엔진 코드 안의 점검이라, 중앙 자격증명이 탈취되면 `[` 이름 알람의 설정(`AlarmActions`·`ActionsEnabled` 포함)이 바뀔 수 있다. 삭제와 태그 변경은 `ManagedBy` 태그 조건 때문에 여전히 막힌다. 기존 스택은 이 템플릿으로 갱신해야 적용된다(`docs/GO-LIVE.md` 4단계 "B 계정 스택 갱신").
- `UntagResource`는 `AlarmOps:Console:*` 같은 콘솔 태그를 지우기 위해 소유 알람에 허용된다(엔진 `engine.py`). `ManagedBy` 키는 Deny로 보호한다.
- `tag:TagResources` 자체의 `aws:TagKeys` 지원과 서비스별 태그 API의 조건 키 지원은 검증 과제에서 유형별로 확인한다. 지원하지 않는 유형은 이 역할에서 뺀다.

### EventForwarder와 ExternalId

EventBridge 규칙은 `events.amazonaws.com`이 역할을 맡아 중앙 버스로 보낸다. 서비스 주체는 ExternalId를 보내지 않으므로 `sts:ExternalId` 조건을 걸 수 없다. 대신 혼동된 대리인 방어(`aws:SourceAccount`, `aws:SourceArn`)로 이 계정의 `AlarmOps-*` 규칙만 이 역할을 쓸 수 있게 했고, 중앙 계정은 이 역할을 맡지 않는다(엔진 `check_connection`도 맡지 않는다). "모든 역할에 ExternalId"를 문자 그대로 요구하는 D-07과의 차이이므로 사용자 확인이 필요하다.

### 전달하는 이벤트

- `AlarmOps-AlarmStateChange`: `aws.cloudwatch` / `CloudWatch Alarm State Change`. 기본은 **고객 계정의 모든 알람**이고, `AlarmScope=managed-prefix`면 AlarmOps 이름 접두사 알람만(아래 "`AlarmScope`").
- `AlarmOps-TagChange`: CloudTrail 관리 이벤트 중 태그 추가·삭제 API(`CreateTags`, `DeleteTags`, `AddTagsToResource`, `RemoveTagsFromResource`, `AddTags`, `RemoveTags`, `TagResource`, `UntagResource`, `TagResources`, `UntagResources`, `TagQueue`, `UntagQueue`) 가운데, **요청에 태그 키 `Monitoring` 또는 `Threshold_*`가 들어 있는 것만** 보낸다. 전역 서비스(IAM, CloudFront, Route 53)의 이벤트는 us-east-1에서 나오므로 서울 스택으로는 오지 않는다.

### 태그 규칙을 좁힌 방식 (#89)

중앙이 쓰는 키는 `Monitoring`(D-16)과 `Threshold_*`(D-08)뿐이다(`alarm_engine.events`, `manual_change.route`). 그 밖의 키만 바뀐 이벤트는 중앙에서 `IGNORE`가 되므로, 고객 쪽에서 보내지 않아도 동작이 같다. Terraform `default_tags` 같은 일괄 태깅이 만드는 이벤트와 다른 태그 값(`Owner` 등)이 중앙으로 가지 않는다.

CloudTrail `requestParameters`의 태그 위치는 서비스마다 달라서, 엔진이 읽을 수 있는 모양(`events.extract`의 `tags`, `tagSet`, `TagList`, `tagList`, `tagKeys`, `TagKeys`)을 `$or`로 모두 적었다. 엔진이 읽지 못하는 모양은 중앙에서도 키를 얻지 못해 무시되므로 패턴에서도 뺐다.

| 요청 모양 | 대표 API | 매칭 |
|---|---|---|
| `tagSet.items[].key` | EC2 `CreateTags`·`DeleteTags` | `Monitoring` 또는 `Threshold_` 접두사 |
| `tags[].key` / `tags[].Key` | RDS·ElastiCache `AddTagsToResource`, ELB(v2·Classic) `AddTags`·`RemoveTags`, SNS·DynamoDB·ECS `TagResource` | 같음 |
| `tagList[].key`·`Key`, `TagList[].key`·`Key` | OpenSearch `AddTags` | 같음 |
| `tagKeys[]`, `TagKeys[]` | 각 서비스의 제거 API(`RemoveTagsFromResource`, `RemoveTags`, `UntagResource`, `UntagQueue`, `UntagResources`) | 같음 |
| `tags` 맵(`{"키": "값"}`) | Lambda·MSK `TagResource`, SQS `TagQueue`, `tag:TagResources` | **`Monitoring` 키만**(맵 키는 접두사 매칭이 안 된다) |

**넓게 남긴 곳과 한계** (확인 못 한 것은 추정으로 표시)
- 위 표의 서비스별 모양은 AWS 문서를 이 환경에서 조회하지 못해, 엔진 코드(`events.extract`)와 기억에 의존했다. 실제 CloudTrail 이벤트 샘플로 개발 계정에서 한 번 확인해야 한다(추정). 모양이 다르면 그 서비스의 태그 이벤트는 규칙에 걸리지 않지만, 엔진도 그 모양에서 키를 읽지 못했을 것이므로 기능 손실은 없고 시간당 TAG_RECONCILE이 메운다.
- 맵 모양 API(Lambda, SQS, MSK, `tag:TagResources`)에서 `Threshold_*`만 바뀐 이벤트는 오지 않는다. 즉시 반영 대신 시간당 `TAG_RECONCILE` 실행이 반영한다.
- `EC2 DeleteTags`에 태그 키 없이 모든 태그를 지우는 호출(`tagSet` 없음)은 오지 않는다. 시간당 실행이 `Monitoring` 제거를 확인한다.
- Lambda의 실제 CloudTrail 이벤트 이름은 버전 접미사가 붙은 `TagResource20170331v2` 계열일 수 있다(추정). 이 규칙도 엔진도 원래 `TagResource`만 받으므로 이번 변경 범위 밖이다. 확인이 필요하다.
- 값(`Monitoring=on` 여부)은 거르지 않는다. `off`로 바꾸거나 값만 바꾸는 이벤트도 NEEDS_REVIEW 판정에 필요하기 때문이다.

### 알람 상태 규칙의 범위: `AlarmScope`

EventBridge 이벤트의 `detail`에는 알람 태그가 없고 `alarmName`·`configuration.description`만 있다. 그래서 고객이 파라미터로 고른다.

| 값 | 전달 | 결과 |
|---|---|---|
| `all`(기본) | 이 계정의 모든 CloudWatch 알람 상태 변경 | 고객이 직접 만든 알람도 중앙이 적재한다(`managed=false`, "unmanaged alarm format") |
| `managed-prefix` | `detail.alarmName`이 `[{type}] `로 시작하는 알람만(29종: `naming.alarm_name`의 `[{resourceType}] ` 접두사, 이름이 길어도 접두사는 잘리지 않는다) | **고객이 직접 만든 알람은 인시던트가 되지 않는다.** 고객 데이터 전송이 최소가 된다 |

이름 접두사는 소유 증명이 아니다. 고객 알람이 `[EC2] ...`로 시작하면 그대로 전달되고, 소유 판정은 `ManagedBy` 태그가 한다. 29종에 없는 유형 이름을 엔진이 새로 쓰면 이 목록(`template.yaml`의 `AlarmStateRule`)도 같이 고쳐야 한다. 중앙·엔진 코드는 바꾸지 않았다.

## 오프라인 검증

```bash
pip install "cfn-lint==1.60.1"
cfn-lint infra/customer-stack/template.yaml infra/aws/central-bus.yaml infra/aws/central.yaml
python -m unittest discover -s infra/test -v
```

이 템플릿은 순수 CloudFormation이라 `sam validate`는 해당이 없다. 중앙 계정의 SAM 템플릿(`infra/aws/central.yaml`)은 `infra/aws/README.md`의 검증 절을 따른다.

## 엔진이 맞춰야 할 것 (AlarmWriter)

1. **생성**: `put_metric_alarm(..., Tags=[{ManagedBy: AlarmOps}, {Severity: ...}, ...extra])` 한 번. 생성 뒤 `tag_resource`로 `ManagedBy`를 붙이지 않는다.
2. **갱신**: 기존 소유 알람에는 `Tags` 없이 `put_metric_alarm`. `tag_resource`·`untag_resource`의 키에 `ManagedBy`를 넣지 않는다(Severity, `AlarmOps:Console:*`만).
3. 생성과 갱신을 가르려면 호출 전에 `describe_alarms`로 존재를 확인한다(같은 이름의 고객 알람이면 중단).

엔진 반영 상태(백엔드): `services/alarm-engine/src/alarm_engine/aws.py`의 `AlarmWriter.put()`이 위 1~3을 따른다. 같은 이름의 소유가 아닌 알람은 `NotOwned`로 중단하고 동기화 결과에 `nameCollisions`로 기록한다. `tag_resource`·`untag_resource`에 `ManagedBy`를 넣으면 `ForbiddenTagKey`가 난다. 생성 시 `TagResource` 필요 여부(위 미확인 항목)는 여전히 개발 계정 실측이 필요하다.
