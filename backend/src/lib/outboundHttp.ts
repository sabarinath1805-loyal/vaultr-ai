// The MCP/client module owns the repository's established guarded egress
// implementation. Model providers, catalogs, MCP, and legal-source clients
// share this public kernel surface instead of building independent guards.
import {
    guardedFetch,
    validateRemoteMcpUrl,
    type OutboundFetchPolicy,
} from "./mcp/client";

export type { OutboundFetchPolicy };
export const validateOutboundUrl = validateRemoteMcpUrl;

/** Provider/model requests refuse redirects by default. MCP keeps its
 * separately revalidated discovery redirect behavior through guardedFetch. */
export function guardedOutboundFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    policy: OutboundFetchPolicy = {},
): Promise<Response> {
    return guardedFetch(input, init, {
        ...policy,
        followRedirects: policy.followRedirects ?? false,
    });
}
