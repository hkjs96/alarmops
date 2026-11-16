# 보안 검토 기록 — 배포 워크플로 (deploy-central 빌드 단계, deploy-console)

대상: 커밋 4c03bb6(`deploy-central.yml` 빌드·산출물 검증, `deploy-console.yml`, `smoke-console.mjs`)에 대한 security 검토와 이를 반영한 후속 커밋.
결과: [차단] 1건 반영, [권고] 반영·보류는 아래 표. 마지막 확인은 security 재검토.

## 항목별 처리

| # | 등급 | 지적 | 처리 | 내용 |
|---|---|---|---|---|
| B1 | 차단 | 워크플로 수준 `id-token: write`라서 `plan` 작업 안의 npm·pip·esbuild·cfn-lint 코드가 중앙 배포 역할의 OIDC 토큰을 만들 수 있다 | **반영** | 워크플로 권한은 `contents: read`. 작업을 넷으로 나눴다. `build`(환경 없음, `id-token` 없음: npm·pip 빌드, 번들 직후 매니페스트, 아티팩트 `central-code` 업로드, 체크섬을 작업 출력으로), `checks`(`id-token` 없음: cfn-lint, 구조 테스트), `plan`(환경 `central`, `id-token: write`, **npm·pip 없음**: 아티팩트 다운로드 → 체크섬·파일별 해시·정규 파일 검증 → 그다음에야 `configure-aws-credentials` → 변경 세트), `apply`(같은 순서). `plan`이 검증한 번들을 템플릿 `CodeUri` 위치에 복사하고 한 번 더 검증한 뒤 `sam deploy`. 구조 테스트가 작업별 권한, 다운로드가 자격 증명보다 앞인지, `plan`·`apply`에 npm·pip·setup-* 없음을 확인한다. |
| R2 | 권고 | apply의 아티팩트 다운로드가 자격 증명 뒤에 있으면 다운로드 코드가 역할 토큰을 본다 | **반영** | `apply`도 다운로드와 매니페스트 체크섬 확인을 `configure-aws-credentials` 앞에 둔다(S3 zip 검증만 자격 증명 뒤, AWS가 필요해서). |
| R3 | 권고 | `npx vercel@<버전>`은 락파일·무결성 확인이 없고 토큰 인자(`--token`)가 명령행에 남는다 | **반영** | `tools/vercel-cli/package.json`(정확한 버전 65.16.0)과 커밋된 `package-lock.json`(무결성 해시)을 두고, 토큰 없는 단계에서 `npm ci --ignore-scripts --prefix tools/vercel-cli`. 실행은 `tools/vercel-cli/node_modules/.bin/vercel`. `--token` 인자 삭제, `VERCEL_TOKEN`은 환경변수로만, `pull`·`deploy`(와 존재 확인) 단계에만 준다. 설치 스크립트를 켜지 않고도 `vercel --version`이 동작함을 확인했다(락파일의 `hasInstallScript`는 esbuild·fsevents 둘뿐이고 선택적 바이너리는 optionalDependencies로 받는다). `vercel build`가 esbuild를 직접 쓰는 경로는 첫 실행에서 확인해야 한다. 막히면 스크립트를 켜지 말고 보고한다. |
| R4 | 권고 | `vercel build`(저장소·npm 코드)가 `DATABASE_URL`·`SESSION_SECRET`·`TICK_SECRET`·`VERCEL_OIDC_TOKEN`이 든 파일을 읽을 수 있다 | **반영(잔여 위험 문서화)** | 콘솔은 이 비밀 없이 `next build`가 된다(CI `test` 작업이 변수 없이 빌드). 그래서 env 검사 직후 `strip-deploy-env.mjs`가 파일을 `CONSOLE_ORIGIN`·`TRUSTED_PROXY`·`NEXT_PUBLIC_*`만 남기도록 다시 쓴다(테스트 있음, 이름만 출력). 빌드 단계에는 토큰도 없다. 런타임 값은 Vercel 프로젝트가 따로 갖고 있다. 잔여: pull~제거 사이에는 저장소의 검증된 스크립트만 돈다는 규칙에 의존한다(`docs/GO-LIVE.md` 3단계에 적음). |
| R5 | 권고 | `uses:`를 커밋 SHA로 고정 | **반영(범위 한정)** | `deploy-central.yml`·`deploy-console.yml`의 모든 `uses:`를 실제 태그의 커밋 SHA로 고정하고 태그를 주석으로 남겼다(`git ls-remote`로 확인: checkout v5.1.0, setup-node v5.0.0, setup-python v5.6.0, upload-artifact v4.6.2, download-artifact v4.3.0, configure-aws-credentials v5.1.1). `.github/dependabot.yml`로 갱신 제안(github-actions, `tools/vercel-cli` npm). 구조 테스트가 두 파일의 SHA 고정을 검사한다. |
| R6 | 권고 | apply가 S3 zip을 `unzip`으로 풀어 확인 | **반영** | `bundle_manifest.py check-zip`(표준 라이브러리, `python3 -I`)이 압축을 풀지 않고 항목별 sha256을 계산한다. 심볼릭 링크·특수 파일, 절대 경로·`..`, 데이터가 든 디렉터리 항목, 중복 경로는 실패. 매니페스트 형식(`sha256sum` 줄)은 그대로. 단위 테스트(`infra/test/test_bundle_manifest.py`). |
| N1 | 참고 | 변경 세트를 "가장 최근 AVAILABLE"로 고름 | **반영** | `sam deploy` 전에 기존 변경 세트 ID를 기록하고, 후에 새로 생긴 것만 쓴다(0개면 변경 없음, 2개 이상이면 실패). |
| N3 | 참고 | 배포 URL 검사가 느슨함 | **반영** | `^https://[A-Za-z0-9.-]+\.vercel\.app$` 정규식. |
| N4 | 참고 | 스모크 실패 때의 되돌리기 절차가 없음 | **반영** | `docs/GO-LIVE.md` 3단계 9번(`vercel rollback` 또는 이전 배포 Promote to Production, 확인 방법). |

