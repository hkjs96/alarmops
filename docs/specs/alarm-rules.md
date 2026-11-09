# 알람 규칙 (리소스 29종 기본값 · 태그 계약 · 임계치 해석 순서)

상태: 초안

- 출처: AAM `aws-alert-manager` 커밋 `4eafce9`(2026-11-04), 읽기 전용으로 추출. 경로는 저장소 루트 기준.
- 관련 결정: D-05(엔진 재설계 없이 이식), D-07(역할 분리), D-08(임계치 우선순위·태그 읽기 전용).
- 표기: **(추정)** = 코드에서 직접 확인하지 못하고 정황으로 판단한 내용.

## 1. 리소스 타입 레지스트리

1. 리소스 타입 하나 = 스펙 파일 하나(`backend/common/resource_types/<type>.py`). `register(ResourceTypeSpec(...))`로 등록하면 지원 타입 목록·메트릭 키·네임스페이스·CloudTrail 이벤트·수집기 맵이 파생된다.
   - 근거: `backend/common/resource_types/base.py:1-20`, `:46-101`(필드 정의), `:126-139`(`register`). 리팩터링 커밋 `5a92838`, `5d1f259`, `23bc6c6`(2026-09-15).
2. 알람 정의 dict 필드: `metric`(내부 키), `metric_key`(선택, 태그 suffix로 쓰는 키), `namespace`, `metric_name`(CloudWatch 이름), `dimension_key`, `stat`, `comparison`, `period`, `evaluation_periods`, `treat_missing_data`, 선택 `datapoints_to_alarm`·`transform_threshold`/`transform_value`(짝 필수)·`opt_in`·`dynamic_dimensions`·`region`·`needs_client_id`·`needs_storage_type`.
   - 근거: `base.py:62-70`, `_check_transform_pairs` `base.py:108-123`(역함수 검사, 2026-09-16).
3. `alarm_defs`는 리스트 또는 `Callable[[tags], list]`(태그 조건부). 조건부면 `variants`에 태그 조합을 전부 적는다(완전성 테스트).
   - 근거: `base.py:66-75`; EC2 앱 상태검사 옵트인 `backend/common/resource_types/ec2.py:92-101`.
4. 기본 임계치는 스펙의 `defaults`, 표시(이름에 쓰는 지표명·방향·단위)는 `display`. 여러 타입이 같은 키를 쓰면 값이 같아야 한다(뷰가 강제).
   - 근거: `ec2.py:104-131`; 옛 태그 키 호환 기본값 `backend/common/resource_types/legacy.py:1-40`.
5. 글로벌 서비스(CloudFront, Route53)는 알람을 `us-east-1`에 만든다(`region` 필드 / `global_region`).
   - 근거: `base.py:60`, `backend/common/alarm_manager.py:196-199`, `docs/ALARM-RULES.md` §8.

## 2. 평가 정책(M/N)과 등급(Severity)

1. 기본 등급은 `_DEFAULT_SEVERITY`(메트릭 키 → SEV). 없으면 **SEV-5**. `Disk_*`·`disk_used_percent_*`는 SEV-3.
   - 근거: `backend/common/alarm_registry.py:256-334`, `get_severity` `:341-349`.
2. 등급별 기본 M-of-N(DatapointsToAlarm/EvaluationPeriods): SEV-2·SEV-3 = **2/3**, SEV-4·SEV-5 = **3/5**, SEV-1 = 1/1.
   - 근거: `alarm_registry.py:39-44`. 도입 커밋 `0ac4080`(2026-08-26).
3. 다음은 자동 정책 제외(정의값 1/1 유지): SEV-1, `treat_missing_data="breaching"`, `period ≥ 3600`, 정의에 `datapoints_to_alarm` 명시.
   - 근거: `_apply_eval_policy` `alarm_registry.py:47-74`.
4. 리소스 태그 `Threshold_{지표}_Eval=M/N`(1 ≤ M ≤ N ≤ 10)이 자동 정책을 이긴다. 단 **잠긴 정의**(SEV-1 또는 period ≥ 3600)는 무시한다. breaching 지표(EC2/RDS CPU 등)는 잠기지 않아 사람이 M/N을 바꿀 수 있다. 형식 오류면 경고 후 무시.
   - 근거: `eval_locked` `alarm_registry.py:86-96`, `_apply_eval_tags` `:98-109`, `parse_eval`/`get_eval_override` `backend/common/tag_resolver.py:50-87`. 커밋 `60d2138`(2026-11-03).
5. 동적 알람(`Threshold_*` 태그로 생긴 비하드코딩 지표)의 M/N은 등급 정책만 적용(`get_dynamic_eval_policy`), `_Eval` 태그는 대상 아님(추정: `_create_dynamic_alarm`이 `get_dynamic_eval_policy`만 호출).
   - 근거: `alarm_registry.py:77-83`, `backend/common/alarm_builder.py:390`.

## 3. 타입별 기본 알람 표

