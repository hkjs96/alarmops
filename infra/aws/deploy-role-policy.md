# 배포 역할 정책 초안 (GO-LIVE 4-1의 4번)

`deploy-central`과 `bus-allowlist` 워크플로가 OIDC로 맡는 **배포 역할**의 정책 초안이다. 사람이 읽고 검토한 뒤 AWS 콘솔에 넣는다. 에이전트는 AWS 명령을 실행하지 않는다.

- 대상 계정: 중앙 AWS 계정. 리전: 서울(`ap-northeast-2`). Control Tower 조직 계정이든 일반 계정이든 같은 정책이 동작해야 한다(D-58). 이 문서는 Organizations·CT 기능(`aws:PrincipalOrgID` 등)을 전제하지 않는다.
- 자리표시자: `<ACCOUNT_ID>`는 중앙 계정 12자리 숫자, `<REGION>`은 `ap-northeast-2`, `<PARTITION>`은 `aws`(일반 상용 파티션)로 바꾼다. 이 문서에는 실제 값을 쓰지 않는다. 템플릿 쪽은 `${AWS::AccountId}`·`${AWS::Region}`·`${AWS::Partition}`을 쓴다.
- 근거: `infra/aws/README.md`의 "실행과 사람이 하는 일", `infra/aws/central.yaml`, `infra/aws/central-bus.yaml`, `.github/workflows/deploy-central.yml`, `.github/workflows/bus-allowlist.yml`.
- 이름은 아래처럼 정한다. 다른 이름을 쓰면 JSON의 해당 ARN도 같이 바꾼다.

| 대상 | 이름 | 비고 |
|---|---|---|
| 배포 역할 | `AlarmOpsDeployCentral` | `AlarmOpsCentral-*`·`alarmops-central-*`·`AlarmOps-*`에 걸리지 않게 일부러 다르게 지었다. 배포 역할이 자기 자신을 고칠 수 없어야 한다 |
| 버스 허용 목록 역할 | `AlarmOpsDeployBus` | `bus-allowlist` 전용. `AlarmOpsCentral-*`·`alarmops-central-*`·`AlarmOps-*`에 걸리지 않는다. 신뢰 `sub`는 `environment:central-bus`. 인라인 정책 `AlarmOpsDeployBus-Policy`(아래 3-1) |
| SAM 아티팩트 버킷 | `alarmops-central-artifacts-<ACCOUNT_ID>` (예) | 배포 코드 zip을 올리는 고정 버킷. GitHub `central` 환경 변수 `SAM_ARTIFACT_BUCKET` |
| 권한 경계 정책 | `AlarmOpsCentral-RoleBoundary` | 배포 역할이 만드는 모든 역할에 붙는다 |
| 권한 정책 | `AlarmOpsDeployCentral-Policy` | 배포 역할의 **인라인** 정책 |

## 먼저 알아 둘 것 (막히는 곳)

1. **템플릿과 워크플로 변경이 먼저 머지돼야 한다.**
   - 이 문서의 권한 정책은 `iam:CreateRole`에 경계 조건을 건다. 템플릿이 역할에 경계를 붙이지 않으면 첫 배포가 `CreateRole` 거부로 실패한다.
   - 별도 브랜치 `agent/central-boundary-template`가 `central.yaml`에 `PermissionsBoundary`(세 역할과 `Globals.Function`)를 넣고, `deploy-central`을 `--s3-bucket "$SAM_ARTIFACT_BUCKET"`으로, `bus-allowlist`를 `central-bus` 환경으로 바꾼다.
   - **머지 순서: 그 PR을 먼저 머지하고, 그 다음에 첫 `plan`을 돌린다.**
   - 스택이 이미 있는 채로 경계를 붙이면 CloudFormation이 `iam:PutRolePermissionsBoundary`를 부른다. 그래서 권한 정책에 그 경계 ARN 조건의 허용(`IamPutBoundaryOnlyOurs`)을 넣었다.
2. 권한 정책은 공백을 빼고 8,212자(실제 값을 넣은 기준, JSON을 압축해 센 값)라 **관리형 정책 한도(6,144자)를 넘는다.** 그래서 역할의 **인라인 정책**으로 넣는다(역할당 인라인 정책 합계 한도 10,240자). 신뢰 정책 변경용 임시 정책(`DateLessThan` 조건 포함, 시각 값을 채운 기준 약 300자)이 붙어 있는 동안에도 합계 약 8,500자라 한도 안이다.
3. SAM 아티팩트 버킷은 `--resolve-s3` 대신 사람이 만든 고정 버킷을 쓴다. 이렇게 하면 `aws-sam-cli-managed-default` 스택·버킷 생성 권한과 와일드카드 버킷 권한이 필요 없다. 아래 5번의 6단계에서 만든다.
4. 첫 배포가 실패해 스택이 `ROLLBACK_COMPLETE`가 되면 **사람이** 콘솔에서 스택을 지운다. 배포 역할에는 `DeleteStack`이 없다. 지운 뒤 `plan`을 다시 돌린다.
5. 중앙 계정은 `AlarmOps` 전용이라고 가정한다. PoC는 D-57에 따라 공유 테스트 계정일 수 있다. 그 경우 `ApiGatewayHttpApi`의 `/apis/*` 와일드카드가 같은 계정의 다른 HTTP API까지 열어 주는 위험이 있다(생성 전에는 API ID를 몰라 이름으로 줄일 수 없다). 다른 워크로드가 없는 계정에서만 쓴다.

## 0. 사람 사전 확인 체크리스트

시작 전에 중앙 계정 관리자 세션(SSO·MFA)에서 확인한다.

