/**
 * Who may see a request.
 *
 * A conversation between a crew member and their AI is theirs: other crew members do not see what
 * was asked or answered unless its owner shares it. What everyone does see is what reached the
 * shared world — that a change was proposed, its summary, and its proposal — because the design
 * belongs to the whole crew.
 */
import type { RequestRecord } from "./types.js";

export const visibleTo = (r: RequestRecord, accountId: string): boolean => r.shared === true || r.user.id === accountId;

/** What another crew member sees of a private conversation. */
export function redacted(r: RequestRecord): Record<string, unknown> {
  return {
    id: r.id,
    private: true,
    text: "",
    ...(r.topic ? { topic: r.topic } : {}),
    user: r.user,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.proposalId ? { proposalId: r.proposalId, summary: r.requirement?.summary } : {}),
    ...(r.queuePosition !== undefined ? { queuePosition: r.queuePosition } : {}),
    similarPastWork: [],
    planIssues: [],
    traceLength: 0,
  };
}