열 설명: `키`=내부 메트릭 키(= `Threshold_{키}` 태그 suffix), `M/N`=위 2절 규칙을 적용한 **실효값**(DatapointsToAlarm/EvaluationPeriods), `등급`=기본 Severity, `TMD`=TreatMissingData. 단위 열의 `(GB→bytes)`는 표시 단위 GB를 CloudWatch bytes로 변환해 올림. 줄 번호는 정의 dict 시작 줄. 같은 타입에서 키가 반복되면 태그 변형(예: APIGW REST/HTTP/WebSocket, TG ALB/NLB, Aurora 서버리스/프로비저닝)의 서로 다른 정의다.

> 이 표는 정의 파일을 정적으로 파싱해 만들었다(코드 실행 안 함). M/N·등급은 `alarm_registry.py`의 규칙을 손으로 적용한 값이라 이식 후 테스트로 다시 확인해야 한다.

| 타입 | 키 | 네임스페이스/지표 | 통계 | 주기(s) | 기본 임계치 | 단위 | M/N | 등급 | TMD | 근거(`backend/common/resource_types/`) |
|---|---|---|---|---|---|---|---|---|---|---|
| ACM | `DaysToExpiry` | AWS/CertificateManager/DaysToExpiry | Minimum | 86400 | < 14.0 | days | 1/1 | SEV-3 |missing| acm.py:13 |
| ALB | `RequestCount` | AWS/ApplicationELB/RequestCount | Sum | 60 | > 10000.0 |  | 3/5 | SEV-5 |notBreaching| alb.py:13 |
| ALB | `HTTPCode_ELB_5XX_Count` | AWS/ApplicationELB/HTTPCode_ELB_5XX_Count | Sum | 60 | > 50.0 |  | 2/3 | SEV-2 |notBreaching| alb.py:24 |
| ALB | `TargetResponseTime` | AWS/ApplicationELB/TargetResponseTime | Average | 60 | > 5.0 | s | 3/5 | SEV-4 |notBreaching| alb.py:35 |
| ALB | `ELB4XX` | AWS/ApplicationELB/HTTPCode_ELB_4XX_Count | Sum | 60 | > 100.0 |  | 3/5 | SEV-4 |notBreaching| alb.py:46 |
| ALB | `TargetConnectionError` | AWS/ApplicationELB/TargetConnectionErrorCount | Sum | 60 | > 50.0 |  | 2/3 | SEV-2 |notBreaching| alb.py:57 |
| APIGW | `ApiLatency` | AWS/ApiGateway/Latency | Average | 300 | > 3000.0 | ms | 3/5 | SEV-4 | (미지정→notBreaching) | apigw.py:13 |
| APIGW | `Api4XXError` | AWS/ApiGateway/4XXError | Sum | 300 | > 1.0 |  | 3/5 | SEV-4 | (미지정→notBreaching) | apigw.py:23 |
| APIGW | `Api5XXError` | AWS/ApiGateway/5XXError | Sum | 300 | > 1.0 |  | 2/3 | SEV-2 | (미지정→notBreaching) | apigw.py:33 |
| APIGW | `ApiLatency` | AWS/ApiGateway/Latency | Average | 300 | > 3000.0 | ms | 3/5 | SEV-4 | (미지정→notBreaching) | apigw.py:47 |
| APIGW | `Api4xx` | AWS/ApiGateway/4xx | Sum | 300 | > 1.0 |  | 3/5 | SEV-4 | (미지정→notBreaching) | apigw.py:57 |
| APIGW | `Api5xx` | AWS/ApiGateway/5xx | Sum | 300 | > 1.0 |  | 2/3 | SEV-2 | (미지정→notBreaching) | apigw.py:67 |
| APIGW | `WsConnectCount` | AWS/ApiGateway/ConnectCount | Sum | 300 | > 1000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | apigw.py:81 |
| APIGW | `WsMessageCount` | AWS/ApiGateway/MessageCount | Sum | 300 | > 10000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | apigw.py:91 |
| APIGW | `WsIntegrationError` | AWS/ApiGateway/IntegrationError | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | apigw.py:101 |
| APIGW | `WsExecutionError` | AWS/ApiGateway/ExecutionError | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | apigw.py:111 |
| AuroraRDS | `ReaderReplicaLag` | AWS/RDS/AuroraReplicaLag | Maximum | 300 | > 2000.0 | ms | 2/3 | SEV-3 |missing| aurora_rds.py:75 |
| AuroraRDS | `ACUUtilization` | AWS/RDS/ACUUtilization | Average | 300 | > 80.0 | % | 1/1 | SEV-3 |breaching| aurora_rds.py:88 |
| AuroraRDS | `ServerlessDatabaseCapacity` | AWS/RDS/ServerlessDatabaseCapacity | Average | 300 | > 128.0 | ACU | 3/5 | SEV-5 | (미지정→notBreaching) | aurora_rds.py:101 |
| AuroraRDS | `CPUUtilization` | AWS/RDS/CPUUtilization | Average | 300 | > 80.0 | % | 1/1 | SEV-3 |breaching| aurora_rds.py:13 |
| AuroraRDS | `FreeableMemory` | AWS/RDS/FreeableMemory | Average | 300 | < 2.0 | GB (GB→bytes) | 1/1 | SEV-3 |breaching| aurora_rds.py:24 |
| AuroraRDS | `DatabaseConnections` | AWS/RDS/DatabaseConnections | Average | 300 | > 100.0 |  | 1/1 | SEV-5 |breaching| aurora_rds.py:37 |
| AuroraRDS | `FreeLocalStorage` | AWS/RDS/FreeLocalStorage | Average | 300 | < 10.0 | GB (GB→bytes) | 1/1 | SEV-3 |breaching| aurora_rds.py:48 |
| AuroraRDS | `ReplicaLag` | AWS/RDS/AuroraReplicaLagMaximum | Maximum | 300 | > 2000.0 | ms | 2/3 | SEV-3 |missing| aurora_rds.py:61 |
| Backup | `BackupJobsFailed` | AWS/Backup/NumberOfBackupJobsFailed | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | backup.py:13 |
| Backup | `BackupJobsAborted` | AWS/Backup/NumberOfBackupJobsAborted | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | backup.py:23 |
| CLB | `CLBUnHealthyHost` | AWS/ELB/UnHealthyHostCount | Average | 60 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:13 |
| CLB | `CLB5XX` | AWS/ELB/HTTPCode_ELB_5XX | Sum | 60 | > 300.0 |  | 2/3 | SEV-2 | (미지정→notBreaching) | clb.py:23 |
| CLB | `CLB4XX` | AWS/ELB/HTTPCode_ELB_4XX | Sum | 60 | > 300.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:33 |
| CLB | `CLBBackend5XX` | AWS/ELB/HTTPCode_Backend_5XX | Sum | 60 | > 300.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:43 |
| CLB | `CLBBackend4XX` | AWS/ELB/HTTPCode_Backend_4XX | Sum | 60 | > 300.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:53 |
| CLB | `SurgeQueueLength` | AWS/ELB/SurgeQueueLength | Maximum | 60 | > 300.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:63 |
| CLB | `SpilloverCount` | AWS/ELB/SpilloverCount | Sum | 60 | > 300.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | clb.py:73 |
| CloudFront | `CF5xxErrorRate` | AWS/CloudFront/5xxErrorRate | Average | 300 | > 1.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | cloudfront.py:13 |
| CloudFront | `CF4xxErrorRate` | AWS/CloudFront/4xxErrorRate | Average | 300 | > 5.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | cloudfront.py:24 |
| CloudFront | `CFRequests` | AWS/CloudFront/Requests | Sum | 300 | > 1000000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | cloudfront.py:35 |
| CloudFront | `CFBytesDownloaded` | AWS/CloudFront/BytesDownloaded | Sum | 300 | > 10000000000.0 | B | 3/5 | SEV-5 | (미지정→notBreaching) | cloudfront.py:46 |
| DocDB | `CPUUtilization` | AWS/DocDB/CPUUtilization | Average | 300 | > 80.0 | % | 1/1 | SEV-3 |breaching| docdb.py:13 |
| DocDB | `FreeableMemory` | AWS/DocDB/FreeableMemory | Average | 300 | < 2.0 | GB (GB→bytes) | 1/1 | SEV-3 |breaching| docdb.py:24 |
| DocDB | `DatabaseConnections` | AWS/DocDB/DatabaseConnections | Average | 300 | > 100.0 |  | 1/1 | SEV-5 |breaching| docdb.py:37 |
| DX | `ConnectionState` | AWS/DX/ConnectionState | Minimum | 300 | < 1.0 |  | 1/1 | SEV-1 |breaching| dx.py:13 |
| DynamoDB | `DDBReadCapacity` | AWS/DynamoDB/ConsumedReadCapacityUnits | Sum | 300 | > 80.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | dynamodb.py:13 |
| DynamoDB | `DDBWriteCapacity` | AWS/DynamoDB/ConsumedWriteCapacityUnits | Sum | 300 | > 80.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | dynamodb.py:23 |
| DynamoDB | `ThrottledRequests` | AWS/DynamoDB/ThrottledRequests | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | dynamodb.py:33 |
| DynamoDB | `DDBSystemErrors` | AWS/DynamoDB/SystemErrors | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | dynamodb.py:43 |
| EC2 | `StatusCheckFailed_Application` | AWS/EC2/StatusCheckFailed_Application | Maximum | 60 | > 0.0 |  | 1/1 | SEV-1 |notBreaching · 옵트인| ec2.py:72 |
| EC2 | `CPUUtilization` | AWS/EC2/CPUUtilization | Average | 300 | > 80.0 | % | 1/1 | SEV-3 |breaching| ec2.py:23 |
| EC2 | `mem_used_percent` | CWAgent/mem_used_percent | Average | 300 | > 80.0 | % | 2/3 | SEV-3 |notBreaching| ec2.py:34 |
| EC2 | `disk_used_percent` | CWAgent/disk_used_percent | Average | 300 | > 80.0 | % | 2/3 | SEV-3 |notBreaching| ec2.py:45 |
| EC2 | `StatusCheckFailed` | AWS/EC2/StatusCheckFailed | Maximum | 300 | > 0.0 |  | 1/1 | SEV-1 |breaching| ec2.py:58 |
| ECS | `EcsCPU` | AWS/ECS/CPUUtilization | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | ecs.py:13 |
| ECS | `EcsMemory` | AWS/ECS/MemoryUtilization | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | ecs.py:23 |
| EFS | `BurstCreditBalance` | AWS/EFS/BurstCreditBalance | Minimum | 300 | < 1000000000.0 |  | 3/5 | SEV-4 | (미지정→notBreaching) | efs.py:13 |
| EFS | `PercentIOLimit` | AWS/EFS/PercentIOLimit | Average | 300 | > 90.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | efs.py:23 |
| EFS | `EFSClientConnections` | AWS/EFS/ClientConnections | Sum | 300 | > 1000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | efs.py:33 |
| ElastiCache | `CPUUtilization` | AWS/ElastiCache/CPUUtilization | Average | 300 | >= 80.0 | % | 1/1 | SEV-3 |breaching| elasticache.py:13 |
| ElastiCache | `EngineCPU` | AWS/ElastiCache/EngineCPUUtilization | Average | 300 | >= 90.0 | % | 1/1 | SEV-3 |breaching| elasticache.py:24 |
| ElastiCache | `DatabaseMemoryUsagePercentage` | AWS/ElastiCache/DatabaseMemoryUsagePercentage | Average | 300 | >= 80.0 | % | 2/3 | SEV-2 |notBreaching| elasticache.py:35 |
| ElastiCache | `Evictions` | AWS/ElastiCache/Evictions | Average | 300 | >= 5.0 |  | 1/1 | SEV-3 |breaching| elasticache.py:46 |
| ElastiCache | `CurrConnections` | AWS/ElastiCache/CurrConnections | Average | 300 | >= 200.0 |  | 1/1 | SEV-5 |breaching| elasticache.py:57 |
| Lambda | `Duration` | AWS/Lambda/Duration | Average | 300 | > 2500.0 | ms | 3/5 | SEV-4 | (미지정→notBreaching) | lambda_fn.py:13 |
| Lambda | `Errors` | AWS/Lambda/Errors | Sum | 300 | > 0.0 |  | 2/3 | SEV-2 | (미지정→notBreaching) | lambda_fn.py:23 |
| MQ | `MqCPU` | AWS/AmazonMQ/CpuUtilization | Average | 300 | > 90.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | mq.py:13 |
| MQ | `HeapUsage` | AWS/AmazonMQ/HeapUsage | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | mq.py:23 |
| MQ | `JobSchedulerStoreUsage` | AWS/AmazonMQ/JobSchedulerStorePercentUsage | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | mq.py:33 |
| MQ | `StoreUsage` | AWS/AmazonMQ/StorePercentUsage | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | mq.py:43 |
| MSK | `OffsetLag` | AWS/Kafka/SumOffsetLag | Maximum | 300 | > 1000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | msk.py:13 |
| MSK | `BytesInPerSec` | AWS/Kafka/BytesInPerSec | Average | 300 | > 100000000.0 | B/s | 3/5 | SEV-5 | (미지정→notBreaching) | msk.py:23 |
| MSK | `UnderReplicatedPartitions` | AWS/Kafka/UnderReplicatedPartitions | Maximum | 300 | > 0.0 |  | 1/1 | SEV-5 |breaching| msk.py:33 |
| MSK | `ActiveControllerCount` | AWS/Kafka/ActiveControllerCount | Average | 300 | < 1.0 |  | 1/1 | SEV-1 |breaching| msk.py:44 |
| NAT | `PacketsDropCount` | AWS/NATGateway/PacketsDropCount | Sum | 300 | > 1.0 |  | 2/3 | SEV-3 |notBreaching| nat.py:14 |
| NAT | `ErrorPortAllocation` | AWS/NATGateway/ErrorPortAllocation | Sum | 300 | > 1.0 |  | 2/3 | SEV-2 |notBreaching| nat.py:25 |
| NLB | `ProcessedBytes` | AWS/NetworkELB/ProcessedBytes | Sum | 60 | > 100000000.0 |  | 3/5 | SEV-5 |notBreaching| nlb.py:13 |
| NLB | `ActiveFlowCount` | AWS/NetworkELB/ActiveFlowCount | Average | 60 | > 10000.0 |  | 3/5 | SEV-5 |notBreaching| nlb.py:24 |
| NLB | `NewFlowCount` | AWS/NetworkELB/NewFlowCount | Sum | 60 | > 5000.0 |  | 3/5 | SEV-5 |notBreaching| nlb.py:35 |
| NLB | `TCP_Client_Reset_Count` | AWS/NetworkELB/TCP_Client_Reset_Count | Sum | 60 | > 100.0 |  | 3/5 | SEV-5 |notBreaching| nlb.py:46 |
| NLB | `TCP_Target_Reset_Count` | AWS/NetworkELB/TCP_Target_Reset_Count | Sum | 60 | > 100.0 |  | 3/5 | SEV-5 |notBreaching| nlb.py:57 |
| OpenSearch | `ClusterStatusRed` | AWS/ES/ClusterStatus.red | Maximum | 300 | > 0.0 |  | 1/1 | SEV-1 |breaching| opensearch.py:13 |
| OpenSearch | `ClusterStatusYellow` | AWS/ES/ClusterStatus.yellow | Maximum | 300 | > 0.0 |  | 1/1 | SEV-5 |breaching| opensearch.py:25 |
| OpenSearch | `OSFreeStorageSpace` | AWS/ES/FreeStorageSpace | Minimum | 300 | < 20480.0 | MB | 1/1 | SEV-3 |breaching| opensearch.py:37 |
| OpenSearch | `ClusterIndexWritesBlocked` | AWS/ES/ClusterIndexWritesBlocked | Maximum | 300 | > 0.0 |  | 1/1 | SEV-5 |breaching| opensearch.py:49 |
| OpenSearch | `OsCPU` | AWS/ES/CPUUtilization | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | opensearch.py:61 |
| OpenSearch | `JVMMemoryPressure` | AWS/ES/JVMMemoryPressure | Maximum | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | opensearch.py:72 |
| OpenSearch | `MasterCPU` | AWS/ES/MasterCPUUtilization | Average | 300 | > 50.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | opensearch.py:83 |
| OpenSearch | `MasterJVMMemoryPressure` | AWS/ES/MasterJVMMemoryPressure | Maximum | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | opensearch.py:94 |
| RDS | `CPUUtilization` | AWS/RDS/CPUUtilization | Average | 300 | > 80.0 | % | 1/1 | SEV-3 |breaching| rds.py:13 |
| RDS | `FreeableMemory` | AWS/RDS/FreeableMemory | Average | 300 | < 2.0 | GB (GB→bytes) | 1/1 | SEV-3 |breaching| rds.py:24 |
| RDS | `FreeStorageSpace` | AWS/RDS/FreeStorageSpace | Average | 300 | < 10.0 | GB (GB→bytes) | 1/1 | SEV-3 |breaching| rds.py:37 |
| RDS | `DatabaseConnections` | AWS/RDS/DatabaseConnections | Average | 300 | > 100.0 |  | 1/1 | SEV-5 |breaching| rds.py:50 |
| RDS | `ReadLatency` | AWS/RDS/ReadLatency | Average | 300 | > 0.02 | s | 3/5 | SEV-4 |notBreaching| rds.py:61 |
| RDS | `WriteLatency` | AWS/RDS/WriteLatency | Average | 300 | > 0.02 | s | 3/5 | SEV-4 |notBreaching| rds.py:72 |
| RDS | `ConnectionAttempts` | AWS/RDS/ConnectionAttempts | Sum | 300 | > 500.0 |  | 3/5 | SEV-5 |notBreaching| rds.py:83 |
| Route53 | `HealthCheckStatus` | AWS/Route53/HealthCheckStatus | Minimum | 300 | < 1.0 |  | 1/1 | SEV-1 |breaching| route53.py:13 |
| S3 | `S34xxErrors` | AWS/S3/4xxErrors | Sum | 300 | > 100.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | s3.py:13 |
| S3 | `S35xxErrors` | AWS/S3/5xxErrors | Sum | 300 | > 10.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | s3.py:23 |
| S3 | `S3BucketSizeBytes` | AWS/S3/BucketSizeBytes | Average | 86400 | > 1000000000000.0 | B | 1/1 | SEV-5 |missing| s3.py:33 |
| S3 | `S3NumberOfObjects` | AWS/S3/NumberOfObjects | Average | 86400 | > 10000000.0 |  | 1/1 | SEV-5 |missing| s3.py:45 |
| SageMaker | `SMInvocations` | AWS/SageMaker/Invocations | Sum | 300 | > 100000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sagemaker.py:13 |
| SageMaker | `SMInvocationErrors` | AWS/SageMaker/InvocationErrors | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sagemaker.py:23 |
| SageMaker | `SMModelLatency` | AWS/SageMaker/ModelLatency | Average | 300 | > 1000.0 | μs | 3/5 | SEV-5 | (미지정→notBreaching) | sagemaker.py:33 |
| SageMaker | `SMCPU` | AWS/SageMaker/CPUUtilization | Average | 300 | > 80.0 | % | 3/5 | SEV-5 | (미지정→notBreaching) | sagemaker.py:43 |
| SNS | `SNSNotificationsFailed` | AWS/SNS/NumberOfNotificationsFailed | Sum | 300 | > 0.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sns.py:13 |
| SNS | `SNSMessagesPublished` | AWS/SNS/NumberOfMessagesPublished | Sum | 300 | > 1000000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sns.py:23 |
| SQS | `SQSMessagesVisible` | AWS/SQS/ApproximateNumberOfMessagesVisible | Average | 300 | > 1000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sqs.py:13 |
| SQS | `SQSOldestMessage` | AWS/SQS/ApproximateAgeOfOldestMessage | Maximum | 300 | > 300.0 | s | 3/5 | SEV-5 | (미지정→notBreaching) | sqs.py:23 |
| SQS | `SQSMessagesSent` | AWS/SQS/NumberOfMessagesSent | Sum | 300 | > 10000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | sqs.py:33 |
| TG | `HealthyHostCount` | AWS/ApplicationELB/HealthyHostCount | Average | 60 | < 1.0 |  | 1/1 | SEV-1 |breaching| tg.py:13 |
| TG | `UnHealthyHostCount` | AWS/ApplicationELB/UnHealthyHostCount | Average | 60 | > 1.0 |  | 2/3 | SEV-2 |notBreaching| tg.py:24 |
| TG | `RequestCountPerTarget` | AWS/ApplicationELB/RequestCountPerTarget | Sum | 60 | > 1000.0 |  | 3/5 | SEV-5 |notBreaching| tg.py:35 |
| TG | `TargetResponseTime` | AWS/ApplicationELB/TargetResponseTime | Average | 60 | > 5.0 | s | 3/5 | SEV-4 |notBreaching| tg.py:46 |
| VPN | `TunnelState` | AWS/VPN/TunnelState | Maximum | 300 | < 1.0 |  | 1/1 | SEV-1 |breaching| vpn.py:14 |
| WAF | `WAFBlockedRequests` | AWS/WAFV2/BlockedRequests | Sum | 300 | > 100.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | waf.py:13 |
| WAF | `WAFAllowedRequests` | AWS/WAFV2/AllowedRequests | Sum | 300 | > 1000000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | waf.py:23 |
| WAF | `WAFCountedRequests` | AWS/WAFV2/CountedRequests | Sum | 300 | > 100000.0 |  | 3/5 | SEV-5 | (미지정→notBreaching) | waf.py:33 |

