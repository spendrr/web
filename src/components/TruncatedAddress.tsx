// Middle-truncation (Dashboard's truncateMiddle) that renders the last few
// characters in a distinct color instead of a plain string — a quick visual
// anchor for manually double-checking an address/invoice tail against
// another copy of it (a QR code, another device's screen), same idea as
// hardware wallets highlighting the last few chars of an address for
// verification. Used only for the receive screen's own big address display,
// not CopyRow's smaller generic use elsewhere (send confirm, tx detail). The
// whole shown tail is highlighted: an unhighlighted character between the
// dots and the highlight reads as a stray.
export function TruncatedAddress({ value, head = 11, tail = 5 }: { value: string; head?: number; tail?: number }) {
  const truncated = value.length > head + tail + 1;
  const tailChunk = value.slice(-Math.min(tail, value.length));
  const headChunk = truncated ? value.slice(0, head) : value.slice(0, value.length - tailChunk.length);
  return (
    <>
      {headChunk}
      {/* Three plain periods, not the single "…" glyph — most monospace
          fonts (including Space Mono) draw that glyph as three dots crammed
          together with no gaps, which read as a single blob at this size. */}
      {truncated && <span className="address-ellipsis">...</span>}
      <span className="address-tail-highlight">{tailChunk}</span>
    </>
  );
}
