// The GhostAvo mark in colour beside the app's name, for onboarding.
const EGG = "M0 -15C8 -15 12 -4.5 12 3C12 10.5 6.8 15 0 15C-6.8 15 -12 10.5 -12 3C-12 -4.5 -8 -15 0 -15Z";

const GhostLogo = ({ width = 200, className = "" }: { width?: number; className?: string }) => {
  const mark = Math.round(width * 0.22);
  return (
    <div className={`flex items-center gap-3 ${className}`} style={{ width }}>
      <svg viewBox="0 0 100 100" width={mark} height={mark} aria-hidden="true">
        <path d="M100 100V0A100 100 0 0 0 0 100Z" fill="#2A8A7C" />
        <path d="M100 100V9A91 91 0 0 0 9 100Z" fill="#50C1B1" />
        <g transform="translate(64 58) rotate(-14)">
          <path d={EGG} fill="#EE8A50" />
          <circle cy="4" r="5.4" fill="#123F3A" />
          <circle cx="-1.7" cy="2.2" r="1.6" fill="#F2F5F4" />
        </g>
      </svg>
      <span style={{ fontSize: Math.round(width * 0.11), fontWeight: 650, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>Ghostbar</span>
    </div>
  );
};

export default GhostLogo;
