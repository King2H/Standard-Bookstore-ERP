from pathlib import Path
text = Path('src/pages/POSPage.tsx').read_text(encoding='utf-8')
brace = 0
lines = text.splitlines()
for i, line in enumerate(lines, start=1):
    brace += line.count('{') - line.count('}')
    if 350 <= i <= 420:
        print(f'{i}: {brace} {line}')
print('final', brace)