표에서 보이는 특이점:
- APIGW WebSocket 지표(`WsConnectCount`·`WsMessageCount`·`WsIntegrationError`·`WsExecutionError`)는 `_DEFAULT_SEVERITY`에 없어 **SEV-5 폴백**이다. `WsIntegrationError`가 SEV-5인 것은 의도가 아닐 가능성이 있다(추정).
- 기본 임계치 `0.0`(StatusCheckFailed 등, "> 0")은 태그 값 검증(`> 0`만 유효)과 달리 하드코딩 기본값 단계에서 그대로 쓰인다 — `get_threshold`의 3단계는 양수 검사를 하지 않는다(`tag_resolver.py:164-166`).
- EC2 `disk_used_percent`는 CWAgent `list_metrics`로 경로별 디멘션을 찾아 경로마다 알람(`Disk_{suffix}`)을 만든다. 지표가 없으면 만들지 않는다(`alarm_builder.py:189-265`). 메모리/가상 파일시스템은 제외(`ae211e7`).
- EC2 `StatusCheckFailed_Application`은 옵트인: `Threshold_StatusCheckFailed_Application` 태그가 있을 때만 정의가 붙는다(`ec2.py:72-101`, 커밋 `15b71b6`).
- RDS/Aurora `FreeableMemory`·`FreeLocalStorage`는 4절의 퍼센트 해석을 탄다.

