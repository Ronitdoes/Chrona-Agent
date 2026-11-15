import { describe, expect, it } from "vitest";
import { requiresWebSearch } from "./search-policy";

describe("required search policy", () => {
  it.each(["give live score of ind vs nz", "What is the live cricket score?", "India New Zealand latest score", "current match score please", "Search the internet for cricket", "browse the web for sources"])("requires search for %s", (text) => {
    expect(requiresWebSearch(text)).toBe(true);
  });
  it.each(["Hello", "What is a live score?", "What's a live score?", "Explain how live scores work", "How does a live score update?", "Write a function to parse live scores", "Translate live score to Hindi", "Don't search: explain live scores", "Without browsing, give the latest score", "Don't use the internet for the live score", "No web search for live scores", "No need to search for live scores"])("leaves %s to normal model routing", (text) => {
    expect(requiresWebSearch(text)).toBe(false);
  });
});
