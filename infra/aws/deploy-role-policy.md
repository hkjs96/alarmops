# 배포 역할 정책 초안 (GO-LIVE 4-1의 4번)

`deploy-central`과 `bus-allowlist` 워크플로가 OIDC로 맡는 **배포 역할**의 정책 초안이다. 사람이 읽고 검토한 뒤 AWS 콘솔에 넣는다. 에이전트는 AWS 명령을 실행하지 않는다.

- 대상 계정: 중앙 AWS 계정. 리전: 서울(`ap-northeast-2`).
- `<ACCOUNT_ID>`는 중앙 계정 12자리 숫자로 바꾼다. 이 문서에는 실제 값을 쓰지 않는다.
- 근거: `infra/aws/README.md`의 "실행과 사람이 하는 일", `infra/aws/central.yaml`, `infra/aws/central-bus.yaml`, `.github/workflows/deploy-central.yml`, `.github/workflows/bus-allowlist.yml`.
- 이름은 아래처럼 정한다. 다른 이름을 쓰면 JSON의 해당 ARN도 같이 바꾼다.

| 대상 | 이름 | 비고 |
|---|---|---|
| 배포 역할 | `AlarmOpsDeployCentral` | `AlarmOpsCentral-*`·`alarmops-central-*`·`AlarmOps-*`에 걸리지 않게 일부러 다르게 지었다. 배포 역할이 자기 자신을 고칠 수 없어야 한다 |
| 버스 허용 목록 역할 | `AlarmOpsDeployBus` | `bus-allowlist` 전용. `AlarmOpsCentral-*`·`alarmops-central-*`·`AlarmOps-*`에 걸리지 않는다. 인라인 정책 `AlarmOpsDeployBus-Policy`(아래 3-1) |
| 권한 경계 정책 | `AlarmOpsCentral-RoleBoundary` | 배포 역할이 만드는 모든 역할에 붙는다 |
| 권한 정책 | `AlarmOpsDeployCentral-Policy` | 배포 역할의 **인라인** 정책 |

## 먼저 알아 둘 것 (막히는 곳)

1. **현재 `central.yaml`은 역할에 권한 경계를 붙이지 않는다.** 이 문서의 권한 정책은 `iam:CreateRole`에 경계 조건을 거므로 지금 템플릿으로는 첫 배포가 `CreateRole` 거부로 실패한다. 템플릿에 `PermissionsBoundary: arn:aws:iam::<계정>:policy/AlarmOpsCentral-RoleBoundary`를 세 역할(`CentralRole`, `RemediatorCallerRole`, `VercelConsoleRole`)과 `Globals.Function`(SAM 함수 역할)에 넣어야 한다. 이는 infra 이슈로 따로 잡는다. **머지 순서: 템플릿의 경계 PR을 먼저 머지하고, 그 다음에 첫 `plan`을 돌린다.** 스택이 이미 있는 채로 경계를 붙이면 CloudFormation이 `iam:PutRolePermissionsBoundary`를 부른다. 그래서 권한 정책에 그 경계 ARN 조건의 허용(`IamPutBoundaryOnlyOurs`)을 넣었다.
2. 권한 정책은 공백을 빼고 약 8.1천 자라 **관리형 정책 한도(6,144자)를 넘는다.** 그래서 역할의 **인라인 정책**으로 넣는다(역할당 인라인 정책 합계 한도 10,240자. 권한 정책 8,104자 + 첫 실행용 724자 = 8,828자, 공백 제외).
3. `sam deploy --resolve-s3`는 처음에 SAM 관리 스택 `aws-sam-cli-managed-default`와 S3 버킷을 만든다. 배포 역할 상시 권한에는 이 생성을 넣지 않았다(읽기만). 처음 한 번은 아래 "첫 실행용 임시 정책"을 붙였다가 끝나면 뗀다. 이미 그 스택이 있으면 필요 없다.
4. 첫 배포가 실패해 스택이 `ROLLBACK_COMPLETE`가 되면 **사람이** 콘솔에서 스택을 지운다. 배포 역할에는 `DeleteStack`이 없다. 지운 뒤 `plan`을 다시 돌린다.
5. 중앙 계정은 `AlarmOps` 전용이라고 가정한다. PoC는 D-57에 따라 공유 테스트 계정일 수 있다. 그 경우 `ApiGatewayHttpApi`의 `/apis/*` 와일드카드가 같은 계정의 다른 HTTP API까지 열어 주는 위험이 있다(생성 전에는 API ID를 몰라 이름으로 줄일 수 없다). 다른 워크로드가 없는 계정에서만 쓴다.

