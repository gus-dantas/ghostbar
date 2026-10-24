// The ghost and the name, for onboarding: the app icon's colours, in the ghostavo.com style.
const GhostLogo = ({ width = 200, className = "" }: { width?: number; className?: string }) => (
  <div className={`flex items-center gap-3 ${className}`} style={{ width }}>
    <svg viewBox="0 0 64 64" width={Math.round(width * 0.22)} height={Math.round(width * 0.22)} aria-hidden="true">
      <path
        fill="#50C1B1"
        fillRule="evenodd"
        d="M14 54V26A18 18 0 0 1 50 26V54a6 4.8 0 0 1-12 0a6 4.8 0 0 1-12 0a6 4.8 0 0 1-12 0Z M26.5 22.4a3.4 4.6 0 1 0 0.01 0Z M37.5 22.4a3.4 4.6 0 1 0 0.01 0Z"
      />
      <circle cx="49" cy="14" r="5" fill="#EE8A50" />
    </svg>
    <span style={{ fontSize: Math.round(width * 0.11), fontWeight: 650, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>Gus Assistant</span>
  </div>
);

export default GhostLogo;
