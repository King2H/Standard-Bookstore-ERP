// Reads a CSV file as a spreadsheet saves it (#246): RFC 4180 quoting, cells
// over several lines, a byte-order mark, and the delimiter of the header line
// (a comma, or a semicolon where Excel uses the comma for decimals).

export interface CsvLine {
  /** The line in the file where the row starts, the header being line 1. */
  line: number;
  cells: string[];
}

export interface CsvFile {
  delimiter: ',' | ';';
  header: string[];
  rows: CsvLine[];
}

function delimiterOf(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

export function readCsv(input: string): CsvFile {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(text);
  const records: CsvLine[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ line: start, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line += 1; cell += ch; }
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      start = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length > 0) endRecord();
  const [head, ...rows] = records;
  return { delimiter, header: (head?.cells ?? []).map((h) => h.trim()), rows };
}

/**
 * A cell as written: an export writes a cell a spreadsheet would run as a
 * formula with a leading apostrophe (csvBuilder.ts); that apostrophe goes.
 */
export function cellText(raw: string): string {
  const text = raw.trim();
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}