## 1. 신뢰 정책

GO-LIVE 4-1의 4번과 같다. `sub`는 정확히 일치만 쓴다(와일드카드 금지).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
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
      "Resource": "arn:aws:sqs:ap-northeast-2:<ACCOUNT_ID>:alarmops-*"
    },
    {
      "Sid": "SecretsManagerRead",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:alarmops/central/*"
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
        "arn:aws:logs:ap-northeast-2:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*",
        "arn:aws:logs:ap-northeast-2:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*:*"
      ]
    },
    {
      "Sid": "AssumeCustomerRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/AlarmOps-*",
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
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-RemediatorCaller"
    },
    {
      "Sid": "NeverAssumeCustomerRemediatorExceptCaller",
      "Effect": "Deny",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/AlarmOps-Remediator",
      "Condition": {
        "ArnNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-RemediatorCaller"
        }
      }
    },
    {
      "Sid": "SesSendEmail",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:ap-northeast-2:<ACCOUNT_ID>:identity/*"
    }
  ]
}
```

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
        "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:stack/alarmops-central/*",
        "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:changeSet/samcli-deploy*/*"
      ]
    },
    {
      "Sid": "CfnSamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:ap-northeast-2:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "CfnSamManagedStackRead",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents"
      ],
      "Resource": "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:stack/aws-sam-cli-managed-default/*"
    },
    {
      "Sid": "CfnBusStackRead",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:stack/alarmops-central-bus/*"
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
      "Resource": "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-*/*"
    },
    {
      "Sid": "SamBucketList",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-*"
    },
    {
      "Sid": "IamCreateRoleWithBoundary",
      "Effect": "Allow",
      "Action": "iam:CreateRole",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
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
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "IamPutBoundaryOnlyOurs",
      "Effect": "Allow",
      "Action": "iam:PutRolePermissionsBoundary",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
        }
      }
    },
    {
      "Sid": "IamChangeRoles",
      "Effect": "Allow",
      "Action": [
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:DeleteRole"
      ],
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ]
    },
    {
      "Sid": "IamAttachLambdaManagedPolicies",
      "Effect": "Allow",
      "Action": [
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy"
      ],
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary",
          "iam:PolicyARN": [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"
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
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*"
      ]
    },
    {
      "Sid": "IamPassRoleToLambdaOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/AlarmOpsCentral-Engine",
        "arn:aws:iam::<ACCOUNT_ID>:role/alarmops-central-*FunctionRole-*"
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
      "Resource": "arn:aws:lambda:ap-northeast-2:<ACCOUNT_ID>:function:alarmops-*"
    },
    {
      "Sid": "LambdaEventSourceMappings",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping"
      ],
      "Resource": "*"
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
      "Resource": "arn:aws:sqs:ap-northeast-2:<ACCOUNT_ID>:alarmops-*"
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
      "Resource": "arn:aws:events:ap-northeast-2:<ACCOUNT_ID>:rule/alarmops-central/alarmops-*"
    },
    {
      "Sid": "EventsCentralBusRead",
      "Effect": "Allow",
      "Action": "events:DescribeEventBus",
      "Resource": "arn:aws:events:ap-northeast-2:<ACCOUNT_ID>:event-bus/alarmops-central"
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
        "arn:aws:logs:ap-northeast-2:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*",
        "arn:aws:logs:ap-northeast-2:<ACCOUNT_ID>:log-group:/aws/lambda/alarmops-*:*"
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
      "Resource": "arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:alarmops/central/*"
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
      "Resource": "arn:aws:cloudwatch:ap-northeast-2:<ACCOUNT_ID>:alarm:alarmops-*"
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
        "arn:aws:apigateway:ap-northeast-2::/apis",
        "arn:aws:apigateway:ap-northeast-2::/apis/*",
        "arn:aws:apigateway:ap-northeast-2::/tags/*"
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
          "iam:PermissionsBoundary": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
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
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary"
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
| `CfnSamManagedStackRead` | `DescribeStacks`/`DescribeStackEvents` | 스택 `aws-sam-cli-managed-default` |
| `CfnBusStackRead` | `DescribeStacks` | 스택 `alarmops-central-bus`(수정은 `AlarmOpsDeployBus`) |
| `SamValidateListPolicies` | `iam:ListPolicies` | `*`(조회만. `sam validate`가 관리형 정책 목록을 읽는다. 필요 없다고 확인되면 뺀다) |
| `SamBucketObjects` / `SamBucketList` | 객체 쓰기·읽기, 버킷 목록 | SAM 관리 버킷 `aws-sam-cli-managed-default-samclisourcebucket-*` |
| `IamCreateRoleWithBoundary` | `iam:CreateRole` | `AlarmOpsCentral-*`, `alarmops-central-*`. 경계 정책을 붙일 때만 |
| `IamRolePoliciesWithBoundary` | `PutRolePolicy`/`DeleteRolePolicy` | 같은 역할. 경계가 붙은 역할만 |
| `IamChangeRoles` | 신뢰 정책·설명·태그·삭제 | 같은 역할(이 동작들은 경계 조건 키를 지원하지 않는다) |
| `IamAttachLambdaManagedPolicies` | `AttachRolePolicy`/`DetachRolePolicy` | `alarmops-central-*`, 경계가 붙은 역할, 정책은 `AWSLambdaBasicExecutionRole`·`AWSLambdaSQSQueueExecutionRole` 둘뿐 |
| `IamReadRoles` | 역할 조회 | 같은 역할 |
| `IamPutBoundaryOnlyOurs` | `PutRolePermissionsBoundary` | 같은 역할, 경계가 `AlarmOpsCentral-RoleBoundary`일 때만(기존 스택에 경계를 붙일 때) |
| `IamPassRoleToLambdaOnly` | `iam:PassRole` | `AlarmOpsCentral-Engine`, `alarmops-central-*FunctionRole-*`, `iam:PassedToService=lambda.amazonaws.com`일 때만 |
| `LambdaFunctions` | 함수 생성·코드/설정 변경·예약 동시성·권한·태그 | `alarmops-*` 함수 |
| `LambdaEventSourceMappings` | 이벤트 소스 매핑 | `*`(매핑 ARN이 UUID라 이름으로 줄일 수 없다) |
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

넣지 않은 것: 고객 계정 권한, `sts:AssumeRole`, IAM 사용자·그룹·정책 생성, `AlarmOpsCentral-*`·`alarmops-central-*` 밖의 역할 변경, 배포 역할 자신의 변경, S3 버킷 삭제, SQS 메시지 읽기·쓰기.

### 3-1. 버스 허용 목록 역할 (`AlarmOpsDeployBus`)

`bus-allowlist`만 쓰는 별도 역할이다. 신뢰 정책은 위 1번과 같다(`sub`도 같다). 인라인 정책 `AlarmOpsDeployBus-Policy`:

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
      "Resource": "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:stack/alarmops-central-bus/*"
    },
    {
      "Sid": "EventsCentralBus",
      "Effect": "Allow",
      "Action": [
        "events:DescribeEventBus",
        "events:PutPermission",
        "events:RemovePermission"
      ],
      "Resource": "arn:aws:events:ap-northeast-2:<ACCOUNT_ID>:event-bus/alarmops-central"
    }
  ]
}
```

- 버스 스택은 이벤트 버스와 버스 정책 두 개뿐이다(`central-bus.yaml`). 파라미터만 바꾸므로 `PutPermission`/`RemovePermission`/`DescribeEventBus`면 된다. 버스 만들기·삭제 권한은 없다.
- `UpdateStack --use-previous-template`이 `cloudformation:GetTemplate`을 더 요구할 수 있다. 첫 실행에서 거부되면 그 동작만 이 스택에 더한다(확인 못 함).
- 중앙 배포 역할에는 버스 스택 `DescribeStacks`와 `events:DescribeEventBus`만 남겼다. 버스 허용 목록은 배포 역할로 바꿀 수 없다.

### 3-2. 막은 우회 경로 (Deny 설명)

- `DenyPivotAndQueueData`: `sts:AssumeRole`·`TagSession`·`SetSourceIdentity`와 SQS 메시지 동작(`SendMessage`, `ReceiveMessage`, `DeleteMessage`, `PurgeQueue`, `StartMessageMoveTask`)을 `*`에 거부한다. `CreateRole`/`UpdateAssumeRolePolicy`가 있으면 배포 역할이 **자기를 신뢰하는 역할**을 만들거나 기존 역할의 신뢰를 바꾼 뒤 그 역할을 맡아 비밀을 읽거나 고객 역할에 닿을 수 있다. 명시적 Deny는 신뢰 정책 기반 허용보다 이긴다. 그래서 배포 역할 세션으로는 어떤 역할도 맡지 못한다. 배포 역할이 만든 역할은 CloudFormation이 아니라 서비스(Lambda, Vercel)가 맡는다.
- `DenyForceDeleteSecret`: 비밀을 복구 기간 없이 지우는 삭제(`ForceDeleteWithoutRecovery=true`)를 거부한다. `UpdateSecret`은 허용하지 않는다. 템플릿의 비밀에는 이름·설명뿐이라 필요 없고, 바꿀 일은 사람이 한다.
- `DenySecretValues`: 비밀 값 읽기·쓰기 거부.
- 경계 쪽 `NeverAssumeCustomerRemediatorExceptCaller`: 만든 역할 중 `AlarmOpsCentral-RemediatorCaller` 말고는 고객 `AlarmOps-Remediator`를 맡지 못한다.
- `PassRole`은 `AlarmOpsCentral-Engine`(`central.yaml`의 `CentralRole` 이름)과 `alarmops-central-*FunctionRole-*`(SAM 함수 역할)로 좁혔다. 나머지 두 역할은 Lambda에 넘기지 않는다.

## 4. 첫 실행용 임시 정책 (선택)

`aws-sam-cli-managed-default` 스택이 없을 때만 쓴다. 첫 `deploy-central` `plan`이 끝나면 역할에서 **뗀다.** 이 JSON은 SAM CLI가 관리 스택을 만들 때 쓰는 동작을 문서로 확인한 것이 아니라 추정이다. 거부가 나면 오류에 나온 동작만 더한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SamManagedStackCreate",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:GetTemplateSummary"
      ],
      "Resource": [
        "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:stack/aws-sam-cli-managed-default/*",
        "arn:aws:cloudformation:ap-northeast-2:<ACCOUNT_ID>:changeSet/*/*"
      ]
    },
    {
      "Sid": "SamManagedBucketCreate",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketPolicy",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketTagging"
      ],
      "Resource": "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-*"
    }
  ]
}
```

