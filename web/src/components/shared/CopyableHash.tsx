import { useState, useCallback } from 'react';

export function CopyableHash({ hash, explorer }: { hash: string; explorer?: string }) {
  const [copied, setCopied] = useState(false);
  const short = hash.slice(0, 10) + '...' + hash.slice(-6);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [hash]);

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-sm">
      <button onClick={copy} className="hover:text-indigo-400 cursor-pointer" title="Copy">
        {short}
      </button>
      {copied && <span className="text-xs text-green-400">Copied</span>}
      {explorer && (
        <a href={explorer} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 text-xs">
          View
        </a>
      )}
    </span>
  );
}
