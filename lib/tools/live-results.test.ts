import { describe, expect, it } from "vitest";
import { liveScoreEvidence } from "./live-results";

const result = { title: "India New Zealand scorecard", url: "https://example.com/match", snippet: "Fixture 100/2, 15 November, updated 12:00 UTC." };

describe("live-score source selection", () => {
  it("keeps scorecards and live text commentary while excluding videos and promotions", () => {
    const sources = [result, { ...result, title: "Live text commentary", url: "https://example.com/commentary" }];
    expect(liveScoreEvidence([...sources,
      { ...result, url: "https://www.youtube.com/watch?v=fixture" },
      { ...result, title: "India New Zealand live streaming: how to watch" },
      { ...result, title: "IND vs NZ Dream11 prediction" },
      { ...result, title: "Live score watch-along" },
      { ...result, snippet: "", content: "" },
    ])).toEqual(sources);
  });
  it("keeps an unrelated site's domain lookalike unclassified rather than assuming it is a video platform", () => {
    expect(liveScoreEvidence([{ ...result, url: "https://youtube.com.example.org/report" }])).toHaveLength(1);
  });
});