## 5. 콘솔 클릭 순서 (사람, 중앙 계정, 서울)

권한 경계 정책 → 역할(+권한 정책) 순서다. 경계가 먼저 있어야 권한 정책의 조건 ARN이 맞는다.

1. **권한 경계 정책 만들기**
   1. IAM → 정책 → 정책 생성
   2. 정책 편집기에서 **JSON** 탭을 고르고 위 2번 JSON을 붙여 넣는다. `<ACCOUNT_ID>`를 바꾼다.
   3. 다음 → 정책 이름 `AlarmOpsCentral-RoleBoundary` (정확히 이 이름) → 정책 생성
   4. 만든 정책을 열어 ARN을 확인한다. `arn:aws:iam::<ACCOUNT_ID>:policy/AlarmOpsCentral-RoleBoundary`여야 한다.
2. **배포 역할 만들기**
   1. IAM → 역할 → 역할 생성
   2. 신뢰할 수 있는 엔터티 유형: **웹 자격 증명**
   3. 자격 증명 공급자: `token.actions.githubusercontent.com`, Audience: `sts.amazonaws.com`
   4. GitHub 조직·리포지토리·브랜치 칸은 비워도 된다. 아래 3번에서 신뢰 정책을 JSON으로 덮어쓴다.
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
6. (첫 실행만) 4번의 임시 정책을 같은 방식으로 인라인 정책 `AlarmOpsDeployCentral-FirstRun`으로 붙인다. 첫 `plan` 뒤에 삭제한다.
7. **버스 허용 목록 역할 만들기**: 2번과 같은 방식으로 역할 `AlarmOpsDeployBus`를 만든다(웹 자격 증명, 같은 공급자·Audience).
   1. 신뢰 관계를 위 1번 JSON으로 덮어쓴다(`sub` 같음).
   2. 권한 탭 → 권한 추가 → 인라인 정책 생성 → **JSON** → 3-1의 JSON(`<ACCOUNT_ID>` 바꿈) → 이름 `AlarmOpsDeployBus-Policy`.
   3. 최대 세션 기간 1시간. 경계 정책은 붙이지 않는다(이 역할은 역할을 만들지 못한다).
