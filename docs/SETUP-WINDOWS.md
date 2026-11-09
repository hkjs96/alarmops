# 회사 Windows PC 설정

모든 개발은 이 PC에서 한다. 자리를 비울 때는 휴대폰에서 원격 제어로 지시·승인한다.

## 0. 사내 정책 먼저 확인 (설치 전에)
- 개발 도구 설치 권한, 개인/회사 Claude 계정 사용 가능 여부
- Tailscale·SSH 서버 같은 원격 접속 도구는 설치하지 않는다(원격 제어는 아웃바운드 443만 씀)
- Docker Desktop은 회사 규모에 따라 유료 라이선스가 필요하다. 이 계획은 Docker 없이 진행한다(DB는 Supabase 개발 프로젝트 사용)

## 1. 도구 설치 (winget 예시)
```powershell
winget install Git.Git            # Git Bash 포함. Claude Code의 Bash 도구가 이걸 씀
winget install OpenJS.NodeJS.LTS
winget install GitHub.cli
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
winget install Python.Python.3.12 # 알람 엔진(Python Lambda) 이식용
npm install -g @anthropic-ai/claude-code
```

## 2. 사내 프록시
TLS 검사 프록시가 있으면 회사 루트 인증서를 Node가 믿게 해야 한다.
```powershell
setx HTTPS_PROXY "http://proxy.company:8080"   # 사내 값으로
setx NODE_EXTRA_CA_CERTS "C:\certs\company-root.pem"
```
그래도 `claude` 로그인이나 원격 제어가 안 되면 IT에 `*.anthropic.com`, `claude.ai` 예외를 요청한다. 원격 제어가 끝내 안 되면 PC 앞에서 직접 작업한다(계획 영향 없음).

## 3. 잠자기
- 설정 > 시스템 > 전원에서 "화면 끄기"만 두고 "절전 모드"는 "안 함"으로 둔다.
- 그룹 정책으로 막혀 있으면 PC가 켜진 시간에만 작업이 돈다. 예약 작업(밤 QA, 아침 보고)은 그 경우 출근 후 수동으로 돌린다.

## 4. 계정과 자격증명
```powershell
gh auth login
aws configure --profile dev       # 개발 계정만. 기본 리전 ap-northeast-2
```
- 운영 계정과 실고객 SSO 프로필은 에이전트가 쓰는 세션에서 쓰지 않는다. 가드가 `prod`, `cust-`로 시작하는 프로필을 막는다(이름 규칙을 맞출 것).
- 실고객 작업은 별도 PowerShell 창에서 사람이 `aws sso login`으로 하고, 그 창에서는 에이전트를 돌리지 않는다.
- `.env`에는 개발용 값만 둔다. 가드가 에이전트의 `.env` 읽기를 막는다.

## 5. 저장소
```powershell
cd C:\work
gh repo create alarmops --private --clone
# 이 키트의 파일을 복사한 뒤
git add . ; git commit -m "chore: bootstrap repo and agent harness" ; git push -u origin main
# 기존 저장소(읽기 전용 참고용)
mkdir legacy ; cd legacy
git clone https://github.com/hkjs96/aws-alert-manager
git clone https://github.com/hkjs96/alert-hub
```

## 6. 가드가 동작하는지 확인
```bash
# Git Bash에서
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | node .claude/hooks/guard.mjs; echo $?
# 2가 나오면 정상 차단
```
가드 설정은 저장소 안(`.claude/settings.json`)에 있다. 에이전트가 고치지 못하게 가드가 막지만, 안전하게 하려면 같은 hooks 블록을 사용자 설정(`%USERPROFILE%\.claude\settings.json`)에도 복사해 둔다.

## 7. 허브 세션 시작
```powershell
cd C:\work\alarmops
claude
```
세션 안에서 `/remote-control`을 실행하면 휴대폰 Claude 앱에서 이 세션에 붙을 수 있다. PC가 잠들거나 네트워크가 끊겨 오래 오프라인이면 세션이 끝나므로, 돌아와서 다시 시작한다.

## 8. 1주차 Go/No-Go
- [ ] 사내 프록시에서 `claude` 로그인과 원격 제어 동작
- [ ] Claude 계정 종류(개인/회사 조직)와 요금제 확정
- [ ] 에이전트 2개 병렬로 하루 사용량 실측
- [ ] Supabase(서울) Pro와 PITR 요금을 공식 요금표로 확인
- [ ] 발신번호 사전등록 신청