- [ ] IAM에서 정책·역할·인라인 정책을 만들 수 있다(IAM → 정책 → 정책 생성 화면이 열린다).
- [ ] 이 계정에 걸린 SCP나 회사의 권한 경계 요구가 없다. 있으면 `CreateRole`에 회사 경계를 붙이라는 규칙과 이 문서의 경계가 겹치므로 먼저 보안 담당과 정한다. (AWS Organizations → 정책 또는 보안 담당에게 확인)
- [ ] 이 계정에서 `token.actions.githubusercontent.com`을 신뢰하는 **다른 역할**의 `sub`가 넓지 않다.
  - IAM → 역할 목록에서 "신뢰할 수 있는 엔터티" 열에 `Identity Provider: token.actions.githubusercontent.com`이 보이는 역할을 모두 연다.
  - 각 역할의 신뢰 관계에서 `sub`가 `*`나 `repo:hkjs96/*`처럼 넓으면, 이 저장소의 다른 워크플로·포크가 그 역할을 맡을 수 있다. 좁히거나 보안 담당과 정한다.
- [ ] GitHub 저장소 관리자 권한이 있다(환경 `central`, `central-bus` 만들기).

## 1. 신뢰 정책

배포 역할(`AlarmOpsDeployCentral`)용이다. GO-LIVE 4-1의 4번과 같다. `sub`는 정확히 일치만 쓴다(와일드카드 금지).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:<PARTITION>:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:hkjs96/alarmops:environment:central"
        }
      }
    }
  ]
}
```

## 2. 권한 경계 정책 (`AlarmOpsCentral-RoleBoundary`)

배포 역할이 만드는 역할이 가질 수 있는 권한의 **상한**이다. 이 안에 없는 권한은 역할 정책에 적어도 효력이 없다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Sqs",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ],
      "Resource": "arn:<PARTITION>:sqs:<REGION>:<ACCOUNT_ID>:alarmops-*"
    },
    {
      "Sid": "SecretsManagerRead",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:<PARTITION>:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:alarmops/central/*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": [
        "arn:<PARTITION>:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*",
        "arn:<PARTITION>:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*:*"
      ]
    },
    {
      "Sid": "AssumeCustomerRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:<PARTITION>:iam::*:role/AlarmOps-*",
      "Condition": {
        "Null": {
          "sts:ExternalId": "false"
        }
      }
    },
    {
      "Sid": "AssumeRemediatorCaller",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-RemediatorCaller"
    },
    {
      "Sid": "NeverAssumeCustomerRemediatorExceptCaller",
      "Effect": "Deny",
      "Action": "sts:AssumeRole",
      "Resource": "arn:<PARTITION>:iam::*:role/AlarmOps-Remediator",
      "Condition": {
        "ArnNotEquals": {
          "aws:PrincipalArn": "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-RemediatorCaller"
        }
      }
    },
    {
      "Sid": "SesSendEmail",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:<PARTITION>:ses:<REGION>:<ACCOUNT_ID>:identity/*"
    }
  ]
}
```

- 경계의 `AssumeRemediatorCaller`는 상한일 뿐이다. 실제 허용은 `central.yaml`이 엔진 역할 인라인 정책에 `RemediationEnabled`일 때만 만든다.

### 템플릿과 대조한 결과

| 만드는 역할 | 실제로 쓰는 권한 | 경계 안에 있나 |
|---|---|---|
| `AlarmOpsCentral-Engine` (엔진 Lambda 실행 역할) | 명령 큐 Receive/Delete/GetQueueAttributes/ChangeMessageVisibility, 엔진 DB 비밀 `GetSecretValue`, 자기 로그 그룹 `CreateLogStream`/`PutLogEvents`, `sts:AssumeRole`(고객 `AlarmOps-*`, ExternalId 필수), 선택 `AlarmOpsCentral-RemediatorCaller` | 예 |
| `AlarmOpsCentral-RemediatorCaller` | 고객 `AlarmOps-Remediator` `sts:AssumeRole`(ExternalId 필수) | 예(`AlarmOps-*`) |
| `AlarmOpsCentral-VercelConsole` | 명령 큐 `SendMessage`, 선택 `ses:SendEmail`(신원 하나, 보낸 주소 조건) | 예 |
| SAM 함수 역할 3개 (`alarmops-central-…FunctionRole-…`) | 알림 큐 `SendMessage`, 수집 DB 비밀 `GetSecretValue`, 로그. 소비자는 SQS 이벤트 소스라 SAM이 붙이는 `AWSLambdaSQSQueueExecutionRole`(Receive/Delete/GetQueueAttributes)와 `AWSLambdaBasicExecutionRole`(로그) | 예 |

### GO-LIVE 목록과 다른 점 (틈)

- GO-LIVE는 경계에 sqs, secretsmanager, logs, events, lambda, `sts:AssumeRole`, `ses:SendEmail`을 넣으라고 한다. 템플릿을 보면 **만드는 역할 중 `events:*`나 `lambda:*`를 쓰는 것은 없다.** 규칙은 EventBridge 서비스가 큐·함수 리소스 정책으로 호출하고, 역할 권한이 아니다. 그래서 최소 권한으로 **events와 lambda를 뺐다.** 나중에 역할에 그 권한을 넣게 되면 경계에도 같이 넣는다.
- 경계의 `secretsmanager`는 읽기(`GetSecretValue`)만 둔다. 쓰기는 사람이 한다.
- 리소스는 기본 이름(`ResourcePrefix=alarmops`, 비밀 이름 `alarmops/central/*`)을 가정한다. 파라미터로 이름을 바꾸면 경계와 권한 정책을 같이 고친다.
- `AWSLambdaBasicExecutionRole`은 로그를 `*`에 허용하지만 경계가 `/aws/lambda/alarmops-*` 로그 그룹으로 줄인다.