## 4. 태그 계약 (고객 리소스 태그)

1. **`Monitoring=on`** 이 감시 의도의 정본. 키는 정확히 `Monitoring`, 값은 대소문자 무시(`on`). 이외 값이나 태그 제거 = 감시 해제 → 알람 삭제.
   - 근거: `has_monitoring_tag` `tag_resolver.py:225-235`; `docs/specs/monitoring-tag-contract/design.md` D4; `docs/ALARM-RULES.md:3`.
2. ACM도 `Monitoring=on`인 인증서만 감시(예전엔 전체 수집).
   - 근거: design.md D5, 커밋 `69c8b64`(2026-10-12).
3. **`Threshold_{키}={양수}`**: 해당 지표 임계치. 레거시 친숙명(`Threshold_CPU`, `Threshold_FreeMemoryGB`, `Threshold_Memory`, `Threshold_Disk`, `Threshold_Connections`, `Threshold_ELB5XX`, `Threshold_TGResponseTime` 등)도 읽는다(`_LEGACY_TAG_MAP`). 숫자가 아니거나 0 이하면 경고 후 다음 단계로.
   - 근거: `tag_resolver.py:21-33`, `get_threshold` `:90-172`, `legacy.py`.
4. **`Threshold_{키}=off`**(대소문자 무시): 그 지표 알람을 만들지 않고, 있으면 지운다. 레거시명 `off`도 인정.
   - 근거: `is_threshold_off` `tag_resolver.py:36-47`, `alarm_sync.py:269-303`.
