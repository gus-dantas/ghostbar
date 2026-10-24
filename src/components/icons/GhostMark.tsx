// Gus Assistant's ghost, as a small icon that takes the current colour.
const GhostMark = ({ width, height, size = 24, className = "" }: { width?: number | string; height?: number | string; size?: number | string; className?: string }) => (
  <svg width={width ?? size} height={height ?? size} viewBox="0 0 64 64" className={className} aria-hidden="true">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M14 54V26A18 18 0 0 1 50 26V54a6 4.8 0 0 1-12 0a6 4.8 0 0 1-12 0a6 4.8 0 0 1-12 0Z M26.5 22.4a3.4 4.6 0 1 0 0.01 0Z M37.5 22.4a3.4 4.6 0 1 0 0.01 0Z"
    />
  </svg>
);

export default GhostMark;
