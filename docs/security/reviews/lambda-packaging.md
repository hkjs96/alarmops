# 보안 검토 기록: feat/lambda-packaging (Lambda 진입점·패키징, #47)

대상: 커밋 `574fa6f`와 이를 고친 후속 커밋. 차단 없음. 항목별 반영/보류.

| 항목 | 내용 | 처리 | 근거 |
|---|---|---|---|
| 1 | 로그에 오류 문장이 그대로 남음(`consumer.ts`, `eventbridge.ts`의 `String(err)`, 엔진 `logger.exception`). 드라이버 오류에는 DB 호스트·사용자·연결 문자열이 들어갈 수 있다 | 반영 | 수집: `safeError()`가 `{ name, code }`만 남긴다(`code`는 SQLSTATE·errno처럼 짧은 영숫자일 때만). 엔진: `handler.safe_error()`가 "예외 타입 + `sqlstate`/AWS 오류 코드"만 로그에 쓰고 traceback은 `ALARMOPS_DEBUG_TRACEBACK=1`일 때만(기본 꺼짐, 로컬 디버깅용). 테스트: ingest `safeError`·소비자 로그, 엔진 `test_logs_carry_type_and_code_only`(비밀·호스트·`Traceback` 없음) |
| 2 | DB 연결 TLS 강제 | 반영 | Lambda(`AWS_LAMBDA_FUNCTION_NAME`)에서 연결 문자열의 `sslmode`가 `require`·`verify-ca`·`verify-full`이 아니면(없음, `disable`, `allow`, `prefer`) 시작을 거부한다. 수집은 `dbOptions.ts`(`ssl: { rejectUnauthorized: true }`, 거부 메시지에 URL 없음), 엔진은 `pg_repository.require_tls_in_lambda`. 로컬 실행에는 강제하지 않는다. DB의 CA가 Node 신뢰 저장소에 없으면 URL에 `sslrootcert=`로 번들 안 파일을 지정한다(README·GO-LIVE 9단계에 적음. 9단계는 `?sslmode=require`가 붙은 맨 문자열). 테스트: 수집 3개, 엔진 `test_tls_required_in_lambda_only` |
| 3 | 의존성 해시 고정 | 반영 | `requirements-lambda.txt`의 `psycopg==3.2.13`, `psycopg-binary==3.2.13`(cp312 manylinux aarch64·x86_64 두 wheel), `typing-extensions==4.12.2`에 `--hash=sha256:`. 해시는 PyPI JSON API(`/pypi/<이름>/<버전>/json`)에서 가져왔다. `build_lambda.py`는 `--require-hashes --no-deps --only-binary=:all:`. 검증: arm64와 `ALARMOPS_LAMBDA_ARCH=x86_64` 빌드 모두 성공, `check_lambda.py` 통과. 테스트가 모든 항목에 해시가 있고 스크립트가 `--require-hashes`를 쓰는지 본다 |
| 4 | Lambda에서 `DATABASE_URL` 대체 허용 | 반영 | `wiring.resolve_database_url`이 `AWS_LAMBDA_FUNCTION_NAME`이 있고 ARN이 없으면 `DATABASE_URL`을 받지 않고 거부한다. 테스트 `test_lambda_refuses_plain_database_url` |
| 참고 6 | 풀러 모드 | 반영 | URL 포트 6543 또는 `DATABASE_POOLER=transaction`이면 `pgClient({ pooler: 'transaction' })`(시작 `options` 미전송). 테스트 `dbConnOptions` |
| 참고(psycopg 버전) | 테스트는 3.3.8, 산출물은 3.2.13 | 반영 | `requirements-dev.txt`를 3.2.13으로 맞춰 CI가 산출물과 같은 버전으로 테스트한다(349 통과). 3.3.x로 올릴 때는 `requirements-lambda.txt`의 해시와 함께 올린다 |

## 남은 위험

- 해시는 wheel 파일 기준이다. PyPI 자체가 오염된 뒤 처음 받는 경우는 막지 못한다(해시를 사람이 검토한 diff로만 바꾼다).
- `sslmode=require`는 libpq 의미(암호화만, 서버 신원 검증은 `verify-*`)와 node-postgres의 동작(항상 검증)이 다르다. 수집은 `rejectUnauthorized: true`로 검증하므로 Supabase CA가 신뢰 저장소에 없으면 연결이 실패한다. 그 경우 `sslrootcert`를 번들에 넣어야 하고, 이는 실제 DB로 확인하지 못했다(실 DB 접속 시험 없음).
- 엔진의 `sslmode=require`는 psycopg(libpq)에서 서버 인증서 검증 없이 암호화만 한다. 검증이 필요하면 `verify-full`과 `sslrootcert`를 쓴다.
- 웹훅 속도 제한은 컨테이너별이다(이전과 같음).
