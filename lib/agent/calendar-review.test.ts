import { describe, expect, it } from "vitest";
import { clock } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";
import { reviewSportsCalendar } from "./calendar-review";

const question = "ind vs nz match today";
describe("sports calendar answer review", () => {
  it("catches the exact contradiction in the screenshot", () => {
    const answer = "**Today's Match:** There is no India vs New Zealand match being played today, Sunday, November 15, 2026.\n**Latest Completed Match:** The 5th ODI took place earlier today (Sunday, November 15, 2026).";
    expect(reviewSportsCalendar(answer, question, clock)).toContain("completed match today");
  });
  it.each([
    "No India vs New Zealand match is live right now. The match finished earlier today, 15 November 2026.",
    "Today's India vs New Zealand match finished earlier today. The next fixture is on 18 November 2026.",
    "No further India vs New Zealand matches today. Today's match finished earlier today.",
    "There is no India vs New Zealand match today. Their previous game finished yesterday.",
    "The source's venue date is 16 November 2026 in New Zealand; today, Sunday, 15 November 2026, is the user's date in UTC.",
  ])("accepts consistent match status and explicit dates: %s", answer => {
    expect(reviewSportsCalendar(answer, question, clock)).toBeNull();
  });
  it.each(["Today, Monday, 15 November 2026", "Today, November 14, 2026", "Today (2026-11-16)", "Today is Monday, 15 November 2026"])("rejects an incorrect date or weekday in %s", answer => {
    expect(reviewSportsCalendar(answer, question, clock)).toContain("Today is Sunday, 15 November 2026");
  });
  it("checks the user's day instead of the UTC day near midnight", () => {
    const india = { ...clock, instant: dateFrom("2026-11-15T19:00:00Z"), tz: "Asia/Calcutta" };
    expect(reviewSportsCalendar("Today, 15 November 2026", question, india)).toContain("16 November 2026");
    expect(reviewSportsCalendar("Today, Monday, 16 November 2026", question, india)).toBeNull();
  });
});
