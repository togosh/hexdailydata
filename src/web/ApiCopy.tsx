import { useEffect, useRef, useState } from 'react';
export default function Copy({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [status, setStatus] = useState('');
  const attempt = useRef(0);
  useEffect(() => {
    attempt.current++;
    setStatus('');
    return () => {
      attempt.current++;
    };
  }, [value]);
  async function copy() {
    const current = ++attempt.current;
    setStatus('Copying…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(value);
      if (attempt.current === current) setStatus('Copied');
    } catch {
      if (attempt.current === current) setStatus('Select the text and copy manually.');
    }
  }
  return (
    <span className="api-copy">
      <button onClick={copy} disabled={status === 'Copying…'}>
        {label}
      </button>
      <span role="status">{status}</span>
    </span>
  );
}
