/**
 * Markdown Renderer Component
 * Uses react-markdown with GitHub Flavored Markdown support
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { UI_CONFIG } from '../../config';

interface MarkdownProps {
  content: string;
  className?: string;
}

/**
 * Code block with language label and copy button
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI_CONFIG.COPY_FEEDBACK_DELAY);
  };

  return (
    <div className="my-2 rounded-md bg-[#1e1e1e] border border-white/[0.06] overflow-hidden group/code">
      {/* Header with language and copy button */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04]">
        <span className="text-[10px] text-white/30 uppercase tracking-wider font-medium">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors"
        >
          {copied ? (
            <>
              <Check size={10} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={10} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Code content */}
      <pre className="px-3 py-2.5 overflow-x-auto">
        <code className="text-[12px] text-emerald-400/90 font-mono leading-relaxed">
          {code}
        </code>
      </pre>
    </div>
  );
}

export function Markdown({ content, className = '' }: MarkdownProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        // Headings
        h1: ({ children }) => (
          <h1 className="text-lg font-bold text-white/95 mb-2 mt-4 first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-base font-bold text-white/95 mb-2 mt-3">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold text-white/90 mb-1.5 mt-2">{children}</h3>
        ),
        
        // Paragraphs
        p: ({ children }) => (
          <p className="text-[13px] text-white/85 leading-relaxed mb-2 last:mb-0">{children}</p>
        ),
        
        // Lists
        ul: ({ children }) => (
          <ul className="text-[13px] text-white/85 list-disc list-inside mb-2 space-y-1">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="text-[13px] text-white/85 list-decimal list-inside mb-2 space-y-1">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-white/85">{children}</li>
        ),
        
        // Code
        code: ({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const isBlock = match || (typeof children === 'string' && children.includes('\n'));
          
          if (isBlock) {
            return (
              <CodeBlock 
                code={String(children).replace(/\n$/, '')} 
                language={match ? match[1] : 'text'} 
              />
            );
          }
          
          // Inline code
          return (
            <code className="px-1 py-0.5 rounded bg-white/[0.08] text-[12px] font-mono text-violet-300" {...props}>
              {children}
            </code>
          );
        },
        
        // Pre - handled by code block
        pre: ({ children }) => <>{children}</>,
        
        // Links
        a: ({ href, children }) => (
          <a 
            href={href} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-violet-400 hover:text-violet-300 underline underline-offset-2"
          >
            {children}
          </a>
        ),
        
        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-violet-500/50 pl-3 my-2 text-white/70 italic">
            {children}
          </blockquote>
        ),
        
        // Horizontal rule
        hr: () => <hr className="border-white/10 my-4" />,
        
        // Strong and emphasis
        strong: ({ children }) => (
          <strong className="font-semibold text-white/95">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic text-white/80">{children}</em>
        ),
        
        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full text-[12px] border border-white/10 rounded">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-white/[0.04]">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="px-3 py-1.5 text-left text-white/70 font-medium border-b border-white/10">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-1.5 text-white/80 border-b border-white/[0.05]">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}
