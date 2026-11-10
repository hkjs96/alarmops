# Contacts · channel verification — D-29, D-31 개정

별도 Contacts 화면은 없어졌다. 연락처는 두 곳에서 관리한다.
- **(D-29 개정 11/10)** 직원과 고객 사람은 **People 표 하나**(`oncall-people.md`)에 있고 `Kind` 열로 구분한다. 아래 두 줄의 "두 곳"은 옛 구성이다.
- **MSP 직원** → People: 채널 칩, 담당 고객, 당번.
- **고객 사람** → People(트리에서 그 고객을 고른다): 역할 **Pageable**(전화·문자, 단계·로테이션 지정 가능) / **Notify only**(상태 메일만) + **Auto-fix approver** / **Portal**. 구 D-29의 "고객 담당자는 알림만, 로테이션 불가"는 대체됨.


## 셸·범위 (D-33, `shell-scope.md`)
- 트리 필터: Needs action 목록에도 적용된다(고객·프로젝트·서비스). 기본 All customers.
- 연락처 값은 가린 채로 보인다. 전체 값 열람은 D-35(그 고객의 Responder만, 기록).
- 일괄 Send links는 여러 고객에 닿을 수 있다 → 보내기 전 대상 수와 고객 목록을 보여 준다.

## Needs action 정의 (모든 화면 공통)
- 사람 단위: 확인 안 된 채널(not verified · link sent · link expired · not set)이 **하나라도 있는 사람**.
- **not set**은 링크로 못 고침 → "Ask to add <채널>". 일괄 링크 수에서 제외.
- Pageable 고객 사람은 Voice·SMS가 확인 대상에 포함된다(호출되므로).

## Needs action 화면 (`/people/needs-action`)
- 직원·고객 통합, 칩 All/Staff/Customer, 채널·고객 필터, 검색, 일괄 선택(Send links / Ask to add).
- 직원 행·고객 행 모두 사람 패널(읽기 화면)을 연다.
- 진입: People "Channels needing action", Customers 목록 카드.

## 안내
"Unverified channels still receive pages."(Q-DM-16 결정 전)
