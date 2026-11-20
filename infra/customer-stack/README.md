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
| `RolePath` | 기본 `/`. 역할 5개의 IAM 경로. `/`로 시작하고 끝나야 한다 |
| `EnableAlarmWriter`, `EnableTagWriter`, `EnableRemediator` | 기본 `false` |

## 고객 조직이 권한 경계나 SCP를 요구할 때 (D-58)

실고객 조직은 SCP나 권한 경계가 없으면 `iam:CreateRole`을 막는 경우가 있다. 이때 스택 생성이 `CreateRole`에서 실패한다.

- **권한 경계**: 고객이 지정한 경계 정책 ARN을 `PermissionsBoundaryArn`에 준다. 경계는 권한을 더하지 못하고 줄이기만 하므로, 경계 정책이 켠 역할의 동작(위 표)을 허용해야 한다. 특히 `sts:AssumeRole` 신뢰는 경계와 무관하지만 Reader의 `cloudwatch:*`·`tag:*` 조회, AlarmWriter의 `cloudwatch:PutMetricAlarm`, EventForwarder의 `events:PutEvents`가 경계에 막히면 해당 기능이 AccessDenied가 된다.
- **경로**: 고객이 특정 경로(`/org/security/` 등)의 역할만 허용하면 `RolePath`를 준다. 역할 이름은 항상 `AlarmOps-*`다.
- **CloudFormation 실행 주체**: 스택을 만드는 사람의 권한에도 `iam:CreateRole`, `iam:PutRolePolicy`(경계가 있으면 `iam:PermissionsBoundary` 조건)가 필요하다. 이는 고객 쪽 조직이 정한다.

> **RolePath 경고(미지원)**: 지금 백엔드(`packages/api/src/onboardingApi.ts`의 `roleArn()`)는 역할 ARN을 `arn:aws:iam::<계정>:role/AlarmOps-<역할>`로 계정 ID와 이름만으로 조립하고, 계정 행에 경로 필드가 없다. 엔진은 DB에 저장된 ARN을 그대로 AssumeRole 하므로 엔진 자체는 경로를 처리하지만, 저장되는 ARN이 경로 없이 만들어진다. 또 중앙 `infra/aws/central.yaml`의 `role/AlarmOps-*` 리소스는 `role/<경로>/AlarmOps-*`와 맞지 않는다. 따라서 **`RolePath`는 `/`(기본값)만 종단 간 동작한다.** 경로를 쓰려면 `CloudAccount`에 `rolePath` 필드(db), `roleArn()`과 파티션 처리(packages/api), 중앙 정책 리소스 확장(infra)이 함께 필요하다(별도 이슈). 경계 파라미터는 ARN 조립과 무관하므로 지금도 쓸 수 있다.
> 파티션도 같은 상태다: 템플릿 패턴과 정책은 `aws`, `aws-cn`, `aws-us-gov`를 받지만 백엔드 `roleArn()`은 `aws`로 고정이다.

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
cfn-lint infra/customer-stack/template.yaml infra/aws/central-bus.yaml infra/aws/central.yaml
python -m unittest discover -s infra/test -v
```

이 템플릿은 순수 CloudFormation이라 `sam validate`는 해당이 없다. 중앙 계정의 SAM 템플릿(`infra/aws/central.yaml`)은 `infra/aws/README.md`의 검증 절을 따른다.

## 엔진이 맞춰야 할 것 (AlarmWriter)

1. **생성**: `put_metric_alarm(..., Tags=[{ManagedBy: AlarmOps}, {Severity: ...}, ...extra])` 한 번. 생성 뒤 `tag_resource`로 `ManagedBy`를 붙이지 않는다.
2. **갱신**: 기존 소유 알람에는 `Tags` 없이 `put_metric_alarm`. `tag_resource`·`untag_resource`의 키에 `ManagedBy`를 넣지 않는다(Severity, `AlarmOps:Console:*`만).
3. 생성과 갱신을 가르려면 호출 전에 `describe_alarms`로 존재를 확인한다(같은 이름의 고객 알람이면 중단).

엔진 반영 상태(백엔드): `services/alarm-engine/src/alarm_engine/aws.py`의 `AlarmWriter.put()`이 위 1~3을 따른다. 같은 이름의 소유가 아닌 알람은 `NotOwned`로 중단하고 동기화 결과에 `nameCollisions`로 기록한다. `tag_resource`·`untag_resource`에 `ManagedBy`를 넣으면 `ForbiddenTagKey`가 난다. 생성 시 `TagResource` 필요 여부(위 미확인 항목)는 여전히 개발 계정 실측이 필요하다.
