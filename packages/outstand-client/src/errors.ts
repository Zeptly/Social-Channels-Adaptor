import { UpstreamError, type UpstreamErrorKind, type UpstreamErrorOptions } from "@zeptly-gateway/gateway-contract";

export const OUTSTAND = "outstand";

/** Any failed Outstand call. Messages and details are redacted and bounded. */
export class OutstandError extends UpstreamError {
  constructor(kind: UpstreamErrorKind, message: string, opts: UpstreamErrorOptions) {
    super(OUTSTAND, kind, message, opts);
    this.name = "OutstandError";
  }
}