8. **ARN을 두 변수에 따로 넣는다**(GO-LIVE 4-2, `central` 환경 변수):
   - `CENTRAL_DEPLOY_ROLE_ARN` = `AlarmOpsDeployCentral`의 ARN
   - `CENTRAL_BUS_DEPLOY_ROLE_ARN` = `AlarmOpsDeployBus`의 ARN
   - 두 변수에 같은 ARN을 넣지 않는다. `AlarmOpsDeployCentral`로는 버스 허용 목록을 바꿀 수 없다.
9. **경계 이름이 맞는지 확인**: 템플릿 이슈("먼저 알아 둘 것" 1번)가 끝난 뒤 `plan`이 `CreateRole`을 통과하는지 본다. 거부되면 `plan` 로그의 거부 메시지에서 `iam:PermissionsBoundary` 조건과 템플릿의 경계 ARN을 대조한다.

> **주의** 경계 정책은 배포 역할이 고칠 수 없다(`DenyBoundaryPolicyChange`). 고칠 때는 관리자가 새 버전을 만들고 `plan`에서 IAM 변경을 확인한다.

## 6. 왜 이 권한이 필요한가

| 문장(Sid) | 워크플로 | 단계 | 이유 |
|---|---|---|---|
| `CfnBusStackRead` | deploy-central | `plan` / `Check the central bus stack exists` | 버스 스택이 있는지 확인 |
| `SamValidateListPolicies` | deploy-central | `plan` / `sam validate` | SAM 변환이 관리형 정책 목록을 읽는다(추정) |
| `CfnCentralStack`(`ListChangeSets`) | deploy-central | `plan` / `Remember the change sets that exist before`, `Change set to the job summary` | 변경 세트 목록 비교 |
| `CfnSamManagedStackRead`, `SamBucketObjects`, `SamBucketList`, `CfnSamTransform`, `CfnCentralStack`(`CreateChangeSet`, `DescribeStackEvents`) | deploy-central | `plan` / `Create the change set (not executed)` (`sam deploy --resolve-s3 --no-execute-changeset`) | 관리 버킷에 코드 zip 올리기, 변환 포함 변경 세트 만들기 |
| `CfnCentralStack`(`DescribeChangeSet`, `DescribeStacks`) | deploy-central | `plan` / `Change set to the job summary` | IAM 변경 표 출력 |
| `CfnCentralStack`(`GetTemplate`), `SamBucketObjects`(`GetObject`) | deploy-central | `apply` / `Verify the change set carries exactly the code…` | 처리된 템플릿에서 코드 위치를 읽고 zip을 내려받아 해시 대조 |
| `CfnCentralStack`(`ExecuteChangeSet`) | deploy-central | `apply` / `Execute the approved change set` | 승인된 변경 세트 실행(실행하는 쪽이 아래 리소스 권한을 쓴다) |
| `IamCreateRoleWithBoundary`, `IamRolePoliciesWithBoundary`, `IamChangeRoles`, `IamAttachLambdaManagedPolicies`, `IamReadRoles` | deploy-central | `apply` / 실행 | `AlarmOpsCentral-Engine`·`-RemediatorCaller`·`-VercelConsole`과 SAM 함수 역할 생성·변경 |
| `IamPassRoleToLambdaOnly` | deploy-central | `apply` / 실행 | 함수 생성 시 실행 역할 전달(Lambda 서비스로만) |
| `LambdaFunctions`, `LambdaEventSourceMappings` | deploy-central | `apply` / 실행 | 함수 4개, SQS 이벤트 소스 2개, 규칙 호출 권한 |
| `Sqs` | deploy-central | `apply` / 실행 | 큐 6개와 큐 정책 |
| `EventsRulesOnCentralBus`, `EventsCentralBusRead` | deploy-central | `apply` / 실행 | 규칙 2개와 대상·DLQ 설정 |
| `LogGroups`, `LogsDescribe` | deploy-central | `apply` / 실행 | 로그 그룹 4개 |
| `SecretsManagerSecretsNoValues` | deploy-central | `apply` / 실행 | DB 비밀 2개(값 없이) |
| `CloudWatchAlarms`, `CloudWatchDescribe` | deploy-central | `apply` / 실행 | DLQ 알람 4개 |
| `ApiGatewayHttpApi` | deploy-central | `apply` / 실행 | HTTP API와 `$default` 스테이지 |
| `CfnCentralStack`(`DescribeStacks`) | deploy-central | `apply` / `execute-change-set` 뒤 `wait`, `Stack outputs to the job summary` | 완료 대기와 출력 표 |
| `CfnBusStack`(`DescribeStacks`, 역할 `AlarmOpsDeployBus`) | bus-allowlist | `Compute the new allow list` | 현재 `AllowedAccountIds`와 `BusName` 출력 읽기 |
| `CfnBusStack`(`UpdateStack`, `DescribeStackEvents`), `EventsCentralBus`(`PutPermission`/`RemovePermission`) (역할 `AlarmOpsDeployBus`) | bus-allowlist | `Update the bus stack` | 이전 템플릿으로 파라미터만 바꾸고 버스 정책 갱신 |
| `EventsCentralBus`(`DescribeEventBus`, 역할 `AlarmOpsDeployBus`) | bus-allowlist | `Verify the bus policy` | 정책에 계정이 있는지/없는지 확인 |
| `Deny*` 6개 | deploy-central | 모든 단계 | 경계 우회, 비밀 값 접근 차단 |

## 7. 검증하지 못한 것

- 이 문서의 JSON은 문법만 검사했다(`python json.loads`). IAM 정책 시뮬레이터나 실제 `plan`으로는 돌려 보지 못했다.
- 동작 목록은 템플릿과 워크플로에서 도출했다. CloudFormation이 리소스 생성 때 부르는 보조 동작(예: 태그·조회)은 실제 `plan`/`apply`의 `AccessDenied` 메시지로 마무리한다. 처음 두세 번은 거부가 나올 수 있다고 보고 사람이 지켜본다.
- 확신이 낮은 항목: `sam validate`의 `iam:ListPolicies`, 변경 세트 ARN 리소스 형태(`changeSet/samcli-deploy*/*`), SAM이 붙이는 관리형 정책이 위 둘뿐인지, 첫 실행용 임시 정책의 동작 목록.
- 경계 조건 키(`iam:PermissionsBoundary`)는 `CreateRole`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePermissionsBoundary`에만 걸었다. 나머지 역할 변경 동작은 조건 키를 지원하지 않아 이름 범위로만 막는다.
