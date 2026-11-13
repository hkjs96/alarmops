// Computes the next AllowedAccountIds value of the central bus stack (infra/aws/central-bus.yaml).
//
//   CURRENT="111111111111,222222222222" ACTION=remove ACCOUNT_ID=222222222222 node .github/scripts/bus-allowlist.mjs
//
// Prints the new comma-separated list on stdout (possibly empty) and a summary on stderr. Exit 1 on bad input.
// `remove` of an account that is not in the list succeeds (idempotent: a re-run after a partial failure is fine).
// With PARAMS_FILE set it also writes the update-stack parameters JSON there.
// `add` of an account already in the list also succeeds.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9]{12}$/;

export function parseList(s) {
  const items = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const i of items) if (!ID.test(i)) throw new Error('the current allow list contains a value that is not a 12-digit account id');
  return items;
}

/** @returns {{ list: string, changed: boolean }} */
export function nextAllowlist(current, action, accountId) {
  if (action !== 'add' && action !== 'remove') throw new Error('ACTION must be add or remove');
  if (!ID.test(accountId ?? '')) throw new Error('ACCOUNT_ID must be exactly 12 digits');
  const cur = parseList(current);
  const has = cur.includes(accountId);
  const next = action === 'add' ? (has ? cur : [...cur, accountId]) : cur.filter((x) => x !== accountId);
  return { list: [...new Set(next)].sort().join(','), changed: next.length !== cur.length };
}

/** `aws cloudformation update-stack --parameters file://...` content. The CLI shorthand cannot carry commas in a value. */
export function updateParameters(list) {
  return [
    { ParameterKey: 'AllowedAccountIds', ParameterValue: list },
    { ParameterKey: 'BusName', UsePreviousValue: true },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { list, changed } = nextAllowlist(process.env.CURRENT, process.env.ACTION, process.env.ACCOUNT_ID);
    console.error(`allow list: ${changed ? 'changed' : 'unchanged'}, ${list ? list.split(',').length : 0} account(s) after`);
    if (process.env.PARAMS_FILE) writeFileSync(process.env.PARAMS_FILE, JSON.stringify(updateParameters(list)));
    process.stdout.write(list);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
