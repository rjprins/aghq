import { describe, expect, it } from "vitest";

import {
  recordPrCommentsDelivered,
  selectUndeliveredPrComments,
} from "../src/server/azure-pr-poller.js";
import type { PrComment } from "../src/server/azure-pr.js";

function comment(commentId: number, at: number): PrComment {
  return {
    commentId,
    threadId: commentId * 10,
    author: "reviewer@example.com",
    text: `Comment ${commentId}`,
    file: "/src/app.ts",
    line: commentId,
    at,
  };
}

describe("PR review comment delivery", () => {
  it("does not repeat an earlier unresolved comment when a newer comment arrives", () => {
    const earlier = comment(1, 100);
    const newer = comment(2, 200);
    const delivered = { latestAt: 100, commentIds: [earlier.commentId] };

    expect(selectUndeliveredPrComments([earlier, newer], delivered)).toEqual([newer]);
  });

  it("uses comment ids when a new comment shares the previous timestamp", () => {
    const earlier = comment(1, 100);
    const sameTimestamp = comment(2, 100);
    const delivered = { latestAt: 100, commentIds: [earlier.commentId] };

    expect(selectUndeliveredPrComments([earlier, sameTimestamp], delivered)).toEqual([sameTimestamp]);
  });

  it("honors the legacy timestamp preference without repeating earlier comments", () => {
    const earlier = comment(1, 100);
    const newer = comment(2, 200);

    expect(selectUndeliveredPrComments([earlier, newer], 100)).toEqual([newer]);
  });

  it("records delivered ids so later polls only return comments not seen before", () => {
    const first = comment(1, 100);
    const second = comment(2, 200);
    const third = comment(3, 300);
    const delivered = recordPrCommentsDelivered(undefined, [first, second], 200);

    expect(delivered).toEqual({ latestAt: 200, commentIds: [1, 2] });
    expect(selectUndeliveredPrComments([first, second, third], delivered)).toEqual([third]);
  });
});
