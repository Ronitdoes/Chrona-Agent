import { describe, expect, it } from "vitest";
import { isLiveScoreRequest, requiresWebSearch } from "./search-policy";

describe("required search policy", () => {
  it.each(["ind vs nz match today", "India NZ fixture today", "ind vs nz score today", "IND NZ scorecard now", "score of India New Zealand right now", "give live score of ind vs nz", "What is the live cricket score?", "India New Zealand latest score", "current match score please", "Search the internet for cricket", "browse the web for sources"])("requires search for %s", (text) => {
    expect(requiresWebSearch(text)).toBe(true);
  });
  it.each(["Hello", "What is a live score?", "What's a live score?", "Explain how live scores work", "How does a live score update?", "Write a function to parse live scores", "Translate live score to Hindi", "Don't search: explain live scores", "Without browsing, give the latest score", "Don't use the internet for the live score", "No web search for live scores", "No need to search for live scores"])("leaves %s to normal model routing", (text) => {
    expect(requiresWebSearch(text)).toBe(false);
  });
  it.each(["ind vs nz score today", "today's cricket score", "football live score", "IND NZ scorecard now"])("marks %s for fresh page retrieval", text => {
    expect(isLiveScoreRequest(text)).toBe(true);
  });
  it.each(["What was India's score in the 2011 final?", "Define a live score", "Don't search for today's score", "Today's exam scores", "live music tonight"])("keeps %s out of live sports retrieval", text => {
    expect(isLiveScoreRequest(text)).toBe(false);
  });
});
