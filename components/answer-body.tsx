import type { RichAnswerV1 } from "../lib/answer-blocks";
import { MarkdownMessage } from "./markdown-message";
import { ImageGallery } from "./image-gallery";

export function AnswerBody({ content, answerUi }: { content: string; answerUi?: RichAnswerV1 }) {
  const start = Math.min(answerUi?.externalStart ?? 0, content.length);
  return <>
    {start > 0 ? <MarkdownMessage content={content.slice(0, start)} /> : null}
    {answerUi ? <ImageGallery answer={answerUi} /> : null}
    <MarkdownMessage content={content.slice(start)} answerUi={answerUi} />
  </>;
}