5. **`Threshold_{키}_Eval=M/N`**: 판단 방식(2절 4). 동적 알람 파싱에서 제외.
   - 근거: `tag_resolver.py:50-87`, `alarm_manager.py:141-142`.
6. **`Threshold_Disk_{suffix}`**: EC2 경로별 디스크 임계치. `/`→`root`, `/var/log`→`var_log`(역변환은 `_`를 `/`로 복원하지 않음). `root` 외 suffix는 해당 경로를 추가로 탐색하게 한다.
   - 근거: `tag_resolver.py:175-222`, `alarm_builder.py:200-205`.
7. **`Threshold_FreeMemoryPct` / `Threshold_FreeLocalStoragePct`**(0<값<100): RDS 계열 메모리·로컬 스토리지 임계치를 총량의 퍼센트로. 4절 해석 순서 참고.
8. **동적 알람**: 하드코딩 키·CloudWatch 이름 별칭·레거시명이 아닌 `Threshold_{MetricName}=값`은 동적 알람(기본 `>`). `Threshold_LT_{MetricName}`이면 `<`. 키 128자 제한, 허용 문자 검사, 양의 유한수만. 디멘션은 `list_metrics`로 해석.
   - 근거: `_parse_threshold_tags` `alarm_manager.py:112-179`, KI-005, `docs/ALARM-RULES.md` §7.
