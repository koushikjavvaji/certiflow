import { parse } from "csv-parse/sync";

import { Handler, chainOf } from "./chain";

export const MAX_ROWS = 2000;

export interface ParsedCandidate {
  row: number; // spreadsheet row number (header is row 1)
  name: string;
  phone: string; // normalised +91XXXXXXXXXX
  courseCode: string;
  marks: number | null;
}

export interface RowError {
  row: number; // 0 = the file as a whole / its header
  field?: string;
  message: string;
}

// Accept 9876543210, 919876543210, +91 98765 43210, 098765-43210 ... and store one format.
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  const national = digits.replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

// ============ ONE SPREADSHEET ROW travels down a chain of checks ============
// Each handler checks ONE thing and notes any problem on the row, but always passes the row
// on, so a row with two problems reports both and the whole sheet reports every problem at
// once. Only the last handler accepts the row, and only if nothing was wrong with it.
interface RowContext {
  row: number;
  raw: Record<string, string | undefined>;
  seen: Map<string, number>; // "course|phone" -> the first row it appeared on (to spot duplicates)
  errors: RowError[]; // shared by every row of the sheet
  accepted: ParsedCandidate[]; // shared by every row of the sheet
  problems: number; // how many problems THIS row has
  name?: string;
  phone?: string;
  courseCode?: string;
  marks?: number | null;
}

function problem(c: RowContext, field: string, message: string) {
  c.errors.push({ row: c.row, field, message });
  c.problems++;
}

class CheckName extends Handler<RowContext> {
  protected process(c: RowContext) {
    const name = (c.raw.name ?? "").trim();
    if (name.length < 2) problem(c, "name", "name must be at least 2 characters");
    else if (name.length > 100) problem(c, "name", "name is too long");
    else c.name = name;
    return false;
  }
}

class CheckPhone extends Handler<RowContext> {
  protected process(c: RowContext) {
    const raw = (c.raw.phone ?? "").trim();
    const phone = raw ? normalisePhone(raw) : null;
    if (!raw) problem(c, "phone", "phone is required");
    else if (!phone) problem(c, "phone", "phone must be a valid 10-digit Indian mobile number");
    else c.phone = phone;
    return false;
  }
}

class CheckCourseCode extends Handler<RowContext> {
  protected process(c: RowContext) {
    const code = (c.raw.coursecode ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,20}$/.test(code)) problem(c, "courseCode", "course code must be 2-20 letters, digits or dashes");
    else c.courseCode = code;
    return false;
  }
}

class CheckMarks extends Handler<RowContext> {
  protected process(c: RowContext) {
    const raw = (c.raw.marks ?? "").trim();
    const marks = raw === "" ? null : Number(raw);
    if (marks !== null && !(Number.isInteger(marks) && marks >= 0 && marks <= 100))
      problem(c, "marks", "marks must be a whole number 0-100");
    else c.marks = marks;
    return false;
  }
}

// The same person (phone) twice for the same course in ONE sheet.
class CheckDuplicateInSheet extends Handler<RowContext> {
  protected process(c: RowContext) {
    if (c.problems > 0 || !c.phone || !c.courseCode) return false; // already wrong; do not pile on
    const key = `${c.courseCode}|${c.phone}`;
    const first = c.seen.get(key);
    if (first !== undefined) problem(c, "phone", `duplicate of row ${first} (same phone and course code)`);
    else c.seen.set(key, c.row);
    return false;
  }
}

// The end of the chain: a row with no problems becomes a candidate.
class AcceptRow extends Handler<RowContext> {
  protected process(c: RowContext) {
    if (c.problems === 0)
      c.accepted.push({
        row: c.row,
        name: c.name as string,
        phone: c.phone as string,
        courseCode: c.courseCode as string,
        marks: c.marks ?? null,
      });
    return true;
  }
}

const rowChain = chainOf<RowContext>(
  new CheckName(),
  new CheckPhone(),
  new CheckCourseCode(),
  new CheckMarks(),
  new CheckDuplicateInSheet(),
  new AcceptRow(),
);

// "Course Code", "course_code", "courseCode" all become "coursecode".
const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

// Checks EVERY row and collects EVERY problem. The caller saves nothing unless `errors` is empty (all or nothing).
export async function parseCandidatesCsv(text: string): Promise<{ rows: ParsedCandidate[]; errors: RowError[] }> {
  let records: Record<string, string>[];
  try {
    records = parse(text, {
      columns: (headers: string[]) => headers.map(normaliseHeader),
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (e) {
    return { rows: [], errors: [{ row: 0, message: `could not read the file as CSV: ${(e as Error).message}` }] };
  }

  if (records.length === 0) return { rows: [], errors: [{ row: 0, message: "the file has no candidate rows" }] };
  if (records.length > MAX_ROWS)
    return { rows: [], errors: [{ row: 0, message: `too many rows (${records.length}); the limit is ${MAX_ROWS}` }] };

  const present = new Set(Object.keys(records[0] ?? {}));
  const missing = ["name", "phone", "coursecode"].filter((c) => !present.has(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `missing column(s): ${missing.join(", ")}. Expected: name, phone, courseCode, marks (optional)`,
        },
      ],
    };
  }

  const errors: RowError[] = [];
  const rows: ParsedCandidate[] = [];
  const seen = new Map<string, number>();
  for (const [i, raw] of records.entries()) {
    // +1 for the header, +1 because humans count from 1
    await rowChain.handle({ row: i + 2, raw, seen, errors, accepted: rows, problems: 0 });
  }
  return { rows, errors };
}
