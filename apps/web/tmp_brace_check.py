from pathlib import Path
text = Path('src/pages/POSPage.tsx').read_text(encoding='utf-8')
brace = 0
max_brace = 0
max_line = 0
line_num = 1
for line in text.splitlines():
    brace += line.count('{') - line.count('}')
    if brace > max_brace:
        max_brace = brace
        max_line = line_num
    line_num += 1
print('max brace count', max_brace, 'at line', max_line)
print('final brace count', brace)