9. **`Name`** 태그는 알람 이름의 label로 쓴다(없으면 리소스 ID).
   - 근거: `alarm_manager.py:204`, `alarm_naming.py:92-168`.
10. **Severity는 리소스 태그가 아니라 알람 태그**(`Severity`, `ManagedBy=AlarmManager`)와 알람 설명 JSON에 둔다 — `alarm-sync.md` 참고. `docs/ALARM-RULES.md` §13-3의 "리소스별/고객사별 등급 오버라이드"는 문서상 계획일 뿐 코드에 없다(`get_severity`는 dict만 본다).
11. AWS 태그 제약: 키 128자, 값 256자, 리소스당 50개, 허용 문자 `문자 숫자 공백 _ . : / = + - @`, `aws:` 접두 무시.
   - 근거: `docs/ALARM-RULES.md` §7.

## 5. 임계치 해석 순서 (현재)

일반 지표 — `resolve_threshold` → `get_threshold` (`backend/common/threshold_resolver.py:139-157`, `tag_resolver.py:90-172`):

1. 리소스 태그 `Threshold_{키}` → 없으면 레거시명 `Threshold_{옛이름}`. 양수일 때만 채택.
2. **고객사 기본값**(설정 > 임계치, DynamoDB `ThresholdOverridesTable`, `scope_id=customer_id:{id}`, `metric_key={타입}#{지표}`). 구현은 "태그에 없는 지표만 가상 `Threshold_*` 태그로 끼워 넣기"라 1단계와 같은 경로를 탄다. 실제 태그(레거시명·`off` 포함)가 항상 이긴다.
   - 근거: `backend/common/customer_thresholds.py:1-15`, `apply` `:79-87`; 커밋 `a791edc`(2026-10-26). 적용 지점: `backend/daily_monitor/lambda_handler.py:360-375`(daily·hourly reconcile), `backend/api_handler/routes/resources.py:854`(토글), `routes/resource_thresholds.py:101,258`.
