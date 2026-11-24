// PreToolUse hook for read-only reviewer subagents (verifier, pr-auditor). D-60.
// The agent files say "do not modify files", but a prompt is advice; this hook enforces it.
// Usage (agent frontmatter):  node "$CLAUDE_PROJECT_DIR/.claude/hooks/readonly-bash.mjs" <profile>
//   audit   git read commands and plain inspection only (pr-auditor)
//   verify  audit + install, build, test and local run commands (verifier); still no git writes, no file writes
// Exit 2 blocks the call; stderr is shown to the agent.
import { readFileSync } from 'node:fs';

const profile = process.argv[2] || 'audit';
let cmd = '';
try { cmd = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? ''; } catch { block('hook input unreadable'); }

function block(why) { process.stderr.write(`[readonly-bash:${profile}] blocked: ${why}\n`); process.exit(2); }

// Anything that writes files or changes state outside the checkout is refused in every profile.
const DENY = [
  /(^|[^<>&0-9])>{1,2}\s*[^&\s]/,                 // redirection into a file (2>&1 is allowed)
  /\btee\b/, /\b(rm|mv|cp|chmod|chown|ln|truncate|dd)\b/, /\bsed\b[^|]*\s-i\b/, /\bperl\b[^|]*\s-i\b/,
  /\bgit\s+(push|commit|reset|rebase|merge|cherry-pick|revert|tag|branch\s+-[dDmM]|stash|clean|restore|am|apply|config)\b/,
  /\bgh\s+(pr|issue|release|repo|workflow|api)\b/, /\b(aws|sam|vercel|terraform|kubectl)\b/,
  /\bprisma\s+(db|migrate)\b/, /\bcurl\b[^|]*\s-(X|d|F|T)\b/, /\b(npm|pnpm|yarn)\s+(publish|version)\b/,
  /\.env\b/, /~\/\.aws|\$HOME\/\.aws/,
];
for (const re of DENY) if (re.test(cmd)) block(`matches ${re}`);

// Each segment of a compound command must start with an allowed program.
const AUDIT = /^(git\s+(fetch|log|show|diff|status|rev-parse|ls-files|ls-tree|cat-file|merge-base|branch(\s+--?(list|show-current|a|r|v))*|checkout\s+--detach)\b|cat|head|tail|wc|ls|grep|rg|find|sort|uniq|cut|awk|jq|echo|printf|pwd|test|\[)\b/;
const VERIFY = /^(npm\s+(ci|test|run|exec)|npx|node|pnpm\s+(i|install|test|run)|python3?|pytest|pip\s+install|cfn-lint|sam\s+validate|curl|sleep|timeout|kill|docker\s+(compose\s+)?(up|run|ps|logs|exec)|psql)\b/;
const allowed = profile === 'verify' ? [AUDIT, VERIFY] : [AUDIT];

for (const seg of cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim().replace(/^\(+|\)+$/g, '').replace(/^(\w+=\S*\s+)+/, ''))) {
  if (!seg) continue;
  if (!allowed.some((re) => re.test(seg))) block(`"${seg.slice(0, 60)}" is not on the ${profile} list`);
}
process.exit(0);
