import { useState } from 'react';

export function PairForm({ disabled, pair }: { readonly disabled: boolean; readonly pair: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  return <form className="pair-form" onSubmit={event => { event.preventDefault(); void pair(code); setCode(''); }}>
    <label htmlFor="pairing-code">Pairing code</label><input id="pairing-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" placeholder="Code from the local host" />
    <button disabled={disabled || !code.trim()}>Pair host</button>
  </form>;
}