3. 환경 변수 `DEFAULT_{BASE}_THRESHOLD`(레거시 base 이름 폴백). 양수만.
4. 스펙 `defaults`(`HARDCODED_DEFAULTS`). 없으면 경고 후 `80.0`.
5. 표시값 → CloudWatch 값 변환(`transform_threshold`, 예: GB→bytes).

RDS 계열 `FreeableMemory` (`threshold_resolver.py:15-75`):
1. Serverless v2(`_is_serverless_v2=true`)면 퍼센트 생략, GB 절대값(`get_threshold`)만. 메모리 압박은 ACUUtilization이 대신 본다.
2. `Threshold_FreeMemoryPct`(0<p<100) + `_total_memory_bytes` 있으면 `p% × 총메모리`.
3. `_total_memory_bytes`가 있으면 기본 퍼센트 `FreeMemoryPct`(20%) 자동 적용 — **즉 프로비저닝 인스턴스는 `Threshold_FreeableMemory`(GB) 태그가 있어도 무시되고 20%가 쓰인다**(추정: 코드 순서상 2단계 다음 바로 3단계라 GB 태그를 보지 않음).
4. 그 외 `get_threshold("FreeableMemory")` GB 절대값.

`FreeLocalStorage`도 같은 구조(`_total_local_storage_bytes`, `Threshold_FreeLocalStoragePct`, 기본 20%) — `threshold_resolver.py:78-136`.

