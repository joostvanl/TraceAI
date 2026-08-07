import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ content }: { content: string }) {
  if (!content?.trim()) {
    return <p className="muted">No content.</p>;
  }

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
