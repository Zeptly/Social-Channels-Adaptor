import { defineErrorCodes } from "@zeptly-gateway/gateway-contract";

/** Error codes introduced by Social Publishing Contract v1 (in addition to the gateway codes). */
declare module "@zeptly-gateway/gateway-contract" {
  interface ErrorCodeRegistry {
    POST_NOT_FOUND: true;
    MEDIA_NOT_FOUND: true;
    MEDIA_INVALID: true;
    TARGET_INVALID: true;
    TARGET_DROPPED_BY_PROVIDER: true;
    PUBLICATION_FAILED: true;
    PUBLICATION_STATE_UNKNOWN: true;
  }
}

defineErrorCodes({
  POST_NOT_FOUND: { status: 404 },
  MEDIA_NOT_FOUND: { status: 404 },
  MEDIA_INVALID: { status: 422 },
  TARGET_INVALID: { status: 422 },
  TARGET_DROPPED_BY_PROVIDER: { status: 502, description: "Target-level: the provider did not accept this destination" },
  PUBLICATION_FAILED: { status: 502, description: "Target-level: publishing failed on the network" },
  PUBLICATION_STATE_UNKNOWN: { status: 502, description: "Target-level: outcome could not be confirmed; manual review" },
});
