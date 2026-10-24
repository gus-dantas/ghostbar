// The GhostAvo mark in one colour: a quarter of a cut avocado whose stone is an eye
// (design/mark/make_mark.py). It takes the current text colour.
const EGG = "M0 -15C8 -15 12 -4.5 12 3C12 10.5 6.8 15 0 15C-6.8 15 -12 10.5 -12 3C-12 -4.5 -8 -15 0 -15Z";

const GhostMark = ({ width, height, size = 24, className = "" }: { width?: number | string; height?: number | string; size?: number | string; className?: string }) => (
  <svg width={width ?? size} height={height ?? size} viewBox="0 0 100 100" className={className} aria-hidden="true">
    <defs>
      <mask id="ghostmark-cut">
        <rect width="100" height="100" fill="#fff" />
        <g transform="translate(62 58) rotate(-14) scale(1.45)"><path d={EGG} fill="#000" /></g>
      </mask>
    </defs>
    <path d="M100 100V0A100 100 0 0 0 0 100Z" fill="currentColor" mask="url(#ghostmark-cut)" />
    <g transform="translate(62 58) rotate(-14) scale(1.45)"><circle cy="4" r="5.6" fill="currentColor" /></g>
  </svg>
);

export default GhostMark;
