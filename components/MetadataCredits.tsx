export default function MetadataCredits({ value }: { value: string }) {
  if (!value) return null;
  const pieces = value.split(/(https?:\/\/[^\s;]+)/g);
  return <details className="metadata-credits"><summary>Artwork &amp; description credits</summary><p>{pieces.map((piece, index) => {
    if (!/^https?:\/\//i.test(piece)) return <span key={index}>{piece}</span>;
    try {
      const link = new URL(piece);
      if (link.username || link.password || !['https:', 'http:'].includes(link.protocol)) return <span key={index}>Source</span>;
      return <a key={index} href={link.toString()} target="_blank" rel="noopener noreferrer">{link.hostname.replace(/^www\./, '')} ↗</a>;
    } catch { return <span key={index}>Source</span>; }
  })}</p></details>;
}