디스크 경로별(`Disk_{suffix}`)은 고객사 기본값 층을 거치지 않는다(`customer_thresholds.py:13`).

## 6. 임계치 해석 순서 (새 설계, D-08)

| 순위 | 현재 AAM | 새 구현(D-08) |
|---|---|---|
| 1 | 리소스 태그 `Threshold_*` (콘솔 변경도 여기에 **씀**) | 리소스 태그 `Threshold_*` — **읽기만** |
| 2 | 고객사 기본값(DynamoDB) | **콘솔 개별값** — 우리가 만든 알람에 저장(알람 태그/설명 메타데이터) |
| 3 | 환경 변수 `DEFAULT_*_THRESHOLD` | 고객사 기본값 |
| 4 | 스펙 기본값 | 스펙 기본값 |

- 환경 변수 층은 D-08에 없다 → 제거하거나 스펙 기본값에 흡수(결정 필요).
- 콘솔 개별값을 알람에 저장하므로, 알람 재생성 시 이 값을 지우기 전에 읽어 보존해야 한다(현재 수동 Severity 보존 `_severity_overrides`와 같은 패턴, `alarm-sync.md` 참고).
- 중앙 DB에는 변경 기록(누가·언제·이전값)을 남긴다(D-08).
- `off`와 `_Eval`(M/N)도 같은 우선순위로 읽어야 한다: 태그 > 콘솔(알람 저장) > 고객 기본값 > 정책. 고객사 기본 M/N은 현재 없다.

## 과거 수정 사례

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-05-15 | `c028ca2` | TreatMissingData 레지스트리 계약 정렬 |
| 2026-08-26 | `0ac4080` | 등급 기반 M-of-N 도입(순간 스파이크 오탐 감소) |
| 2026-08-25 | `7143c72` | ALARM-RULES §13-2의 SEV-1(`ClusterStatusRed`)이 코드에 없어 SEV-5로 폴백되던 문제 등 |
| 2026-09-16 | `8f7926d` | Aurora 복제 지연 단위가 µs가 아니라 ms(KI-010). 템플릿의 임계치 환경 변수 이름을 `get_threshold`가 읽는 이름과 맞춤 |
| 2026-09-16 | (base.py 주석) | 변환 함수 짝·역함수 검사 추가 |
| 2026-09-23 | `ae211e7` | 메모리/가상 파일시스템 디스크에 알람 만들지 않음 |
| 2026-10-12 | `69c8b64` | ACM도 `Monitoring=on`만 감시 |
| 2026-10-26 | `a791edc` | 설정 화면의 고객사 기본값이 저장만 되고 아무도 읽지 않던 거짓 UI 수정 |
| 2026-11-02 | `30ac2b6` | 고객 역할에 `Threshold_*` 태그 쓰기·삭제 권한 추가(→ D-08과 충돌, 되돌릴 대상) |
| 2026-11-03 | `60d2138` | 콘솔에서 리소스별 임계치·M/N 설정(단건·벌크). 값은 고객 리소스 태그 `Threshold_*`, `Threshold_*_Eval`로 저장. 이전 인라인 저장은 중앙 자격증명으로 알람만 쓰고 EC2만 태깅해 시간별 정합 런이 되돌렸음 |

## 새 구현에서 바꿀 점

1. (D-05) 29종 스펙 파일과 레지스트리 파생 구조, M-of-N 정책, Severity 표를 **그대로 이식**. 위 표를 이식 후 골든 테스트로 고정한다.
2. (D-08) 임계치 해석기에 "콘솔 개별값(알람 저장)" 층을 태그와 고객 기본값 사이에 추가. 현재의 "가상 태그 주입"(`customer_thresholds.apply`) 방식을 유지하면 출처 구분(`source_of`)이 흐려지므로, 층마다 출처를 돌려주는 해석기로 바꾸는 것을 권장(추정: 엔진 재설계 범위 최소화하려면 가상 태그 방식에 층 하나 더 끼우는 것도 가능).
3. (D-08) 콘솔이 고객 리소스에 `Threshold_*`를 쓰는 경로 제거(`backend/api_handler/routes/resource_thresholds.py:224-233` `_write_tags`).
4. 환경 변수 기본값 층 처리 결정.
5. `FreeableMemory` 퍼센트 경로가 GB 태그를 무시하는 동작(5절 3) 확인 후 유지 여부 결정.
6. WebSocket 지표 등 `_DEFAULT_SEVERITY` 누락 지표 점검(SEV-5 폴백).
7. `docs/ALARM-RULES.md` §13-3(리소스/고객별 등급 오버라이드)은 미구현 — 새 구현 범위에 넣을지 결정.
