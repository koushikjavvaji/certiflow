// An error that carries the HTTP status to answer with. Thrown from services,
// turned into a clean JSON response by the error handler in app.ts.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "not found") => new HttpError(404, what);
export const forbidden = (why = "forbidden") => new HttpError(403, why);
export const conflict = (why: string) => new HttpError(409, why);
