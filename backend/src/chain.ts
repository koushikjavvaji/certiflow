// CHAIN OF RESPONSIBILITY: the one idea this whole backend is organised around.
//
// A request travels along a line of small handlers. Each handler does ONE job, and then:
//   - returns false  -> "carry on": it only checked something or did its part
//   - returns true   -> "I dealt with this": the chain stops here (a handler that finishes the work)
//   - throws         -> "refused": the whole request is rejected and nothing further runs
//
// The request data lives in a context object `C` that is passed down the line, so a
// handler keeps no state of its own and one chain is built once and reused for every request.
//
// Where it is used:  workflow/ (approval steps + decisions) · issuance.ts (making a
// certificate) · routes/auth.ts (login) · routes/batches.ts + csv.ts (spreadsheet upload and
// its row checks) · routes/certificates.ts (verify and download).
export abstract class Handler<C> {
  private successor: Handler<C> | null = null;

  setNext(next: Handler<C>): Handler<C> {
    this.successor = next;
    return next;
  }

  async handle(ctx: C): Promise<void> {
    const handled = await this.process(ctx);
    if (!handled && this.successor) await this.successor.handle(ctx);
  }

  protected abstract process(ctx: C): Promise<boolean> | boolean;
}

// Links the handlers in the order given and returns the FIRST one (the entry of the chain).
export function chainOf<C>(first: Handler<C>, ...rest: Handler<C>[]): Handler<C> {
  rest.reduce<Handler<C>>((previous, next) => previous.setNext(next), first);
  return first;
}

// ============ Refusing a request ============
// A handler REFUSES a request by throwing one of these. The error handler in app.ts turns it into a
// clean JSON answer with the right HTTP status, so handlers never touch the response themselves.
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
