#!/usr/bin/env node
// PreToolUse 가드. Windows(Git Bash)와 macOS/Linux 모두에서 동작하도록 Node로 작성.
// 종료 코드 2 = 차단(stderr가 Claude에게 전달됨), 0 = 허용.
// 입력을 해석하지 못하면 통과시키지 않고 차단한다(fail-closed).

const PROD = /(prod|production|운영)/i; // 운영 AWS 프로필·계정 별칭에 맞게 수정
const CUSTOMER = /(cust-|customer-)/i;  // 실고객 SSO 프로필 접두어에 맞게 수정

function block(msg) {
  process.stderr.write(`[guard] 차단: ${msg}\n`);
  process.exit(2);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    block("가드가 입력을 해석하지 못했습니다(안전을 위해 차단).");
  }
  const tool = data.tool_name || "";
  const input = data.tool_input || {};

  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(input.command || "");
    const rules = [
      [/git\s+push\b[^\n]*\b(main|master)\b/i, "main/master 직접 푸시 금지. agent/ 브랜치에 푸시하고 PR을 만드세요."],
      [/git\s+push\b[^\n]*(\s--force\b|\s-f\b)(?!-with-lease)/i, "강제 푸시 금지."],
      [/git\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, "작업 내용을 지우는 git 명령 금지."],
      [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|[a-z]:[\\\/]?)(\s|$)/i, "루트·홈·드라이브 삭제 금지."],
      [/Remove-Item[^\n]*-Recurse[^\n]*(\s[a-z]:\\?(\s|$)|\$HOME|~)/i, "드라이브·홈 재귀 삭제 금지."],
      [new RegExp(`(--profile[\\s=]+\\S*${PROD.source}|AWS_PROFILE=\\S*${PROD.source})`, "i"), "운영 AWS 프로필 사용 금지. 개발 계정만 사용하세요."],
      [new RegExp(`(--profile[\\s=]+\\S*${CUSTOMER.source}|AWS_PROFILE=\\S*${CUSTOMER.source})`, "i"), "실고객 프로필은 에이전트가 쓰지 않습니다. 사람이 별도 터미널에서 작업하세요."],
      [/\b(sam|cdk|terraform)\s+(deploy|apply|destroy)\b/i, "에이전트는 배포하지 않습니다. GitHub Actions로 배포하세요."],
      [/prisma\s+db\s+push\b/i, "db push 금지. prisma migrate dev / migrate deploy를 쓰세요."],
      [/(^|[\s"'\/\\=<>|;])\.env(?!\.example)(\.[\w-]+)?(?=$|[\s"'<>|;])/i, "환경변수 파일 접근 금지(.env.example만 허용)."],
      [/\.aws[\\\/](credentials|sso[\\\/]cache)/i, "AWS 자격증명·SSO 캐시 접근 금지."],
      [/\b(aws\s+sso\s+login|aws\s+configure\s+export-credentials)\b/i, "SSO 로그인과 자격증명 내보내기는 사람이 직접 합니다."],
    ];
    for (const [re, msg] of rules) if (re.test(cmd)) block(msg);
  }

  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob"].includes(tool)) {
    const p = String(input.file_path || input.path || input.pattern || input.glob || "").replace(/\\/g, "/");
    if (/(^|\/)\.env(\.[^/]*)?$/.test(p) && !p.endsWith(".env.example")) block("환경변수 파일 접근 금지(.env.example만 허용).");
    if (/\.aws\/(credentials|sso\/cache)|id_rsa|\.pem$|\.pfx$/.test(p)) block("자격증명·키 파일 접근 금지.");
    if (/(^|\/)\.claude\/(settings[^/]*\.json|hooks\/)/.test(p) && ["Edit", "Write", "MultiEdit"].includes(tool)) block("가드 설정은 사람이 직접 고칩니다.");
  }

  process.exit(0);
});
