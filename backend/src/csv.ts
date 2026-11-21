import { parse } from "csv-parse/sync";
import { z } from "zod";

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

const rowSchema = z.object({
  name: z.string().trim().min(2, "name must be at least 2 characters").max(100, "name is too long"),
  phone: z.string().trim().min(1, "phone is required"),
  coursecode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,20}$/, "course code must be 2-20 letters, digits or dashes"),
  marks: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === "" ? null : Number(v)))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 100), "marks must be a whole number 0-100"),
});

// "Course Code", "course_code", "courseCode" all become "coursecode".
const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

// Checks EVERY row and collects EVERY problem, so the centre can fix the whole sheet in
// one go. The caller saves nothing unless `errors` is empty (all or nothing).
export function parseCandidatesCsv(text: string): { rows: ParsedCandidate[]; errors: RowError[] } {
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
  if (records.length > MAX_ROWS) {
    return { rows: [], errors: [{ row: 0, message: `too many rows (${records.length}); the limit is ${MAX_ROWS}` }] };
  }

  const present = new Set(Object.keys(records[0] ?? {}));
  const missing = ["name", "phone", "coursecode"].filter((c) => !present.has(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ row: 0, message: `missing column(s): ${missing.join(", ")}. Expected: name, phone, courseCode, marks (optional)` }] };
  }

  const rows: ParsedCandidate[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>(); // courseCode|phone -> first row it appeared on

  records.forEach((record, i) => {
    const row = i + 2; // +1 for the header, +1 because humans count from 1
    const parsed = rowSchema.safeParse(record);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        errors.push({ row, field: field === "coursecode" ? "courseCode" : field, message: issue.message });
      }
      return;
    }
    const phone = normalisePhone(parsed.data.phone);
    if (!phone) {
      errors.push({ row, field: "phone", message: "phone must be a valid 10-digit Indian mobile number" });
      return;
    }
    const key = `${parsed.data.coursecode}|${phone}`;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ row, field: "phone", message: `duplicate of row ${first} (same phone and course code)` });
      return;
    }
    seen.set(key, row);
    rows.push({ row, name: parsed.data.name, phone, courseCode: parsed.data.coursecode, marks: parsed.data.marks });
  });

  return { rows, errors };
}
