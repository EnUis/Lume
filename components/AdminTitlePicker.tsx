'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { LoaderCircle, Search, X } from 'lucide-react';
import type { CatalogResponse, ContentType, Title } from '../lib/types';

interface Props {
  label: string;
  value: Title | null;
  onChange: (title: Title | null) => void;
  initialTitles?: Title[];
  excludeId?: string;
  contentType?: ContentType;
  disabled?: boolean;
}

function titleLabel(title: Title) {
  return `${title.name} · ${title.year || 'Year unknown'} · ${title.type === 'series' ? 'TV series' : title.type === 'live' ? 'Live channel' : 'Movie'}`;
}

export default function AdminTitlePicker({ label, value, onChange, initialTitles = [], excludeId, contentType, disabled }: Props) {
  const searchId = useId();
  const resultsId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(initialTitles.slice(0, 20));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const params = new URLSearchParams({ q: query, limit: '20' });
        if (contentType) params.set('type', contentType);
        const response = await fetch(`/api/admin/catalog?${params.toString()}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json() as CatalogResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Title search could not be loaded.');
        if (!controller.signal.aborted) setResults(data.titles);
      } catch (reason) {
        if (!controller.signal.aborted) { setResults([]); setError(reason instanceof Error ? reason.message : 'Title search could not be loaded.'); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, contentType]);

  const choices = useMemo(() => [...new Map([...(value ? [value] : []), ...results].filter(title => title.id !== excludeId && (!contentType || title.type === contentType)).map(title => [title.id, title])).values()], [value, results, excludeId, contentType]);
  return <div className="admin-title-picker">
    <label className="admin-title-picker-label" htmlFor={searchId}>{label}</label>
    <div className="admin-title-picker-search"><Search size={15} /><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search title names…" aria-label={`Search ${label.toLowerCase()}`} aria-controls={resultsId} disabled={disabled} />{loading && <LoaderCircle size={14} className="spin" aria-label="Searching titles" />}</div>
    <label className="admin-title-picker-results-label" htmlFor={resultsId}>Select a title</label>
    <select id={resultsId} aria-label={`${label} results`} value={value?.id || ''} required disabled={disabled || (!choices.length && loading)} onChange={event => onChange(choices.find(title => title.id === event.target.value) || null)}><option value="">{loading ? 'Searching the catalog…' : 'Choose a matching title'}</option>{choices.map(title => <option key={title.id} value={title.id}>{titleLabel(title)}</option>)}</select>
    {value && <div className="admin-title-picker-selection"><span>{titleLabel(value)}</span><button type="button" aria-label={`Clear ${label.toLowerCase()} selection`} disabled={disabled} onClick={() => onChange(null)}><X size={13} /></button></div>}
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    {!loading && !error && !choices.length && <p className="admin-help">No matching titles. Try another name.</p>}
    {loading && <span className="admin-sr-only" role="status">Searching titles</span>}
  </div>;
}
