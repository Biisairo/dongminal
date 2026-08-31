set -e
rm -rf /tmp/dm-demo/notes-app && mkdir -p /tmp/dm-demo/notes-app
cd /tmp/dm-demo/notes-app
git init -q -b main
git config user.email demo@example.com; git config user.name Demo
printf 'export function add(a, b) {\n  return a + b\n}\n' > math.js
printf '# notes-app\n\n간단한 메모 앱.\n' > README.md
git add -A && git commit -qm "첫 커밋 — 메모 앱 뼈대"
printf 'export function add(a, b) {\n  return a + b\n}\n\nexport function mul(a, b) {\n  return a * b\n}\n' > math.js
printf 'body { margin: 0 }\n' > style.css
git add math.js && git commit -qm "math: 곱셈을 더한다"
printf 'export const VERSION = "0.2.0"\n' > version.js
