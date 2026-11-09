# Contacts · channel verification — D-29, D-31 개정

별도 Contacts 화면은 없어졌다. 연락처는 두 곳에서 관리한다.
- **MSP 직원** → On-call › People (`oncall-people.md`): 채널 칩, 담당 고객, 당번.
- **고객 사람** → Customer › Responders & paging (`customer-responders.md`): 역할 **Pageable**(전화·문자, 단계·로테이션 지정 가능) / **Notify only**(상태 메일만) + **Auto-fix approver** / **Portal**. 구 D-29의 "고객 담당자는 알림만, 로테이션 불가"는 대체됨.

## Needs action 정의 (모든 화면 공통)
- 사람 단위: 확인 안 된 채널(not verified · link sent · link expired · not set)이 **하나라도 있는 사람**.
- **not set**은 링크로 못 고침 → "Ask to add <채널>". 일괄 링크 수에서 제외.
- Pageable 고객 사람은 Voice·SMS가 확인 대상에 포함된다(호출되므로).

## Needs action 화면 (`/oncall/people/needs-action`)
- 직원·고객 통합, 칩 All/Staff/Customer, 채널·고객 필터, 검색, 일괄 선택(Send links / Ask to add).
- 직원 행 → People 상세, 고객 행 → 그 고객 Responders & paging.
- 진입: People "Channels needing action", Customers 목록 카드.

## 안내
"Unverified channels still receive pages."(Q-DM-16 결정 전)
