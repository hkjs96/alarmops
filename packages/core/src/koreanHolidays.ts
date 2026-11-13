/**
 * Korean public holidays (KST dates, 'YYYY-MM-DD') for the business-hours rule of D-46, including substitute holidays.
 *
 * TODO(D-46 follow-up): hard-coded for 2026-2027 by hand and NOT verified against the official calendar. Source it from
 * the special-day API of data.go.kr (특일 정보) or the MSP's own calendar, and warn (health) when `now` is past the last
 * year listed: after 2027-12-31 every weekday counts as a business day, so a digest would go out on a holiday.
 * Also confirm 2026-05-01 (Labour Day) with the MSP: it is listed because the company observes it.
 */
export const KOREAN_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18', // Seollal
  '2026-03-01', '2026-03-02', // Independence Movement Day (Sunday) + substitute
  '2026-05-01',
  '2026-05-05',
  '2026-05-24', '2026-05-25', // Buddha's Birthday (Sunday) + substitute
  '2026-06-03', // local election day
  '2026-06-06', // Memorial Day (Saturday)
  '2026-08-15', '2026-08-17', // Liberation Day (Saturday) + substitute
  '2026-09-24', '2026-09-25', '2026-09-26', // Chuseok
  '2026-10-03', '2026-10-05', // National Foundation Day (Saturday) + substitute
  '2026-10-09', // Hangul Day
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', // Seollal (Sat, Sun, Mon) + substitute
  '2027-03-01',
  '2027-05-05',
  '2027-05-13', // Buddha's Birthday
  '2027-06-06', // Memorial Day (Sunday)
  '2027-08-15', '2027-08-16', // Liberation Day (Sunday) + substitute
  '2027-09-14', '2027-09-15', '2027-09-16', // Chuseok
  '2027-10-03', '2027-10-04', // National Foundation Day (Sunday) + substitute
  '2027-10-09', '2027-10-11', // Hangul Day (Saturday) + substitute
  '2027-12-25',
]);
/** Last year the list covers. */
export const HOLIDAYS_COVER_UNTIL_YEAR = 2027;
