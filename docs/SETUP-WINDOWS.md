# 회사 Windows PC 설정

이 문서는 회사 Windows PC에 개발 환경을 처음 갖추는 사람을 위한 순서다. 끝까지 하면 이 PC에서 허브 세션이 돌고, 휴대폰에서 원격으로 지시·승인할 수 있다.

- 모든 개발은 이 PC에서 한다.
- 자리를 비울 때는 휴대폰에서 원격 제어로 지시·승인한다.

## 목차

0. [사내 정책 먼저 확인](#0-사내-정책-먼저-확인-설치-전에)
1. [도구 설치](#1-도구-설치-winget-예시)
2. [사내 프록시](#2-사내-프록시)
3. [잠자기](#3-잠자기)
4. [계정과 자격증명](#4-계정과-자격증명)
5. [저장소](#5-저장소)
6. [가드가 동작하는지 확인](#6-가드가-동작하는지-확인)
7. [허브 세션 시작](#7-허브-세션-시작)
8. [1주차 Go/No-Go](#8-1주차-gono-go)

## 0. 사내 정책 먼저 확인 (설치 전에)

- 개발 도구 설치 권한, 개인/회사 Claude 계정 사용 가능 여부를 확인한다.
- Tailscale·SSH 서버 같은 원격 접속 도구는 설치하지 않는다. 원격 제어는 아웃바운드 443만 쓴다.
- Docker Desktop은 회사 규모에 따라 유료 라이선스가 필요하다. 이 계획은 Docker 없이 진행한다. DB는 Supabase 개발 프로젝트를 쓴다.

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

언제: TLS 검사 프록시가 있을 때. 회사 루트 인증서를 Node가 믿게 해야 한다.

1. 프록시와 인증서를 설정한다.
   ```powershell
   setx HTTPS_PROXY "http://proxy.company:8080"   # 사내 값으로
   setx NODE_EXTRA_CA_CERTS "C:\certs\company-root.pem"
   ```
2. 그래도 `claude` 로그인이나 원격 제어가 안 되면 IT에 `*.anthropic.com`, `claude.ai` 예외를 요청한다.

> **참고** 원격 제어가 끝내 안 되면 PC 앞에서 직접 작업한다(계획 영향 없음).

## 3. 잠자기

1. 전원 설정을 바꾼다.
   - 어디서: 설정 > 시스템 > 전원
   - 값: "화면 끄기"만 두고 "절전 모드"는 "안 함"

> **참고** 그룹 정책으로 막혀 있으면 PC가 켜진 시간에만 작업이 돈다. 그 경우 예약 작업(밤 QA, 아침 보고)은 출근 후 수동으로 돌린다.

## 4. 계정과 자격증명

```powershell
gh auth login
aws configure --profile dev       # 개발 계정만. 기본 리전 ap-northeast-2
```

### 4-1. 개발 AWS 계정을 회사 SSO로 `dev` 프로필에 등록하기

`aws sts get-caller-identity --profile dev`가 `The config profile (dev) could not be found`이면 아직 등록하지 않은 것이다. 회사 계정은 액세스 키가 아니라 SSO로 등록한다. 이 절차는 사람이 직접 한다.

1. **어디서:** 회사 PC의 PowerShell.
   **입력할 것:**
   ```powershell
   aws configure sso --profile dev
   ```
2. 질문에 답한다.

   | 질문 | 입력 |
   |---|---|
   | SSO session name | 아무 이름(예: `mz`) |
   | SSO start URL | 회사 AWS SSO 포털 주소(`https://d-…awsapps.com/start`). 끝의 `/#/`는 뺀다. 주소는 팀에서 받는다(저장소에 적지 않는다) |
   | SSO region | 회사 SSO가 있는 리전. 모르면 `ap-northeast-2`로 해 보고 오류면 `us-east-1` |
   | SSO registration scopes | Enter |

3. 브라우저가 열리면 회사 계정으로 로그인하고 **Allow**를 누른다.
4. 터미널에 계정 목록이 나오면 **시험용(샌드박스·PoC) 계정만** 고른다.

   > **주의** MSP라서 목록에 실고객 계정이 섞여 있을 수 있다. 이름으로 판단이 안 되면 고르지 말고 허브에 이름만 알린다(계정 번호는 빼고). 시험용 계정이 없으면 클라우드 담당자에게 PoC용 샌드박스를 요청한다.

5. 역할은 관리자 권한(예: `AdministratorAccess`), **CLI default client Region**은 `ap-northeast-2`, output format은 Enter.
6. **확인:**
   ```powershell
   aws sts get-caller-identity --profile dev
   ```
   `Account`가 고른 시험용 계정 번호다.
7. 세션은 몇 시간 뒤 만료된다. 그때는 `aws sso login --profile dev`로 다시 로그인한다.

> **주의** 프로필 이름은 정확히 `dev`. `prod`, `cust-`로 시작하는 이름은 가드가 막는다.

> **주의** 운영 계정과 실고객 SSO 프로필은 에이전트가 쓰는 세션에서 쓰지 않는다. 가드가 `prod`, `cust-`로 시작하는 프로필을 막는다(이름 규칙을 맞출 것).

> **주의** 실고객 작업은 별도 PowerShell 창에서 사람이 `aws sso login`으로 한다. 그 창에서는 에이전트를 돌리지 않는다.

> **주의** `.env`에는 개발용 값만 둔다. 가드가 에이전트의 `.env` 읽기를 막는다.

## 5. 저장소

> **참고** 이미 만들어진 저장소를 회사 PC에 받아 `.env`를 채우고 실제 DB로 콘솔을 띄우는 순서는 `docs/GO-LIVE.md`의 2-2·2-3에 있다. 아래는 저장소를 처음 만들 때의 기록이다.

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

1. Git Bash에서 실행한다.
   ```bash
   # Git Bash에서
   echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | node .claude/hooks/guard.mjs; echo $?
   # 2가 나오면 정상 차단
   ```
   - 확인: `2`가 나오면 정상 차단이다.
2. 같은 hooks 블록을 사용자 설정(`%USERPROFILE%\.claude\settings.json`)에도 복사해 둔다.

> **참고** 가드 설정은 저장소 안(`.claude/settings.json`)에 있다. 에이전트가 고치지 못하게 가드가 막지만, 안전하게 하려면 2번처럼 사용자 설정에도 둔다.

## 7. 허브 세션 시작

1. 세션을 시작한다.
   ```powershell
   cd C:\work\alarmops
   claude
   ```
2. 세션 안에서 `/remote-control`을 실행한다. 그러면 휴대폰 Claude 앱에서 이 세션에 붙을 수 있다.

> **참고** PC가 잠들거나 네트워크가 끊겨 오래 오프라인이면 세션이 끝난다. 돌아와서 다시 시작한다.

## 8. 1주차 Go/No-Go

- [ ] 사내 프록시에서 `claude` 로그인과 원격 제어 동작
- [ ] Claude 계정 종류(개인/회사 조직)와 요금제 확정
- [ ] 에이전트 2개 병렬로 하루 사용량 실측
- [ ] Supabase(서울) Pro와 PITR 요금을 공식 요금표로 확인
- [ ] 발신번호 사전등록 신청
