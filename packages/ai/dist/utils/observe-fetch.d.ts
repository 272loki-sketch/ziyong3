import type { TransportObservation } from "../types.ts";
/** Wrap only this client's fetch, without buffering, teeing, or issuing another request. */
export declare function observeFetch(notify: (event: TransportObservation) => void): {
    fetch: typeof fetch;
    effective: () => void;
};
//# sourceMappingURL=observe-fetch.d.ts.map