## 3. 권한 정책 (`AlarmOpsDeployCentral-Policy`, 인라인)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CfnCentralStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:GetTemplateSummary"
      ],
      "Resource": [
        "arn:<PARTITION>:cloudformation:<REGION>:<ACCOUNT_ID>:stack/alarmops-central/*",
        "arn:<PARTITION>:cloudformation:<REGION>:<ACCOUNT_ID>:changeSet/samcli-deploy*/*"
      ]
    },
    {
      "Sid": "CfnSamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:<PARTITION>:cloudformation:<REGION>:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "CfnBusStackRead",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:<PARTITION>:cloudformation:<REGION>:<ACCOUNT_ID>:stack/alarmops-central-bus/*"
    },
    {
      "Sid": "SamValidateListPolicies",
      "Effect": "Allow",
      "Action": "iam:ListPolicies",
      "Resource": "*"
    },
    {
      "Sid": "SamBucketObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:<PARTITION>:s3:::<SAM_ARTIFACT_BUCKET>/*"
    },
    {
      "Sid": "SamBucketList",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:<PARTITION>:s3:::<SAM_ARTIFACT_BUCKET>"
    },
    {
      "Sid": "IamCreateRoleWithBoundary",
      "Effect": "Allow",
      "Action": "iam:CreateRole",
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "IamRolePoliciesWithBoundary",
      "Effect": "Allow",
      "Action": [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy"
      ],
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "IamPutBoundaryOnlyOurs",
      "Effect": "Allow",
      "Action": "iam:PutRolePermissionsBoundary",
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "IamChangeRoles",
      "Effect": "Allow",
      "Action": [
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:DeleteRole"
      ],
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ]
    },
    {
      "Sid": "IamAttachLambdaManagedPolicies",
      "Effect": "Allow",
      "Action": [
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy"
      ],
      "Resource": "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary",
          "iam:PolicyARN": [
            "arn:<PARTITION>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            "arn:<PARTITION>:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"
          ]
        }
      }
    },
    {
      "Sid": "IamReadRoles",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ]
    },
    {
      "Sid": "IamPassRoleToLambdaOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-Engine",
        "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/alarmops-central-*FunctionRole-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid": "LambdaFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:GetFunctionConcurrency",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:<PARTITION>:lambda:<REGION>:<ACCOUNT_ID>:function:alarmops-*"
    },
    {
      "Sid": "LambdaEventSourceMappingsCreateUpdate",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping"
      ],
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "lambda:FunctionArn": "arn:<PARTITION>:lambda:<REGION>:<ACCOUNT_ID>:function:alarmops-*"
        }
      }
    },
    {
      "Sid": "LambdaEventSourceMappingsDeleteGet",
      "Effect": "Allow",
      "Action": [
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LambdaEventSourceMappingsTags",
      "Effect": "Allow",
      "Action": [
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:<PARTITION>:lambda:<REGION>:<ACCOUNT_ID>:event-source-mapping:*"
    },
    {
      "Sid": "Sqs",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:SetQueueAttributes",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueueTags"
      ],
      "Resource": "arn:<PARTITION>:sqs:<REGION>:<ACCOUNT_ID>:alarmops-*"
    },
    {
      "Sid": "EventsRulesOnCentralBus",
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:DeleteRule",
        "events:DescribeRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:ListTargetsByRule",
        "events:TagResource",
        "events:UntagResource",
        "events:ListTagsForResource"
      ],
      "Resource": "arn:<PARTITION>:events:<REGION>:<ACCOUNT_ID>:rule/alarmops-central/alarmops-*"
    },
    {
      "Sid": "EventsCentralBusRead",
      "Effect": "Allow",
      "Action": "events:DescribeEventBus",
      "Resource": "arn:<PARTITION>:events:<REGION>:<ACCOUNT_ID>:event-bus/alarmops-central"
    },
    {
      "Sid": "LogGroups",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup"
      ],
      "Resource": [
        "arn:<PARTITION>:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*",
        "arn:<PARTITION>:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*:*"
      ]
    },
    {
      "Sid": "LogsDescribe",
      "Effect": "Allow",
      "Action": "logs:DescribeLogGroups",
      "Resource": "*"
    },
    {
      "Sid": "SecretsManagerSecretsNoValues",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
        "secretsmanager:GetResourcePolicy"
      ],
      "Resource": "arn:<PARTITION>:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:alarmops/central/*"
    },
    {
      "Sid": "CloudWatchAlarms",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
        "cloudwatch:ListTagsForResource"
      ],
      "Resource": "arn:<PARTITION>:cloudwatch:<REGION>:<ACCOUNT_ID>:alarm:alarmops-*"
    },
    {
      "Sid": "CloudWatchDescribe",
      "Effect": "Allow",
      "Action": "cloudwatch:DescribeAlarms",
      "Resource": "*"
    },
    {
      "Sid": "ApiGatewayHttpApi",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE"
      ],
      "Resource": [
        "arn:<PARTITION>:apigateway:<REGION>::/apis",
        "arn:<PARTITION>:apigateway:<REGION>::/apis/*",
        "arn:<PARTITION>:apigateway:<REGION>::/tags/*"
      ]
    },
    {
      "Sid": "DenyBoundaryRemoval",
      "Effect": "Deny",
      "Action": "iam:DeleteRolePermissionsBoundary",
      "Resource": "*"
    },
    {
      "Sid": "DenyOtherBoundary",
      "Effect": "Deny",
      "Action": "iam:PutRolePermissionsBoundary",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "iam:PermissionsBoundary": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "DenyBoundaryPolicyChange",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": "arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
    },
    {
      "Sid": "DenyForceDeleteSecret",
      "Effect": "Deny",
      "Action": "secretsmanager:DeleteSecret",
      "Resource": "*",
      "Condition": {
        "Bool": {
          "secretsmanager:ForceDeleteWithoutRecovery": "true"
        }
      }
    },
    {
      "Sid": "DenySecretValues",
      "Effect": "Deny",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyPivotAndQueueData",
      "Effect": "Deny",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession",
        "sts:SetSourceIdentity",
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:PurgeQueue",
        "sqs:StartMessageMoveTask"
      ],
      "Resource": "*"
    }
  ]
}
```

### 문장별 요약

| Sid | 허용·거부 | 범위 |
|---|---|---|
| `CfnCentralStack` | 스택 조회·변경 세트 만들기/실행/삭제·`GetTemplate` | 스택 `alarmops-central`, 변경 세트 `samcli-deploy*` |
| `CfnSamTransform` | `CreateChangeSet` | 변환 `Serverless-2016-10-31` |
| `CfnBusStackRead` | `DescribeStacks` | 스택 `alarmops-central-bus`(수정은 `AlarmOpsDeployBus`) |
| `SamValidateListPolicies` | `iam:ListPolicies` | `*`(조회만. `sam validate`가 관리형 정책 목록을 읽는다. 필요 없다고 확인되면 뺀다) |
| `SamBucketObjects` / `SamBucketList` | 객체 쓰기·읽기, 버킷 목록 | 고정 버킷 `<SAM_ARTIFACT_BUCKET>`(JSON의 값을 만든 버킷 이름으로 바꾼다) |
| `IamCreateRoleWithBoundary` | `iam:CreateRole` | `AlarmOpsCentral-*`, `alarmops-central-*`. 경계 정책을 붙일 때만 |
| `IamRolePoliciesWithBoundary` | `PutRolePolicy`/`DeleteRolePolicy` | 같은 역할. 경계가 붙은 역할만 |
| `IamChangeRoles` | 설명·태그·삭제 | 같은 역할(이 동작들은 경계 조건 키를 지원하지 않는다). **신뢰 정책 변경(`UpdateAssumeRolePolicy`)은 상시 권한에 없다**(아래 4번) |
| `IamAttachLambdaManagedPolicies` | `AttachRolePolicy`/`DetachRolePolicy` | `alarmops-central-*`, 경계가 붙은 역할, 정책은 `AWSLambdaBasicExecutionRole`·`AWSLambdaSQSQueueExecutionRole` 둘뿐 |
| `IamReadRoles` | 역할 조회 | 같은 역할 |
| `IamPutBoundaryOnlyOurs` | `PutRolePermissionsBoundary` | 같은 역할, 경계가 `AlarmOpsCentral-RoleBoundary`일 때만(기존 스택에 경계를 붙일 때) |
| `IamPassRoleToLambdaOnly` | `iam:PassRole` | `AlarmOpsCentral-Engine`, `alarmops-central-*FunctionRole-*`, `iam:PassedToService=lambda.amazonaws.com`일 때만 |
| `LambdaFunctions` | 함수 생성·코드/설정 변경·예약 동시성·권한·태그 | `alarmops-*` 함수 |
| `LambdaEventSourceMappingsCreateUpdate` | 매핑 생성·수정 | `lambda:FunctionArn`이 `alarmops-*` 함수일 때만 |
| `LambdaEventSourceMappingsDeleteGet` | 매핑 삭제·조회 | `*`(매핑 ARN이 UUID라 이름으로 줄일 수 없다) |
| `LambdaEventSourceMappingsTags` | 매핑 태그·`ListTags` | 이벤트 소스 매핑 ARN |
| `Sqs` | 큐 생성·삭제·속성(정책 포함)·태그 | `alarmops-*` 큐 |
| `EventsRulesOnCentralBus` | 규칙·대상·태그 | 버스 `alarmops-central`의 `alarmops-*` 규칙 |
| `EventsCentralBusRead` | `DescribeEventBus` | 버스 `alarmops-central` |
| `LogGroups` / `LogsDescribe` | 로그 그룹 생성·보존 기간·태그 / 목록 조회 | `/aws/lambda/alarmops-*` / `*` |
| `SecretsManagerSecretsNoValues` | 비밀 **껍데기** 생성·삭제·조회·태그 | `alarmops/central/*`. 읽기·PutSecretValue 거부, UpdateSecret 미허용 |
| `CloudWatchAlarms` / `CloudWatchDescribe` | 알람 생성·삭제·태그 / 조회 | `alarmops-*` 알람 / `*` |
| `ApiGatewayHttpApi` | HTTP API(v2) 생성·변경 | `/apis`, `/apis/*`, `/tags/*`(생성 전에는 ID를 몰라 이름으로 줄일 수 없다) |
| `DenyBoundaryRemoval` | Deny `DeleteRolePermissionsBoundary` | `*` |
| `DenyOtherBoundary` | Deny `PutRolePermissionsBoundary` | 경계가 `AlarmOpsCentral-RoleBoundary`가 아닐 때 |
| `DenyBoundaryPolicyChange` | Deny 경계 정책 수정·삭제 | 경계 정책 |
| `DenyPivotAndQueueData` | Deny 역할 맡기·세션 태그·SQS 메시지 동작 | `*`(위 3-2) |
| `DenyForceDeleteSecret` | Deny `DeleteSecret` | `ForceDeleteWithoutRecovery=true`일 때 |
| `DenySecretValues` | Deny `GetSecretValue`/`PutSecretValue` | `*`(배포 역할은 비밀 값을 읽거나 쓰지 못한다) |

남는 위험(매핑): 삭제·조회가 `*`라 같은 계정의 다른 Lambda 이벤트 소스 매핑을 지울 수 있다. 계정에 다른 워크로드가 없다는 전제(위 5번)에서만 받아들인다.

넣지 않은 것: 역할 신뢰 정책 변경(상시), 고객 계정 권한, `sts:AssumeRole`, IAM 사용자·그룹·정책 생성, `AlarmOpsCentral-*`·`alarmops-central-*` 밖의 역할 변경, 배포 역할 자신의 변경, S3 버킷 삭제, SQS 메시지 읽기·쓰기.

### 3-1. 버스 허용 목록 역할 (`AlarmOpsDeployBus`)

`bus-allowlist`만 쓰는 별도 역할이다. 신뢰 정책은 `sub`만 다르다(`environment:central-bus`). 이렇게 하면 `central` 환경(배포)으로는 이 역할을 맡지 못하고, `central-bus` 환경(승인자 한 명)으로는 배포 역할을 맡지 못한다.

신뢰 정책:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:<PARTITION>:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:hkjs96/alarmops:environment:central-bus"
        }
      }
    }
  ]
}
```

인라인 정책 `AlarmOpsDeployBus-Policy`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CfnBusStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:UpdateStack",
        "cloudformation:DescribeStackEvents"
      ],
      "Resource": "arn:<PARTITION>:cloudformation:<REGION>:<ACCOUNT_ID>:stack/alarmops-central-bus/*"
    },
    {
      "Sid": "EventsCentralBus",
      "Effect": "Allow",
      "Action": [
        "events:DescribeEventBus",
        "events:PutPermission",
        "events:RemovePermission"
      ],
      "Resource": "arn:<PARTITION>:events:<REGION>:<ACCOUNT_ID>:event-bus/alarmops-central"
    }
  ]
}
```

- 버스 스택은 이벤트 버스와 버스 정책 두 개뿐이다(`central-bus.yaml`). 파라미터만 바꾸므로 `PutPermission`/`RemovePermission`/`DescribeEventBus`면 된다. 버스 만들기·삭제 권한은 없다.
- `UpdateStack --use-previous-template`이 `cloudformation:GetTemplate`을 더 요구할 수 있다. 첫 실행에서 거부되면 그 동작만 이 스택에 더한다(확인 못 함).
- 중앙 배포 역할에는 버스 스택 `DescribeStacks`와 `events:DescribeEventBus`만 남겼다. 버스 허용 목록은 배포 역할로 바꿀 수 없다.

### 3-2. 막은 우회 경로 (Deny 설명)

- `DenyPivotAndQueueData`: `sts:AssumeRole`·`TagSession`·`SetSourceIdentity`와 SQS 메시지 동작(`SendMessage`, `ReceiveMessage`, `DeleteMessage`, `PurgeQueue`, `StartMessageMoveTask`)을 `*`에 거부한다. `CreateRole`(그리고 임시로 받는 `UpdateAssumeRolePolicy`)이 있으면 배포 역할이 **자기를 신뢰하는 역할**을 만들거나 기존 역할의 신뢰를 바꾼 뒤 그 역할을 맡아 비밀을 읽거나 고객 역할에 닿을 수 있다. 명시적 Deny는 신뢰 정책 기반 허용보다 이긴다. 그래서 배포 역할 세션으로는 어떤 역할도 맡지 못한다. 배포 역할이 만든 역할은 CloudFormation이 아니라 서비스(Lambda, Vercel)가 맡는다.
  - **남는 경로(위험 수용).** 배포 역할이 만든 역할을 **외부**에서 맡는 경로는 막지 못한다. 외부 OIDC 공급자(`AssumeRoleWithWebIdentity`)나 외부 계정이 그 역할의 신뢰 정책에 들어 있으면, 배포 역할 세션 밖에서 맡을 수 있다. IAM은 `CreateRole`·`UpdateAssumeRolePolicy`가 쓰는 신뢰 정책의 **내용을 조건으로 제한하지 못하기** 때문이다(권한 경계는 만든 역할의 권한 상한만 건다).
  - 이 위험은 D-57에서 수용했다(사용자 결정).
  - 보완책 세 가지: (1) CloudTrail 알림(4-2절), (2) plan 승인 전 신뢰 정책·큐 정책 본문 확인(4-1절), (3) 임시 `TrustChange` 정책의 자동 만료(4절 3번의 `aws:CurrentTime` 조건).
- `DenyForceDeleteSecret`: 비밀을 복구 기간 없이 지우는 삭제(`ForceDeleteWithoutRecovery=true`)를 거부한다. `UpdateSecret`은 허용하지 않는다. 템플릿의 비밀에는 이름·설명뿐이라 필요 없고, 바꿀 일은 사람이 한다.
- `DenySecretValues`: 비밀 값 읽기·쓰기 거부.
- 경계 쪽 `NeverAssumeCustomerRemediatorExceptCaller`: 만든 역할 중 `AlarmOpsCentral-RemediatorCaller` 말고는 고객 `AlarmOps-Remediator`를 맡지 못한다.
- `PassRole`은 `AlarmOpsCentral-Engine`(`central.yaml`의 `CentralRole` 이름)과 `alarmops-central-*FunctionRole-*`(SAM 함수 역할)로 좁혔다. 나머지 두 역할은 Lambda에 넘기지 않는다.

## 4. 신뢰 정책 변경이 필요할 때

`apply`가 기존 역할의 신뢰 정책(`AssumeRolePolicyDocument`)을 바꾸는 경우가 있다. 상시 권한에는 `iam:UpdateAssumeRolePolicy`가 없으므로 그때만 사람이 임시로 준다.

1. `plan`의 작업 요약 맨 위 "IAM changes" 표(`.github/workflows/deploy-central.yml`의 256-262행이 만든다)에서 `AWS::IAM::Role` 행이 `Modify`인지 본다.
2. CloudFormation 콘솔 → 스택 `alarmops-central` → 변경 세트 → 그 역할의 **세부 정보**에서 `AssumeRolePolicyDocument`가 바뀌는지 확인한다. 바뀌고 내용이 의도한 것일 때만 계속한다.
3. 붙이기 전에 **바뀐 신뢰 JSON이 `central.yaml`과 같은지** 확인한다.
   - 변경 세트 세부 정보의 `AssumeRolePolicyDocument`를 파일로 복사하고, `central.yaml`의 해당 역할 `AssumeRolePolicyDocument`를 `${AWS::AccountId}` 등 값을 풀어 쓴 JSON과 `diff`로 비교한다.
   - 차이가 있으면(특히 `Principal`, `Federated`, 외부 계정, `sub`) 중단하고 보안 담당과 정한다.
4. 배포 역할에 **그 역할 하나만** 대상으로 하는 임시 인라인 정책 `AlarmOpsDeployCentral-TrustChange`를 붙인다. **붙인 시각 + 1시간**이 지나면 효력이 없어지도록 `aws:CurrentTime` 조건을 넣는다. `<붙인 시각 + 1시간(UTC, ISO 8601)>`은 사람이 값을 채운다(예: 형식 `YYYY-MM-DDThh:mm:ssZ`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustChangeOneRole",
      "Effect": "Allow",
      "Action": "iam:UpdateAssumeRolePolicy",
      "Resource": "arn:<PARTITION>:iam::<ACCOUNT_ID>:role/<바뀌는 역할 이름>",
      "Condition": {
        "DateLessThan": {
          "aws:CurrentTime": "<붙인 시각 + 1시간(UTC, ISO 8601)>"
        }
      }
    }
  ]
}
```

5. `apply`를 승인하고 끝나기를 기다린다. 실패하면 롤백이 같은 동작을 부를 수 있으니 스택이 `UPDATE_COMPLETE`나 `UPDATE_ROLLBACK_COMPLETE`가 될 때까지(롤백 가능성이 끝날 때까지) 정책을 떼지 않는다. 1시간 안에 끝나지 않으면 정책이 만료되므로 새 시각으로 다시 붙인다.
6. 끝나면 임시 정책을 **삭제**한다(만료는 안전장치이고 삭제는 사람이 한다). 이 정책은 `DenyPivotAndQueueData`에 걸리지 않는다(역할을 맡는 동작이 아니다).
7. 붙인 뒤(`apply` 끝난 뒤) 바뀐 역할의 **신뢰 정책에 외부 계정(`<ACCOUNT_ID>` 외 계정)이나 외부 OIDC `sub`(`token.actions.githubusercontent.com` 등 `Federated` 주체)가 없는지** IAM 콘솔 → 역할 → 신뢰 관계에서 읽어 확인한다. 있으면 즉시 신뢰 정책을 되돌리고 보안 담당에게 알린다.

## 4-1. plan 승인 전 확인

- [ ] `plan` 요약(IAM changes 표 등)에 아래 중 하나라도 있으면 CloudFormation 콘솔 → 스택 `alarmops-central` → 변경 세트 → 해당 리소스 **세부 정보**를 열어 본문을 읽고 의도한 내용일 때만 승인한다.
  - `AWS::IAM::Role`(및 그 밖의 IAM 변경): `AssumeRolePolicyDocument`의 `Principal`(외부 계정, `Federated`)과 `Condition`을 읽는다.
  - `AWS::SQS::QueuePolicy`: 큐 정책 본문의 `Principal`을 읽는다(외부 계정이 `SendMessage`/`ReceiveMessage`를 받으면 안 된다).
  - `AWS::Lambda::Permission`: `Principal`과 `SourceArn`을 읽는다.
  - `AWS::Events::Rule`: 대상과 이벤트 패턴을 읽는다.
- [ ] 변경이 없으면 "IAM 변경 없음"으로 표시된 줄만 확인한다.

## 4-2. 실고객 연결 전 필수

배포 역할의 IAM·큐·함수 변경을 알리는 **CloudTrail 알림 규칙 1개**를 둔다. 구현은 **파일럿 전 이슈**로 남긴다(이 문서는 초안만 둔다). 실고객을 연결하기 전에 끝나야 한다.

- 대상 이벤트(배포 역할 `AlarmOpsDeployCentral` 세션이 부른 것): `CreateRole`, `UpdateAssumeRolePolicy`, `PutRolePolicy`, `AttachRolePolicy`, `SetQueueAttributes`, `UpdateFunctionCode`, `AddPermission`
- 규칙 초안(EventBridge 규칙 패턴, 서울 리전 기본 버스. IAM 이벤트는 글로벌이라 us-east-1 버스에도 같은 규칙이 필요할 수 있다. 확인 못 함):

```json
{
  "source": ["aws.iam", "aws.sqs", "aws.lambda"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventName": [
      "CreateRole",
      "UpdateAssumeRolePolicy",
      "PutRolePolicy",
      "AttachRolePolicy",
      "SetQueueAttributes",
      "UpdateFunctionCode",
      "AddPermission"
    ],
    "userIdentity": {
      "sessionContext": {
        "sessionIssuer": {
          "userName": ["AlarmOpsDeployCentral"]
        }
      }
    }
  }
}
```

- 대상: SNS 토픽(구독은 보안 담당 이메일). 이메일 직접 대상은 EventBridge가 지원하지 않으므로 SNS를 거친다.
- 정상 배포 때도 울린다. 알림이 `plan` 승인 때 읽은 변경과 맞는지 대조하고, 맞지 않으면 신뢰 정책을 확인한다.
- 알림 규칙과 SNS는 배포 역할이 만들지 않는다. 사람이 만든다(배포 역할이 자기 알림을 끌 수 없게).

## 5. 콘솔 클릭 순서 (사람, 중앙 계정, 서울)

권한 경계 정책 → 역할(+권한 정책) 순서다. 경계가 먼저 있어야 권한 정책의 조건 ARN이 맞는다.

1. **권한 경계 정책 만들기**
   1. IAM → 정책 → 정책 생성
   2. 정책 편집기에서 **JSON** 탭을 고르고 위 2번 JSON을 붙여 넣는다. `<ACCOUNT_ID>`를 바꾼다.
   3. 다음 → 정책 이름 `AlarmOpsCentral-RoleBoundary` (정확히 이 이름) → 정책 생성
   4. 만든 정책을 열어 ARN을 확인한다. `arn:<PARTITION>:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary`여야 한다.
2. **배포 역할 만들기**
   1. IAM → 역할 → 역할 생성
   2. 신뢰할 수 있는 엔터티 유형: **웹 자격 증명**
   3. 자격 증명 공급자: `token.actions.githubusercontent.com`, Audience: `sts.amazonaws.com`
   4. 마법사의 GitHub 조직 칸은 필수다. `hkjs96`을 넣는다. 리포지토리·브랜치 칸은 비워도 된다(`alarmops`를 넣어도 된다). 아래 3번에서 신뢰 정책을 JSON으로 덮어쓰므로 `sub`는 거기서 정해진다.
   5. 권한 추가 화면은 정책을 고르지 않고 다음 → 역할 이름 `AlarmOpsDeployCentral` → 역할 생성
3. **신뢰 정책 덮어쓰기**
   1. 만든 역할 → 신뢰 관계 → 신뢰 정책 편집
   2. 위 1번 JSON을 붙여 넣고 `<ACCOUNT_ID>`를 바꾼다.
   3. 확인: `sub`가 `repo:hkjs96/alarmops:environment:central` 한 줄이고 `*`가 없다.
4. **권한 정책 넣기(인라인)**
   1. 역할 → 권한 탭 → 권한 추가 → 인라인 정책 생성
   2. **JSON** 탭에 위 3번 JSON을 붙여 넣고 `<ACCOUNT_ID>`를 바꾼다.
   3. 정책 이름 `AlarmOpsDeployCentral-Policy` → 정책 생성
   4. 확인: 정책의 `iam:PermissionsBoundary` 값이 1번에서 만든 경계 정책 ARN과 글자까지 같다. 이름이 다르면 조건이 맞지 않아 `CreateRole`이 거부된다.
5. **최대 세션 시간**: 역할 → 요약 → 편집 → 최대 세션 기간 1시간.
6. **SAM 아티팩트 버킷 만들기**
   1. S3 → 버킷 만들기. 리전은 **서울(ap-northeast-2)**.
   2. 버킷 이름 예: `alarmops-central-artifacts-<ACCOUNT_ID>`
   3. 퍼블릭 액세스 모두 차단: 켬(기본값)
   4. 버킷 버전 관리: 활성화
   5. 기본 암호화: SSE-S3(Amazon S3 관리형 키)
   6. 버킷 만들기 후, 3번 JSON의 `<SAM_ARTIFACT_BUCKET>` 두 곳을 이 버킷 이름으로 바꿔 4번의 인라인 정책을 갱신한다.
   7. GitHub → Settings → Environments → `central` → Variables에 `SAM_ARTIFACT_BUCKET` = 버킷 이름을 추가한다.
7. **버스 허용 목록 역할 만들기**: 2번과 같은 방식으로 역할 `AlarmOpsDeployBus`를 만든다(웹 자격 증명, 같은 공급자·Audience, 조직 `hkjs96`).
   1. 신뢰 관계를 3-1의 신뢰 정책 JSON으로 덮어쓴다(`sub`는 `repo:hkjs96/alarmops:environment:central-bus`).
   2. 권한 탭 → 권한 추가 → 인라인 정책 생성 → **JSON** → 3-1의 권한 JSON(`<ACCOUNT_ID>` 바꿈) → 이름 `AlarmOpsDeployBus-Policy`.
   3. 최대 세션 기간 1시간. 경계 정책은 붙이지 않는다(이 역할은 역할을 만들지 못한다).
8. **GitHub 환경 `central-bus` 만들기**
   1. 저장소 → Settings → Environments → New environment → 이름 `central-bus`
   2. Deployment branches and tags → Selected branches and tags → `main`만 추가
   3. Required reviewers: 본인 한 명을 넣는다.
   4. Prevent self-review는 **끈다**(승인자가 1인이라 켜면 아무도 승인하지 못한다).
   5. Variables에 `CENTRAL_BUS_DEPLOY_ROLE_ARN` = `AlarmOpsDeployBus`의 ARN을 추가한다.
9. **배포 역할 ARN 변수**: `central` 환경 변수 `CENTRAL_DEPLOY_ROLE_ARN` = `AlarmOpsDeployCentral`의 ARN(GO-LIVE 4-2).
   - 두 역할의 ARN은 서로 다르다. `central` 환경에는 `CENTRAL_BUS_DEPLOY_ROLE_ARN`을 두지 않는다.
10. **경계 이름이 맞는지 확인**: 템플릿 PR("먼저 알아 둘 것" 1번)이 머지된 뒤 `plan`이 `CreateRole`을 통과하는지 본다. 거부되면 `plan` 로그의 거부 메시지에서 `iam:PermissionsBoundary` 조건과 템플릿의 경계 ARN을 대조한다.

> **주의** 경계 정책은 배포 역할이 고칠 수 없다(`DenyBoundaryPolicyChange`). 고칠 때는 관리자가 새 버전을 만들고 `plan`에서 IAM 변경을 확인한다.

## 6. 롤백 복구 절차 (사람)

배포 역할에는 `DeleteStack`과 비밀 강제 삭제가 없다. 첫 배포가 실패했을 때 사람이 SSO 세션에서 정리한다. 아래 명령은 **예시이며 에이전트는 실행하지 않는다.**

1. **`ROLLBACK_COMPLETE` 스택**은 다시 올릴 수 없다. 사람이 콘솔(CloudFormation → 스택 `alarmops-central` → 삭제)에서 지운다.
2. 스택이 지워져도 비밀 두 개(`alarmops/central/engine-database-url`, `alarmops/central/ingest-database-url`)는 기본 복구 기간(7~30일) 동안 삭제 예정 상태로 남아 같은 이름으로 다시 만들 수 없다. 사람이 즉시 삭제한다. 복구 기능(`restore-secret`)은 쓰지 않는다.

```bash
# 사람이 SSO 세션에서만. 실행 전에 비밀 이름과 리전을 다시 확인한다.
aws secretsmanager delete-secret --region ap-northeast-2 \
  --secret-id alarmops/central/engine-database-url --force-delete-without-recovery
aws secretsmanager delete-secret --region ap-northeast-2 \
  --secret-id alarmops/central/ingest-database-url --force-delete-without-recovery
# 확인: 삭제 중이면 DeletedDate가 나오고, 이미 사라졌으면 ResourceNotFoundException이 난다.
aws secretsmanager describe-secret --region ap-northeast-2 \
  --secret-id alarmops/central/engine-database-url --query DeletedDate
aws secretsmanager describe-secret --region ap-northeast-2 \
  --secret-id alarmops/central/ingest-database-url --query DeletedDate
```

3. SQS는 큐를 지운 뒤 **60초** 동안 같은 이름으로 다시 만들 수 없다. 스택을 지운 뒤 1분 이상 기다렸다가 `plan`을 다시 돌린다.
4. 스택이 `UPDATE_ROLLBACK_FAILED`이면 사람이 콘솔에서 스택 → 스택 작업 → **업데이트 롤백 계속**(Continue update rollback)을 한다. 막힌 리소스를 건너뛰는 선택은 원인을 본 뒤에만 한다.
5. 복구 뒤 `plan`부터 다시 한다. 승인자는 IAM 변경 표를 다시 읽는다.

## 7. 왜 이 권한이 필요한가

| 문장(Sid) | 워크플로 | 단계 | 이유 |
|---|---|---|---|
| `CfnBusStackRead` | deploy-central | `plan` / `Check the central bus stack exists` | 버스 스택이 있는지 확인 |
| `SamValidateListPolicies` | deploy-central | `plan` / `sam validate` | SAM 변환이 관리형 정책 목록을 읽는다(추정) |
| `CfnCentralStack`(`ListChangeSets`) | deploy-central | `plan` / `Remember the change sets that exist before`, `Change set to the job summary` | 변경 세트 목록 비교 |
| `SamBucketObjects`, `SamBucketList`, `CfnSamTransform`, `CfnCentralStack`(`CreateChangeSet`, `DescribeStackEvents`) | deploy-central | `plan` / `Create the change set (not executed)` (`sam deploy --s3-bucket "$SAM_ARTIFACT_BUCKET" --no-execute-changeset`) | 고정 버킷에 코드 zip 올리기, 변환 포함 변경 세트 만들기 |
| `CfnCentralStack`(`DescribeChangeSet`, `DescribeStacks`) | deploy-central | `plan` / `Change set to the job summary` | IAM 변경 표 출력 |
| `CfnCentralStack`(`GetTemplate`), `SamBucketObjects`(`GetObject`) | deploy-central | `apply` / `Verify the change set carries exactly the code…` | 처리된 템플릿에서 코드 위치를 읽고 zip을 내려받아 해시 대조 |
| `CfnCentralStack`(`ExecuteChangeSet`) | deploy-central | `apply` / `Execute the approved change set` | 승인된 변경 세트 실행(실행하는 쪽이 아래 리소스 권한을 쓴다) |
| `IamCreateRoleWithBoundary`, `IamRolePoliciesWithBoundary`, `IamChangeRoles`(신뢰 정책 변경은 4번의 임시 권한), `IamAttachLambdaManagedPolicies`, `IamReadRoles` | deploy-central | `apply` / 실행 | `AlarmOpsCentral-Engine`·`-RemediatorCaller`·`-VercelConsole`과 SAM 함수 역할 생성·변경 |
| `IamPassRoleToLambdaOnly` | deploy-central | `apply` / 실행 | 함수 생성 시 실행 역할 전달(Lambda 서비스로만) |
| `LambdaFunctions`, `LambdaEventSourceMappings*` 3개 | deploy-central | `apply` / 실행 | 함수 4개, SQS 이벤트 소스 2개, 규칙 호출 권한 |
| `Sqs` | deploy-central | `apply` / 실행 | 큐 6개와 큐 정책 |
| `EventsRulesOnCentralBus`, `EventsCentralBusRead` | deploy-central | `apply` / 실행 | 규칙 2개와 대상·DLQ 설정 |
| `LogGroups`, `LogsDescribe` | deploy-central | `apply` / 실행 | 로그 그룹 4개 |
| `SecretsManagerSecretsNoValues` | deploy-central | `apply` / 실행 | DB 비밀 2개(값 없이) |
| `CloudWatchAlarms`, `CloudWatchDescribe` | deploy-central | `apply` / 실행 | DLQ 알람 4개 |
| `ApiGatewayHttpApi` | deploy-central | `apply` / 실행 | HTTP API와 `$default` 스테이지 |
| `CfnCentralStack`(`DescribeStacks`) | deploy-central | `apply` / `execute-change-set` 뒤 `wait`, `Stack outputs to the job summary` | 완료 대기와 출력 표 |
| `CfnBusStack`(`DescribeStacks`, 역할 `AlarmOpsDeployBus`) | bus-allowlist(환경 `central-bus`) | `Compute the new allow list` | 현재 `AllowedAccountIds`와 `BusName` 출력 읽기 |
| `CfnBusStack`(`UpdateStack`, `DescribeStackEvents`), `EventsCentralBus`(`PutPermission`/`RemovePermission`) (역할 `AlarmOpsDeployBus`) | bus-allowlist | `Update the bus stack` | 이전 템플릿으로 파라미터만 바꾸고 버스 정책 갱신 |
| `EventsCentralBus`(`DescribeEventBus`, 역할 `AlarmOpsDeployBus`) | bus-allowlist | `Verify the bus policy` | 정책에 계정이 있는지/없는지 확인 |
| `Deny*` 6개 | deploy-central | 모든 단계 | 경계 우회, 비밀 값 접근 차단 |

## 8. 검증하지 못한 것

- 이 문서의 JSON은 문법만 검사했다(`python json.loads`). IAM 정책 시뮬레이터나 실제 `plan`으로는 돌려 보지 못했다.
- 동작 목록은 템플릿과 워크플로에서 도출했다. CloudFormation이 리소스 생성 때 부르는 보조 동작(예: 태그·조회)은 실제 `plan`/`apply`의 `AccessDenied` 메시지로 마무리한다. 처음 두세 번은 거부가 나올 수 있다고 보고 사람이 지켜본다.
- 확신이 낮은 항목: `sam validate`의 `iam:ListPolicies`, 변경 세트 ARN 리소스 형태(`changeSet/samcli-deploy*/*`), SAM이 붙이는 관리형 정책이 위 둘뿐인지, `lambda:FunctionArn` 조건이 `CreateEventSourceMapping`에서 CloudFormation 호출에도 채워지는지(안 채워지면 거부되니 첫 `apply`에서 본다), 고정 버킷에서 SAM이 `s3:PutObject` 외에 더 요구하는 동작.
- 경계 조건 키(`iam:PermissionsBoundary`)는 `CreateRole`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePermissionsBoundary`에만 걸었다. 나머지 역할 변경 동작은 조건 키를 지원하지 않아 이름 범위로만 막는다.