## 보류·남은 위험

- **다른 워크플로의 SHA 고정**(`ci.yml`, `dev-db.yml`, `bus-allowlist.yml`)은 보류. 이 변경의 범위는 배포 워크플로 둘. Dependabot이 켜지면 그쪽도 같은 방식으로 옮긴다. (`dev-db.yml`은 비밀을 읽으므로 우선순위 높음.)
- **apply의 코드 검증은 실제 AWS에서만 확인 가능**: 처리된 템플릿의 `Code.S3Bucket/S3Key`와 SAM zip이 매니페스트 파일 목록과 정확히 같다는 가정. 어긋나면 안전하게 실패한다(거짓 불일치). 첫 실행은 사람이 지켜본다.
- **매니페스트는 파일 권한 비트를 담지 않는다.** 아티팩트 압축으로 권한이 단순해지므로 Lambda 실행에 실행 비트가 필요한 파일이 생기면 별도로 다룬다(현재 번들은 읽기만 필요).
- **npm 캐시(`setup-node` `cache: npm`)**: 캐시 키는 락파일 해시이고 브랜치 범위로 격리되지만, 캐시 오염 가능성은 이론상 남는다. `deploy-console`의 pull 이전 단계에서만 쓰이고 토큰은 없다.
- **`tools/vercel-cli` 락파일 갱신**은 Dependabot PR을 사람이 검토한다(설치 스크립트를 켜지 않는 것이 조건).
- **배포 역할 권한 추가 필요**: `cloudformation:GetTemplate`(스택)와 SAM 버킷 `s3:GetObject`. 정책은 사람이 만든다(`infra/aws/README.md`).
- **hash 고정 설치**: `infra/requirements-ci.txt`는 `uv pip compile --python-version 3.12 --generate-hashes`로 만든 실제 PyPI 해시. 갱신도 같은 방법으로 사람이 한다.
